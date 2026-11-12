import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository, type Run } from '../../src/persistence/run-repository.js';
import { createRunStepRepository } from '../../src/persistence/run-step-repository.js';
import { createAtomicRunFinalizer } from '../../src/persistence/atomic-run-finalizer.js';
import { z } from 'zod';
import { createInMemoryToolExecutor } from '../../src/tools/in-memory-tool-executor.js';
import { createToolRegistry } from '../../src/tools/tool-registry.js';
import { createRunToolStepRecorder } from '../../src/persistence/run-tool-step-recorder.js';
import { runBoundedToolDecisions } from '../../src/runtime/run-bounded-tool-decisions.js';
import { createRunContinueRecorder } from '../../src/persistence/run-continue-recorder.js';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';
import { migrate } from '../../../../db/migrate.js';

import { createRunToolResultRepository } from '../../src/persistence/run-tool-result-repository.js';
import { createToolResultPolicy } from '../../src/tools/tool-result-policy.js';

interface Fixture {
  schema: string;
  pool: Pool;
  client: PoolClient;
  db: { connect(): Promise<PoolClient> };
}
async function withSchema(work: (fixture: Fixture) => Promise<void>) {
  const pool = createDatabase(readDatabaseUrl('test'));
  const schema = `axiom_test_${randomUUID().replaceAll('-', '')}`;
  let client: PoolClient | undefined;
  let created = false;
  try {
    client = await pool.connect();
    await assertDatabaseIdentity(client, 'test');
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("SET statement_timeout TO '5s'");
    await migrate('test', 'up', schema);
    const db = { async connect() {
      const connection = await pool.connect();
      try {
        await assertDatabaseIdentity(connection, 'test');
        await connection.query(`SET search_path TO "${schema}"`);
        await connection.query("SET statement_timeout TO '5s'");
        return connection;
      } catch (error) { connection.release(true); throw error; }
    } };
    await work({ schema, pool, client, db });
  } finally {
    try { if (created) await client!.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { client?.release(); await pool.end(); }
  }
}
// A leased client remains exclusive until all concurrent work settles. Its owner
// releases it in finally, including the discard requested by a failed finalizer.
function lease(client: PoolClient) {
  let discard = false;
  return {
    db: { connect: async () => ({ query: client.query.bind(client), release: (error?: Error | boolean) => { discard ||= Boolean(error); } }) },
    release: () => client.release(discard),
  };
}
async function checkGet(client: PoolClient, created: Run, status: string) {
  const app = buildApp({ repository: createRunRepository(client), logger: false });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/runs/${created.id}`, { signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...created, status, createdAt: created.createdAt.toISOString() });
  } finally { await app.close(); }
}

const policy = createToolResultPolicy([{name:'summary',retentionSeconds:60,project:()=>({schemaVersion:1,status:'ok',itemCount:3})}]);
const raw = {kind:'tool_succeeded',output:{secret:'OUTPUT_SECRET',arguments:'ARG_SECRET',task:'TASK_SECRET',credential:'CREDENTIAL_SECRET',model:'MODEL_SECRET'}};
async function running(client:PoolClient) {const repo=createRunRepository(client);const r=await repo.createRun('TASK_SECRET');await repo.tryStartRun(r.id);return r;}
const store=(db:Fixture['db'])=>createRunToolResultRepository(db,policy);
async function append(db:Fixture['db'],id:string) {
  const saved=await store(db).appendToolSucceededStepWithSafeResultIfRunning(id,'summary',raw);
  if(!saved || 'kind' in saved)throw new Error('Expected saved result');return saved;
}
async function snapshot(client:PoolClient) {
  return {runs:(await client.query('SELECT * FROM runs ORDER BY id')).rows,
    steps:(await client.query('SELECT * FROM run_steps ORDER BY run_id,step_no')).rows,
    results:(await client.query('SELECT * FROM run_tool_results ORDER BY run_id,step_no')).rows,
    history:(await client.query('SELECT * FROM pgmigrations ORDER BY id')).rows,
    constraints:(await client.query("SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace=current_schema()::regnamespace ORDER BY conname")).rows};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {resolve,promise};}
async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Test barrier timeout')),3000);})]);}finally{clearTimeout(timer);}}
async function waitLock(client:PoolClient,pid:number){await vi.waitFor(async()=>expect((await client.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rowCount).toBe(1),{timeout:3000});}

describe('real PostgreSQL privacy gated tool results',()=>{
  it('migrates seven up/up/down/up, preserving all existing Run and Step data',async()=>withSchema(async({schema,client,db})=>{
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(7);
    const r=await running(client);await createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(r.id);
    const before=await snapshot(client);expect(await migrate('test','up',schema)).toHaveLength(0);
    expect(await migrate('test','down',schema)).toHaveLength(1);
    expect((await client.query("SELECT to_regclass('run_tool_results') AS name")).rows[0].name).toBeNull();
    expect((await client.query('SELECT * FROM runs ORDER BY id')).rows).toEqual(before.runs);
    expect((await client.query('SELECT * FROM run_steps ORDER BY run_id,step_no')).rows).toEqual(before.steps);
    expect((await client.query('SELECT * FROM pgmigrations ORDER BY id')).rows).toEqual(before.history.slice(0,6));
    expect(await migrate('test','up',schema)).toHaveLength(1);
    const after=await snapshot(client);expect(after.runs).toEqual(before.runs);expect(after.steps).toEqual(before.steps);expect(after.constraints).toEqual(before.constraints);
    expect(after.history.slice(0,6)).toEqual(before.history.slice(0,6));
  }));
  it('atomically saves only strict scalars, reads a frozen copy by exact key, and preserves HTTP fields',async()=>withSchema(async({client,db,pool})=>{
    const r=await running(client);const first=await append(db,r.id.toUpperCase());const second=await append(db,r.id);
    expect([first.step.stepNo,second.step.stepNo]).toEqual([1,2]);expect(first.result.safeResult).toEqual({schemaVersion:1,status:'ok',itemCount:3});
    const read=await store(db).getSavedToolResult(r.id.toUpperCase(),1);expect(read).toEqual(first.result);expect(read).not.toBe(first.result);expect(Object.isFrozen(read)).toBe(true);expect(Object.isFrozen(read!.safeResult)).toBe(true);
    expect(await store(db).getSavedToolResult(randomUUID(),1)).toBeNull();expect(await store(db).getSavedToolResult(r.id,3)).toBeNull();
    expect(JSON.stringify((await client.query('SELECT * FROM run_tool_results')).rows)).not.toMatch(/SECRET|arguments|output|task|credential|model/i);
    expect((await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='run_tool_results' ORDER BY ordinal_position")).rows.map(r=>r.column_name)).toEqual(['run_id','step_no','result_kind','schema_version','status','item_count','created_at','expires_at']);
    expect(new Date(first.result.expiresAt).getTime()-new Date(first.result.createdAt).getTime()).toBe(60000);
    await checkGet(client,r,'running');expect(pool.totalCount-pool.idleCount).toBe(1);
  }));
  it('no policy, unknown tool and raw approval flags cause no writes or projector bypass',async()=>withSchema(async({client,db})=>{
    const r=await running(client);const before=await snapshot(client);
    expect(await createRunToolResultRepository(db).appendToolSucceededStepWithSafeResultIfRunning(r.id,'summary',{...raw,approved:true})).toEqual({kind:'no_store'});
    expect(await store(db).appendToolSucceededStepWithSafeResultIfRunning(r.id,'missing',raw)).toEqual({kind:'no_store'});
    for(const key of ['approved','persist','save','persistable'])expect(await store(db).appendToolSucceededStepWithSafeResultIfRunning(r.id,'summary',{...raw,[key]:true})).toEqual({kind:'no_store'});
    expect(await snapshot(client)).toEqual(before);
  }));
  it.each(['missing','queued','completed','failed'])('writes neither record for %s',async state=>withSchema(async({client,db})=>{
    const repo=createRunRepository(client);const r=await repo.createRun('state');if(state==='completed'||state==='failed'){await repo.tryStartRun(r.id);await repo.tryFinishRun(r.id,state);}
    const before=await snapshot(client);expect(await store(db).appendToolSucceededStepWithSafeResultIfRunning(state==='missing'?randomUUID():r.id,'summary',raw)).toBeNull();expect(await snapshot(client)).toEqual(before);
  }));
  it.each(['invalid-uuid','invalid-step','wrong-result-kind','missing-run','missing-step','wrong-kind','cross-run','duplicate','version','status','count-low','count-high','huge-status','ttl-zero','ttl-negative','ttl-large','infinite','future-created'])('DB constraint rejects %s',async mode=>withSchema(async({client,db})=>{
    const a=await running(client);const b=await running(client);const saved=await append(db,a.id);
    await createRunContinueRecorder(db).appendContinuedStepIfRunning(b.id);
    const params:unknown[]=[a.id,2,'tool_succeeded',1,'ok',3];let created='statement_timestamp()';let expiry="statement_timestamp()+INTERVAL '1 hour'";
    await createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(a.id);
    if(mode==='invalid-uuid')params[0]='INVALID_ID';if(mode==='invalid-step')params[1]=0;if(mode==='wrong-result-kind')params[2]='continued';
    if(mode==='missing-run')params[0]=randomUUID();if(mode==='missing-step')params[1]=99;
    if(mode==='cross-run'){params[0]=b.id;params[1]=2;}
    if(mode==='wrong-kind'){params[0]=b.id;params[1]=1;}
    if(mode==='duplicate')params[1]=saved.step.stepNo;
    if(mode==='version')params[3]=2;if(mode==='status')params[4]='OUTPUT_SECRET';if(mode==='count-low')params[5]=-1;if(mode==='count-high')params[5]=1001;
    if(mode==='huge-status')params[4]='CREDENTIAL_SECRET'.repeat(1000);
    if(mode==='ttl-zero')expiry='statement_timestamp()';if(mode==='ttl-negative')expiry="statement_timestamp()-INTERVAL '1 second'";
    if(mode==='ttl-large')expiry="statement_timestamp()+INTERVAL '24 hours 1 second'";if(mode==='infinite')expiry="'infinity'::timestamptz";
    if(mode==='future-created'){created="statement_timestamp()+INTERVAL '1 hour'";expiry="statement_timestamp()+INTERVAL '2 hours'";}
    const before=await snapshot(client);
    const statement=`INSERT INTO run_tool_results(run_id,step_no,result_kind,schema_version,status,item_count,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,${created},${expiry})`;
    await expect(client.query(statement,params)).rejects.toMatchObject({code:mode==='invalid-uuid'?'22P02':['missing-run','missing-step','cross-run','wrong-kind'].includes(mode)?'23503':mode==='duplicate'?'23505':'23514'});
    expect(await snapshot(client)).toEqual(before);
  }));
  it('fixed columns cannot store free JSON, new fields or move a result to a different kind',async()=>withSchema(async({client,db})=>{
    const r=await running(client);const saved=await append(db,r.id);const before=await snapshot(client);
    await expect(client.query("INSERT INTO run_tool_results(run_id,step_no,raw_output) VALUES($1,2,'OUTPUT_SECRET')",[r.id])).rejects.toMatchObject({code:'42703'});
    await expect(client.query("UPDATE run_steps SET result_kind='continued' WHERE run_id=$1 AND step_no=$2",[r.id,saved.step.stepNo])).rejects.toMatchObject({code:'23503'});
    expect(await snapshot(client)).toEqual(before);
  }));
  it.each(['step','result','commit'])('rolls back both inserts on %s failure and releases once',async stage=>withSchema(async({client,db,pool})=>{
    const r=await running(client);await client.query("CREATE FUNCTION reject_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$");
    await client.query(stage==='commit'?'CREATE CONSTRAINT TRIGGER reject_save AFTER INSERT ON run_tool_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_save()':`CREATE TRIGGER reject_save AFTER INSERT ON ${stage==='step'?'run_steps':'run_tool_results'} FOR EACH ROW EXECUTE FUNCTION reject_save()`);
    const before=await snapshot(client);let releases=0;let discard=false;
    const wrapped={connect:async()=>{const c=await db.connect();return {query:c.query.bind(c),release:(e?:boolean|Error)=>{releases++;discard=Boolean(e);c.release(e);}};}};
    await expect(store(wrapped as Fixture['db']).appendToolSucceededStepWithSafeResultIfRunning(r.id,'summary',raw)).rejects.toMatchObject({code:'P0001'});
    expect(await snapshot(client)).toEqual(before);expect(releases).toBe(1);expect(discard).toBe(stage==='commit');expect(pool.totalCount-pool.idleCount).toBe(1);
    console.info(JSON.stringify({safeResultFailure:stage,steps:0,results:0,releases,discard}));
  }));
  it('lost COMMIT acknowledgement leaves both records once and discards without retry',async()=>withSchema(async({client,db,pool})=>{
    const r=await running(client);let commits=0;let releases=0;let discard=false;const error=new Error('ack lost');
    const wrapped={connect:async()=>{const c=await db.connect();return {query:(async(sql:string,values?:unknown[])=>{const result=await c.query(sql,values);if(sql==='COMMIT'){commits++;throw error;}return result;}) as PoolClient['query'],release:(e?:boolean|Error)=>{releases++;discard=Boolean(e);c.release(e);}};}};
    await expect(store(wrapped as Fixture['db']).appendToolSucceededStepWithSafeResultIfRunning(r.id,'summary',raw)).rejects.toBe(error);
    const after=await snapshot(client);expect(after.steps).toHaveLength(1);expect(after.results).toHaveLength(1);expect(commits).toBe(1);expect(releases).toBe(1);expect(discard).toBe(true);expect(pool.totalCount-pool.idleCount).toBe(1);
    console.info('Safe result COMMIT acknowledgement loss: Step 1 + Result 1, discard, no retry');
  }));
  it('rollback failure discards the connection and releases the lock without partial rows',async()=>withSchema(async({client,db})=>{
    const r=await running(client);let pid=0;let discarded=false;
    await client.query("CREATE FUNCTION reject_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$");
    await client.query('CREATE TRIGGER reject_save AFTER INSERT ON run_tool_results FOR EACH ROW EXECUTE FUNCTION reject_save()');
    const wrapped={connect:async()=>{const c=await db.connect();pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return {query:(async(sql:string,values?:unknown[])=>{if(sql==='ROLLBACK')throw new Error('rollback');return c.query(sql,values);}) as PoolClient['query'],release:(e?:boolean|Error)=>{discarded=Boolean(e);c.release(e);}};}};
    await expect(store(wrapped as Fixture['db']).appendToolSucceededStepWithSafeResultIfRunning(r.id,'summary',raw)).rejects.toMatchObject({code:'P0001'});
    expect(discarded).toBe(true);await client.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[r.id]);expect((await client.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[pid])).rowCount).toBe(0);
    expect((await snapshot(client)).steps).toEqual([]);expect((await snapshot(client)).results).toEqual([]);
  }));
  it('waits for COMMIT acknowledgement before returning either record',async()=>withSchema(async({client,db})=>{
    const r=await running(client);const entered=deferred();const release=deferred();let resolved=false;
    const wrapped={connect:async()=>{const c=await db.connect();return {query:(async(sql:string,values?:unknown[])=>{if(sql==='COMMIT'){entered.resolve();await release.promise;}return c.query(sql,values);}) as PoolClient['query'],release:c.release.bind(c)};}};
    const pending=append(wrapped as Fixture['db'],r.id).then(value=>{resolved=true;return value;});
    try {await bounded(entered.promise);expect(resolved).toBe(false);const before=await snapshot(client);expect(before.steps).toEqual([]);expect(before.results).toEqual([]);release.resolve();await bounded(pending);}
    finally{release.resolve();await Promise.allSettled([pending]);}
    expect((await snapshot(client)).results).toHaveLength(1);
  }));
  it('two distinct backend PIDs serialize same-Run appends with correct Step binding',async()=>withSchema(async({client,db})=>{
    const r=await running(client);const clients:PoolClient[]=[];const leases:ReturnType<typeof lease>[]=[];
    try {
      for(let i=0;i<2;i++){const c=await db.connect();clients.push(c);leases.push(lease(c));}
      const pids=await Promise.all(clients.map(async c=>(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));expect(pids[0]).not.toBe(pids[1]);
      const results=await Promise.allSettled(leases.map(l=>append(l.db as Fixture['db'],r.id)));expect(results.every(r=>r.status==='fulfilled')).toBe(true);
      const rows=await snapshot(client);expect(rows.steps.map(s=>s.step_no)).toEqual([1,2]);expect(rows.results.map(s=>[s.run_id,s.step_no])).toEqual([[r.id,1],[r.id,2]]);
      console.info(JSON.stringify({safeResultAppendPids:pids,stepNumbers:rows.steps.map(s=>s.step_no),resultCount:rows.results.length}));
    }finally{leases.forEach(l=>l.release());}
  }));
  it.each(['save','finish'])('%s first parent lock preserves atomic results and terminal history',async first=>withSchema(async({client,db})=>{
    const r=await running(client);const clients:PoolClient[]=[];const leases:ReturnType<typeof lease>[]=[];const pending:Promise<unknown>[]=[];const entered=deferred();const release=deferred();
    try {
      for(let i=0;i<2;i++){const c=await db.connect();clients.push(c);leases.push(lease(c));}
      const pids=await Promise.all(clients.map(async c=>(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));expect(pids[0]).not.toBe(pids[1]);
      const gated={connect:async()=>{const c=await leases[0]!.db.connect();return {...c,query:(async(sql:string,values?:unknown[])=>{if(sql==='COMMIT'){entered.resolve();await release.promise;}return clients[0]!.query(sql,values);}) as PoolClient['query']};}};
      const action=(kind:string,i:number)=>kind==='save'?store((i===0?gated:leases[i]!.db) as Fixture['db']).appendToolSucceededStepWithSafeResultIfRunning(r.id,'summary',raw):createAtomicRunFinalizer(i===0?gated:leases[i]!.db).tryFinalizeWithStep(r.id,'completed');
      const a=action(first,0);pending.push(a);await bounded(Promise.race([entered.promise,a.then(()=>{throw new Error('missing barrier');})]));
      const b=action(first==='save'?'finish':'save',1);pending.push(b);await waitLock(client,pids[1]);release.resolve();const results=await Promise.all([a,b]);
      if(first==='finish')expect(results[1]).toBeNull();
      const rows=await snapshot(client);expect(rows.steps.map(s=>s.result_kind)).toEqual(first==='save'?['tool_succeeded','completed']:['completed']);expect(rows.results).toHaveLength(first==='save'?1:0);
      expect(await store(db).appendToolSucceededStepWithSafeResultIfRunning(r.id,'summary',raw)).toBeNull();await checkGet(client,r,'completed');
      console.info(JSON.stringify({safeResultLockFirst:first,pids,stepKinds:rows.steps.map(s=>s.result_kind),resultCount:rows.results.length}));
    }finally{release.resolve();await Promise.allSettled(pending);await Promise.allSettled(clients.map(c=>c.query('ROLLBACK')));leases.forEach(l=>l.release());}
  }),15000);
  it('hides expired rows and manual purge deletes only results, preserving live results and all Run/Step history',async()=>withSchema(async({client,db})=>{
    const a=await running(client);const b=await running(client);await append(db,a.id);const live=await append(db,b.id);
    await client.query("UPDATE run_tool_results SET created_at=statement_timestamp()-INTERVAL '2 hours',expires_at=statement_timestamp()-INTERVAL '1 hour' WHERE run_id=$1",[a.id]);
    const before=await snapshot(client);expect(await store(db).getSavedToolResult(a.id,1)).toBeNull();expect(await store(db).getSavedToolResult(b.id,1)).toEqual(live.result);
    expect(await store(db).deleteExpiredToolResults()).toBe(1);expect(await store(db).deleteExpiredToolResults()).toBe(0);
    const after=await snapshot(client);expect(after.runs).toEqual(before.runs);expect(after.steps).toEqual(before.steps);expect(after.results).toHaveLength(1);expect(after.results[0].run_id).toBe(b.id);
  }));
  it('nonempty migration down preserves rows, all constraints and migration history',async()=>withSchema(async({schema,client,db})=>{
    const r=await running(client);await append(db,r.id);const before=await snapshot(client);
    await expect(migrate('test','down',schema)).rejects.toThrow('Cannot drop nonempty run_tool_results');expect(await snapshot(client)).toEqual(before);expect(await migrate('test','up',schema)).toHaveLength(0);
  }));
  it('down waits for concurrent Step/Result transaction and then refuses without deleting either',async()=>withSchema(async({schema,client,db})=>{
    const r=await running(client);const writer=await db.connect();let pending:Promise<{error?:unknown}>|undefined;
    try {
      await writer.query('BEGIN');await writer.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,1,'tool_succeeded')",[r.id]);
      await writer.query("INSERT INTO run_tool_results(run_id,step_no,schema_version,status,item_count,expires_at) VALUES($1,1,1,'ok',3,statement_timestamp()+INTERVAL '1 hour')",[r.id]);
      const before=await snapshot(client);pending=migrate('test','down',schema).then(()=>({}),error=>({error}));
      await vi.waitFor(async()=>expect((await client.query("SELECT 1 FROM pg_locks WHERE relation='run_steps'::regclass AND mode='AccessExclusiveLock' AND NOT granted")).rowCount).toBe(1),{timeout:3000});
      await writer.query('COMMIT');expect((await pending).error).toBeInstanceOf(Error);const after=await snapshot(client);expect(after.runs).toEqual(before.runs);expect(after.constraints).toEqual(before.constraints);expect(after.history).toEqual(before.history);expect(after.steps).toHaveLength(1);expect(after.results).toHaveLength(1);
    }finally{try{await writer.query('ROLLBACK');}finally{writer.release();if(pending)await pending;}}
  }),15000);
  it.each([{status:'ok',itemCount:0,ttl:1},{status:'empty',itemCount:1000,ttl:86400}])('accepts DB enum/count/TTL boundaries $status/$itemCount/$ttl',async({status,itemCount,ttl})=>withSchema(async({client,db})=>{
    const r=await running(client);const p=createToolResultPolicy([{name:'summary',retentionSeconds:ttl,project:()=>({schemaVersion:1,status,itemCount})}]);
    const saved=await createRunToolResultRepository(db,p).appendToolSucceededStepWithSafeResultIfRunning(r.id,'summary',raw);
    if(!saved||'kind' in saved)throw new Error('Expected saved');expect(saved.result.safeResult).toEqual({schemaVersion:1,status,itemCount});
    expect(new Date(saved.result.expiresAt).getTime()-new Date(saved.result.createdAt).getTime()).toBe(ttl*1000);
    const size=(await client.query("SELECT octet_length(jsonb_build_object('schemaVersion',schema_version,'status',status,'itemCount',item_count)::text) AS bytes FROM run_tool_results")).rows[0].bytes;
    expect(size).toBeLessThanOrEqual(1024);console.info(JSON.stringify({safeResultBytes:size,retentionSeconds:ttl}));
  }));
  it.each(['foreign-key','unique','check'])('recorder rolls back both inserts on real %s constraint failure',async mode=>withSchema(async({client,db})=>{
    const r=await running(client);await append(db,r.id);
    const assignment=mode==='foreign-key'?'NEW.step_no=999':mode==='unique'?'NEW.step_no=1':'NEW.schema_version=2';
    await client.query(`CREATE FUNCTION corrupt_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${assignment}; RETURN NEW; END $$`);
    await client.query('CREATE TRIGGER corrupt_result BEFORE INSERT ON run_tool_results FOR EACH ROW EXECUTE FUNCTION corrupt_result()');
    const before=await snapshot(client);await expect(append(db,r.id)).rejects.toMatchObject({code:mode==='foreign-key'?'23503':mode==='unique'?'23505':'23514'});
    expect(await snapshot(client)).toEqual(before);
  }));
  it('shares the parent lock and sequence with generic, continued and P2-D Tool Steps',async()=>withSchema(async({client,db})=>{
    const r=await running(client);
    const settled=await Promise.allSettled([append(db,r.id),createRunContinueRecorder(db).appendContinuedStepIfRunning(r.id),createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(r.id),createRunStepRepository(db).appendRunStep(r.id,'finalize_conflict')]);
    expect(settled.every(r=>r.status==='fulfilled')).toBe(true);const rows=await snapshot(client);expect(rows.steps.map(s=>s.step_no)).toEqual([1,2,3,4]);expect(rows.results).toHaveLength(1);
    expect(rows.steps.find(s=>s.step_no===rows.results[0].step_no).result_kind).toBe('tool_succeeded');
  }));
  it('existing P2-D Runtime and metadata Recorder retain default no-store after real tool success',async()=>withSchema(async({client,db})=>{
    const repo=createRunRepository(client);const r=await repo.createRun('TASK_SECRET');let decisions=0;
    const executor=createInMemoryToolExecutor({registry:createToolRegistry([{name:'echo',inputSchema:z.strictObject({})}]),handlers:[{name:'echo',handle:()=>({raw:'OUTPUT_SECRET',persistable:true})}],permitExecution:()=>true});
    const result=await runBoundedToolDecisions(r.id,{repository:repo,finalizer:createAtomicRunFinalizer(db),continueRecorder:createRunContinueRecorder(db),toolRecorder:createRunToolStepRecorder(db),executor,decide:()=>++decisions===1?{kind:'tool_request',toolName:'echo',arguments:{}}:{kind:'final',content:'done'}},{maxDecisions:2,maxToolExecutions:1});
    expect(result).toEqual({kind:'completed',content:'done'});expect((await createRunStepRepository(db).listRunSteps(r.id))!.map(s=>s.resultKind)).toEqual(['tool_succeeded','completed']);expect((await client.query('SELECT * FROM run_tool_results')).rows).toEqual([]);await checkGet(client,r,'completed');
    const explicit=await running(client);await append(db,explicit.id);expect((await client.query('SELECT * FROM run_tool_results')).rowCount).toBe(1);
    console.info('P2-D no-store: completed, GET 200, tool_succeeded/completed Steps, Results 0; explicit P2-E Results 1');
  }));
});


describe('PostgreSQL original TTL precision boundaries', () => {
  it.each(['-1', '0', '0.5', '0.999', '0.999999', '1', '60', '86400', '86400.001', '86400.000001'])('direct INSERT TTL %s seconds', async ttl => withSchema(async ({ client, db }) => {
    const r = await running(client);
    await createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(r.id);
    const before = await snapshot(client);
    const bounds = (await client.query("SELECT conname FROM pg_constraint WHERE conrelid='run_tool_results'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%isfinite(created_at)%'")).rows;
    expect(bounds).toHaveLength(1);
    const insert = client.query(`INSERT INTO run_tool_results(run_id,step_no,schema_version,status,item_count,created_at,expires_at)
      VALUES($1,1,1,'ok',0,statement_timestamp() - INTERVAL '0.999999 seconds',
        statement_timestamp() - INTERVAL '0.999999 seconds' + $2::numeric * INTERVAL '1 second')
      RETURNING EXTRACT(EPOCH FROM (expires_at-created_at))::text AS ttl`, [r.id, ttl]);
    if (Number(ttl) < 1 || Number(ttl) > 86400) {
      await expect(insert).rejects.toMatchObject({ code: '23514', constraint: bounds[0].conname });
      expect(await snapshot(client)).toEqual(before);
    } else {
      const inserted = await insert;
      expect(inserted.rowCount).toBe(1); expect(Number(inserted.rows[0].ttl)).toBe(Number(ttl));
    }
    console.info(JSON.stringify({ directTtlSeconds: ttl, expected: Number(ttl) < 1 || Number(ttl) > 86400 ? 'CHECK 23514' : 'accepted' }));
  }));
  it.each([
    { start: '2026-01-01T00:00:00.000001Z', end: '2026-01-01T00:00:01.000000Z', rounded: 1000 },
    { start: '2026-01-01T00:00:00.000000Z', end: '2026-01-02T00:00:00.000001Z', rounded: 86400000 },
  ])('rejects microsecond-invalid SQL fixture despite Date rounding to $rounded ms', async ({ start, end, rounded }) => withSchema(async ({ client }) => {
    // Synthetic SELECT rows only: never disable constraints or insert invalid data.
    const timestamps = (await client.query('SELECT $1::timestamptz AS start, $2::timestamptz AS end', [start, end])).rows[0];
    expect(timestamps.end.getTime() - timestamps.start.getTime()).toBe(rounded);
    let precisionEvidence: unknown;
    const db = { connect: async () => ({
      query: (async (sql: string, values?: unknown[]) => {
        const fixture = `(SELECT $1::uuid AS run_id, $2::integer AS step_no, 'tool_succeeded'::text AS result_kind,
          1::smallint AS schema_version, 'ok'::text AS status, 0::integer AS item_count,
          $3::timestamptz AS created_at, $4::timestamptz AS expires_at) AS run_tool_results`;
        const response = await client.query(sql.replace('FROM run_tool_results', `FROM ${fixture}`)
          .replaceAll('statement_timestamp()', "TIMESTAMPTZ '2026-01-01T00:00:00Z'"), [...values!, start, end]);
        expect(response.rowCount).toBe(1); precisionEvidence = response.rows[0].ttl_valid;
        return response;
      }) as PoolClient['query'],
      release: () => {},
    }) };
    await expect(createRunToolResultRepository(db).getSavedToolResult(randomUUID(), 1)).rejects.toThrow('Invalid saved tool result');
    expect(precisionEvidence).toBe(false);
  }));
  it('reads a valid one-second TTL with 0.5 seconds remaining and hides the exact expiry boundary', async () => withSchema(async ({ client, db }) => {
    const r = await running(client); await createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(r.id);
    // One fixed PostgreSQL transaction clock; no sleeps, wall-clock races or constraint removal.
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO run_tool_results(run_id,step_no,schema_version,status,item_count,created_at,expires_at)
        VALUES($1,1,1,'ok',0,transaction_timestamp()-INTERVAL '0.5 seconds',transaction_timestamp()+INTERVAL '0.5 seconds')`, [r.id]);
      const fixedDb = { connect: async () => ({
        query: ((sql: string, values?: unknown[]) => client.query(sql.replaceAll('statement_timestamp()', 'transaction_timestamp()'), values)) as PoolClient['query'],
        release: () => {},
      }) };
      const repo = createRunToolResultRepository(fixedDb);
      const saved = await repo.getSavedToolResult(r.id, 1);
      expect(saved).not.toBeNull(); expect(Date.parse(saved!.expiresAt)-Date.parse(saved!.createdAt)).toBe(1000);
      expect((await client.query('SELECT EXTRACT(EPOCH FROM (expires_at-transaction_timestamp()))::text AS remaining FROM run_tool_results')).rows[0].remaining).toBe('0.500000');
      await client.query("UPDATE run_tool_results SET created_at=transaction_timestamp()-INTERVAL '1 second',expires_at=transaction_timestamp() WHERE run_id=$1", [r.id]);
      expect(await repo.getSavedToolResult(r.id, 1)).toBeNull();
      await client.query("UPDATE run_tool_results SET created_at=transaction_timestamp()-INTERVAL '2 seconds',expires_at=transaction_timestamp()-INTERVAL '1 second' WHERE run_id=$1", [r.id]);
      expect(await repo.getSavedToolResult(r.id, 1)).toBeNull();
    } finally { await client.query('ROLLBACK'); }
  }));
});
