import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { describe, it, expect } from 'vitest';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository } from '../../src/persistence/run-repository.js';
import { createRunStepRepository } from '../../src/persistence/run-step-repository.js';
import { createRunExecutionLeaseRepository } from '../../src/persistence/run-execution-lease-repository.js';
import { createRunContinueRecorder } from '../../src/persistence/run-continue-recorder.js';
import { createRunToolStepRecorder } from '../../src/persistence/run-tool-step-recorder.js';
import { createAtomicRunFinalizer, finalizationResultKinds } from '../../src/persistence/atomic-run-finalizer.js';
import { createRunToolResultRepository } from '../../src/persistence/run-tool-result-repository.js';
import { createToolResultPolicy } from '../../src/tools/tool-result-policy.js';
import type { LeaseWriteCredentials } from '../../src/persistence/lease-write-guard.js';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';
import { migrate } from '../../../../db/migrate.js';

type DB = { connect(): Promise<Pick<PoolClient, 'query' | 'release'>> };
interface Fixture { schema: string; client: PoolClient; db: { connect(): Promise<PoolClient> } }
const modes = ['continue', 'tool', 'final', 'result'] as const;
type Mode = typeof modes[number];
const legacyModes = ['start', 'finish', 'general', ...modes] as const;
type Legacy = typeof legacyModes[number];
const outcome = { kind: 'tool_succeeded', output: { raw: 'PRIVATE_OUTCOME' } };
const policy = createToolResultPolicy([{ name: 'fixture', retentionSeconds: 60, project: () => ({ schemaVersion: 1, status: 'ok', itemCount: 2 }) }]);
function write(mode: Mode, db: DB, id: string, c: LeaseWriteCredentials) {
  if (mode === 'continue') return createRunContinueRecorder(db).appendContinuedStepWithLease(id, c);
  if (mode === 'tool') return createRunToolStepRecorder(db).appendToolSucceededStepWithLease(id, c);
  if (mode === 'final') return createAtomicRunFinalizer(db).tryFinalizeWithStepWithLease(id, 'completed', c);
  return createRunToolResultRepository(db, policy).appendToolSucceededStepWithSafeResultWithLease(id, 'fixture', outcome, c);
}
async function legacy(mode: Legacy, db: DB, id: string) {
  if (mode === 'general') return createRunStepRepository(db).appendRunStep(id, 'completed');
  if (mode === 'continue') return createRunContinueRecorder(db).appendContinuedStepIfRunning(id);
  if (mode === 'tool') return createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(id);
  if (mode === 'final') return createAtomicRunFinalizer(db).tryFinalizeWithStep(id, 'completed');
  if (mode === 'result') return createRunToolResultRepository(db, policy).appendToolSucceededStepWithSafeResultIfRunning(id, 'fixture', outcome);
  const client = await db.connect();
  try { return mode === 'start' ? await createRunRepository(client).tryStartRun(id) : await createRunRepository(client).tryFinishRun(id, 'completed'); }
  finally { client.release(); }
}
async function withSchema(work: (f: Fixture) => Promise<void>) {
  const pool = createDatabase(readDatabaseUrl('test')); const schema = 'axiom_test_' + randomUUID().replaceAll('-', '');
  let client: PoolClient | undefined; let made = false;
  try {
    client = await pool.connect(); await assertDatabaseIdentity(client, 'test');
    await client.query(`CREATE SCHEMA "${schema}"`); made = true;
    await client.query(`SET search_path TO "${schema}"`); await client.query("SET statement_timeout TO '5s'");
    await migrate('test', 'up', schema);
    const db = { async connect() {
      const c = await pool.connect();
      try { await assertDatabaseIdentity(c, 'test'); await c.query(`SET search_path TO "${schema}"`); await c.query("SET statement_timeout TO '5s'"); return c; }
      catch (e) { c.release(true); throw e; }
    } };
    await work({ schema, client, db }); expect(pool.totalCount - pool.idleCount).toBe(1);
  } finally { try { if (made) await client!.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { client?.release(); await pool.end(); } }
}
async function snapshot(c: PoolClient) {
  return { runs: (await c.query('SELECT * FROM runs ORDER BY id')).rows,
    leases: (await c.query('SELECT run_id,owner_id,lease_token,lease_seconds,acquired_at::text,renewed_at::text,expires_at::text FROM run_execution_leases ORDER BY run_id')).rows,
    steps: (await c.query('SELECT * FROM run_steps ORDER BY run_id,step_no')).rows,
    results: (await c.query('SELECT * FROM run_tool_results ORDER BY run_id,step_no')).rows };
}
async function fresh(f: Fixture, seconds = 30) {
  const run = await createRunRepository(f.client).createRun('  preserved 😀  ');
  const h = await createRunExecutionLeaseRepository(f.db).tryClaimRunLease(run.id, { ownerId: randomUUID(), leaseSeconds: seconds });
  expect(h).not.toBeNull(); return { run, c: { ownerId: h!.ownerId, leaseToken: h!.leaseToken } };
}
async function expire(c: PoolClient, id: string) {
  await c.query("WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS t) UPDATE run_execution_leases SET acquired_at=t-INTERVAL '1 hour',renewed_at=t-INTERVAL '30 minutes',expires_at=t-INTERVAL '30 minutes'+lease_seconds*INTERVAL '1 second' FROM tick WHERE run_id=$1", [id]);
}
function barrier() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('test barrier timeout')), 4000); })]); }
  finally { clearTimeout(timer); }
}
async function waitFor(check: () => Promise<boolean>) {
  const end = performance.now() + 4000;
  while (performance.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Expected DB-observed barrier');
}
async function pid(c: Pick<PoolClient, 'query'>) { return (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number; }
function wrap(db: DB, intercept: (c: Pick<PoolClient, 'query'>, sql: string, values?: unknown[]) => Promise<unknown>, releases: boolean[] = []): DB {
  return { async connect() { const c = await db.connect(); return { query: ((sql: string, v?: unknown[]) => intercept(c, sql, v)) as PoolClient['query'], release: discard => { releases.push(Boolean(discard)); c.release(discard); } }; } };
}
async function blocked(c: PoolClient, holder: number, waiter: number) {
  expect(holder).not.toBe(waiter);
  await waitFor(async () => (await c.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked', [holder, waiter])).rows[0].blocked);
}
function observed(db: DB, setter: (pid: number) => void): DB {
  return wrap(db, async (c, sql, v) => { if (sql.startsWith('BEGIN') || sql.startsWith('UPDATE runs')) setter(await pid(c)); return c.query(sql, v); });
}

describe('write protocol matrix', () => {
  it.each(legacyModes.flatMap(mode => ['active','expired','completed','failed','queued'].map(state => ({ mode, state }))))('legacy $mode denies $state Lease with every table unchanged', async ({ mode, state }) => withSchema(async f => {
    const x = await fresh(f);
    if (state === 'expired') await expire(f.client, x.run.id);
    // Defensive SQL fixtures are setup, not claims about supported state transitions.
    if (['completed','failed','queued'].includes(state)) await f.client.query('UPDATE runs SET status=$2 WHERE id=$1', [x.run.id, state]);
    const before = await snapshot(f.client); expect(await legacy(mode, f.db, x.run.id)).toBeNull(); expect(await snapshot(f.client)).toEqual(before);
  }));
  it.each(legacyModes)('legacy %s retains No-Lease behavior', async mode => withSchema(async f => {
    const run = await createRunRepository(f.client).createRun('legacy');
    if (!['start','general'].includes(mode)) await createRunRepository(f.client).tryStartRun(run.id);
    expect(await legacy(mode, f.db, run.id)).not.toBeNull(); expect((await snapshot(f.client)).leases).toEqual([]);
  }));
  it.each(modes.flatMap(mode => ['owner','token','other-token','no-lease','missing','queued','completed','failed','expired'].map(reason => ({ mode, reason }))))('$mode guard refuses $reason without any write', async ({ mode, reason }) => withSchema(async f => {
    const x = await fresh(f); let id = x.run.id; let c = x.c;
    if (reason === 'owner') c = { ...c, ownerId: randomUUID() };
    if (reason === 'token') c = { ...c, leaseToken: randomUUID() };
    if (reason === 'other-token') c = { ...c, leaseToken: (await fresh(f)).c.leaseToken };
    if (reason === 'no-lease') { const r = await createRunRepository(f.client).createRun('unleased'); id = r.id; await createRunRepository(f.client).tryStartRun(id); }
    if (reason === 'missing') id = randomUUID();
    if (['queued','completed','failed'].includes(reason)) await f.client.query('UPDATE runs SET status=$2 WHERE id=$1', [id, reason]);
    if (reason === 'expired') await expire(f.client, id);
    const before = await snapshot(f.client); expect(await write(mode, f.db, id, c)).toBeNull(); expect(await snapshot(f.client)).toEqual(before);
  }));
  it('Claim -> continued -> tool -> completed preserves fields, ordering, Lease and token privacy', async () => withSchema(async f => {
    const x = await fresh(f); const lease = (await snapshot(f.client)).leases;
    const results = [await write('continue', f.db, x.run.id, x.c), await write('tool', f.db, x.run.id, x.c), await write('final', f.db, x.run.id, x.c)];
    expect(results.every(Boolean)).toBe(true); expect(JSON.stringify(results)).not.toContain(x.c.leaseToken);
    const s = await snapshot(f.client); expect(s.steps.map(r => [r.step_no, r.result_kind])).toEqual([[1,'continued'],[2,'tool_succeeded'],[3,'completed']]);
    expect(s.leases).toEqual(lease); expect(s.results).toHaveLength(0);
    expect(await createRunRepository(f.client).findRunById(x.run.id)).toEqual({ ...x.run, status: 'completed' });
    console.info('P3-B synthetic integration: running -> continued #1 -> tool_succeeded #2 -> completed #3; Run fields/Lease preserved');
  }));
  it('Safe Result requires Policy AND Lease; maintenance remains a separate expired-Result-only deletion', async () => withSchema(async f => {
    const x = await fresh(f); let connections = 0;
    const db = { async connect() { connections++; return f.db.connect(); } };
    expect(await createRunToolResultRepository(db).appendToolSucceededStepWithSafeResultWithLease(x.run.id,'fixture',outcome,x.c)).toEqual({kind:'no_store'});
    expect(connections).toBe(0);
    const saved = await write('result', f.db, x.run.id, x.c); expect(saved).toHaveProperty('result.safeResult', {schemaVersion:1,status:'ok',itemCount:2});
    expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_OUTCOME|leaseToken/);
    const before = await snapshot(f.client);
    await f.client.query("UPDATE run_tool_results SET created_at=statement_timestamp()-INTERVAL '2 minutes',expires_at=statement_timestamp()-INTERVAL '1 minute'");
    expect(await createRunToolResultRepository(f.db).getSavedToolResult(x.run.id,1)).toBeNull();
    expect(await createRunToolResultRepository(f.db).deleteExpiredToolResults()).toBe(1);
    const after=await snapshot(f.client);expect(after.runs).toEqual(before.runs);expect(after.steps).toEqual(before.steps);expect(after.leases).toEqual(before.leases);
  }));
  it('schema mismatch rejects instead of silently bypassing Lease protection', async () => withSchema(async f => {
    await migrate('test','down',f.schema); // cancellation checks (#10)
    await migrate('test','down',f.schema); // empty Progress table (#9)
    const r=await createRunRepository(f.client).createRun('old schema');await migrate('test','down',f.schema);
    await expect(createRunRepository(f.client).tryStartRun(r.id)).rejects.toMatchObject({code:'42P01'});
    await expect(createRunStepRepository(f.db).appendRunStep(r.id,'completed')).rejects.toMatchObject({code:'42P01'});
  }));
});

describe.each(modes)('%s real time and failure boundaries', mode => {
  it.each(['parent','lease'])('waits on %s lock, then denies after DB-observed expiry', async lock => withSchema(async f => {
    const x=await fresh(f,1);const holder=await f.db.connect();let pending:Promise<unknown>|undefined;let waiter=0;
    try {
      await holder.query('BEGIN');await holder.query(lock==='parent'?'SELECT id FROM runs WHERE id=$1 FOR UPDATE':'SELECT run_id FROM run_execution_leases WHERE run_id=$1 FOR UPDATE',[x.run.id]);
      const holderPid=await pid(holder);const before=await snapshot(f.client);
      expect((await f.client.query('SELECT expires_at>clock_timestamp() AS valid FROM run_execution_leases')).rows[0].valid).toBe(true);
      pending=write(mode,observed(f.db,p=>{waiter=p;}),x.run.id,x.c);void pending.catch(()=>{});
      await waitFor(async()=>waiter!==0);await blocked(f.client,holderPid,waiter);
      await waitFor(async()=>(await f.client.query('SELECT expires_at<=clock_timestamp() AS expired FROM run_execution_leases')).rows[0].expired);
      await holder.query('COMMIT');expect(await pending).toBeNull();expect(await snapshot(f.client)).toEqual(before);
    } finally { try { await holder.query('ROLLBACK'); } finally { holder.release();await Promise.allSettled(pending?[pending]:[]); } }
  }));
  it.each([-1,0,1,'reverse'] as const)('first guarded DML checks %s microsecond boundary with actual SQL', async offset => withSchema(async f => {
    const x=await fresh(f,1);await f.client.query("CREATE TABLE write_test_clock AS SELECT '2026-11-15T00:00:01Z'::timestamptz AS t");
    if(offset==='reverse')await f.client.query("UPDATE run_execution_leases SET acquired_at=t,renewed_at=t+INTERVAL '1 microsecond',expires_at=t+INTERVAL '1 microsecond'+lease_seconds*INTERVAL '1 second' FROM write_test_clock");
    else await f.client.query("UPDATE run_execution_leases SET acquired_at=t-INTERVAL '2 seconds',renewed_at=t-INTERVAL '1 second'+$1*INTERVAL '1 microsecond',expires_at=t+$1*INTERVAL '1 microsecond' FROM write_test_clock",[offset]);
    const before=await snapshot(f.client);let replacements=0;
    const db=wrap(f.db,async(c,sql,v)=>{if(sql.includes('/* lease write guard */')){expect(sql.match(/clock_timestamp\(\)/g)).toHaveLength(1);replacements++;sql=sql.replace('clock_timestamp()','(SELECT t FROM write_test_clock)');}return c.query(sql,v);});
    const result=await write(mode,db,x.run.id,x.c);expect(replacements).toBe(1);
    if(offset===1)expect(result).not.toBeNull();else {expect(result).toBeNull();expect(await snapshot(f.client)).toEqual(before);}
    expect((await snapshot(f.client)).leases).toEqual(before.leases);
  }));
  it('entry may succeed then COMMIT after expiry; no renewal or retry repairs the deadline', async()=>withSchema(async f=>{
    const x=await fresh(f,1);const before=await snapshot(f.client);let writes=0;
    const db=wrap(f.db,async(c,sql,v)=>{if(sql.includes('/* lease write guard */'))writes++;if(sql==='COMMIT')await waitFor(async()=>(await c.query('SELECT expires_at<=clock_timestamp() AS expired FROM run_execution_leases WHERE run_id=$1',[x.run.id])).rows[0].expired);return c.query(sql,v);});
    expect(await write(mode,db,x.run.id,x.c)).not.toBeNull();expect(writes).toBe(1);
    const after=await snapshot(f.client);expect(after.leases).toEqual(before.leases);expect(after.steps).toHaveLength(1);
  }));
  it.each(['step','commit',...(mode==='final'?['update']:mode==='result'?['result']:[])])('%s DB failure rolls back the complete operation', async stage=>withSchema(async f=>{
    const x=await fresh(f);const before=await snapshot(f.client);
    const table=stage==='update'?'runs':stage==='result'?'run_tool_results':'run_steps';const event=stage==='update'?'UPDATE':'INSERT';
    await f.client.query("CREATE FUNCTION reject_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected write failure'; END $$");
    await f.client.query(stage==='commit'?`CREATE CONSTRAINT TRIGGER reject_write AFTER ${event} ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_write()`:`CREATE TRIGGER reject_write BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_write()`);
    const releases:boolean[]=[];let writes=0;const db=wrap(f.db,async(c,s,v)=>{if(s.includes('/* lease write guard */'))writes++;return c.query(s,v);},releases);
    await expect(write(mode,db,x.run.id,x.c)).rejects.toMatchObject({code:'P0001'});expect(await snapshot(f.client)).toEqual(before);expect(writes).toBe(1);expect(releases).toEqual([stage==='commit']);
  }));
  it('real COMMIT followed by simulated acknowledgement loss discards without retry or success',async()=>withSchema(async f=>{
    const x=await fresh(f);const before=await snapshot(f.client);const releases:boolean[]=[];let writes=0;
    const db=wrap(f.db,async(c,s,v)=>{if(s.includes('/* lease write guard */'))writes++;const r=await c.query(s,v);if(s==='COMMIT')throw new Error('simulated ack loss');return r;},releases);
    await expect(write(mode,db,x.run.id,x.c)).rejects.toThrow('simulated ack loss');expect(releases).toEqual([true]);expect(writes).toBe(1);
    const after=await snapshot(f.client);expect(after.steps).toHaveLength(1);expect(after.results).toHaveLength(mode==='result'?1:0);expect(after.runs[0].status).toBe(mode==='final'?'completed':'running');expect(after.leases).toEqual(before.leases);
  }));
  it('rollback failure discards the transaction and leaves no partial write',async()=>withSchema(async f=>{
    const x=await fresh(f);const before=await snapshot(f.client);const releases:boolean[]=[];
    const db=wrap(f.db,async(c,s,v)=>{if(s==='ROLLBACK')throw new Error('simulated rollback failure');const r=await c.query(s,v);if(s.includes('INSERT INTO run_steps'))throw new Error('after DML');return r;},releases);
    await expect(write(mode,db,x.run.id,x.c)).rejects.toThrow('after DML');expect(releases).toEqual([true]);
    await waitFor(async()=>(await f.client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n===0);
    expect(await snapshot(f.client)).toEqual(before);
  }));
  it.each(['renew','write'])('%s wins the lock; second sees current state/expiry',async first=>withSchema(async f=>{
    const x=await fresh(f);const gate=barrier();const entered=barrier();let aPid=0;let bPid=0;let b:Promise<unknown>|undefined;
    const firstDb=wrap(f.db,async(c,s,v)=>{if(s==='COMMIT'){aPid=await pid(c);entered.resolve();await bounded(gate.promise);}return c.query(s,v);});
    const secondDb=observed(f.db,p=>{bPid=p;});
    const renew=(db:DB)=>createRunExecutionLeaseRepository(db).tryRenewRunLease(x.run.id,x.c);
    const a=first==='renew'?renew(firstDb):write(mode,firstDb,x.run.id,x.c);void a.catch(()=>{});
    try {
      await bounded(entered.promise);b=first==='renew'?write(mode,secondDb,x.run.id,x.c):renew(secondDb);void b.catch(()=>{});
      await waitFor(async()=>bPid!==0);await blocked(f.client,aPid,bPid);gate.resolve();expect(await a).not.toBeNull();
      const result=await b;if(first==='write'&&mode==='final')expect(result).toBeNull();else expect(result).not.toBeNull();
      expect((await snapshot(f.client)).steps).toHaveLength(1);
    } finally {gate.resolve();await Promise.allSettled([a,...(b?[b]:[])]);}
  }));
});

describe('Claim/Legacy snapshot and terminal ordering', () => {
  it.each(legacyModes.flatMap(mode => [false,true].map(rollback => ({mode,rollback}))))('Claim first vs $mode, rollback=$rollback',async({mode,rollback})=>withSchema(async f=>{
    const run=await createRunRepository(f.client).createRun('claim boundary');
    const gate=barrier();const entered=barrier();let holder=0;let waiter=0;let other:Promise<unknown>|undefined;
    const claimDb=wrap(f.db,async(c,s,v)=>{
      if(s==='COMMIT'){holder=await pid(c);entered.resolve();await bounded(gate.promise);if(rollback)throw new Error('rollback claim fixture');}
      return c.query(s,v);
    });
    const claim=createRunExecutionLeaseRepository(claimDb).tryClaimRunLease(run.id,{ownerId:randomUUID(),leaseSeconds:30});void claim.catch(()=>{});
    try {
      await bounded(entered.promise);other=legacy(mode,observed(f.db,p=>{waiter=p;}),run.id);void other.catch(()=>{});
      // A query-only finish sees queued and returns immediately, by design.
      if(mode==='finish')expect(await bounded(other)).toBeNull();
      else {await waitFor(async()=>waiter!==0);await blocked(f.client,holder,waiter);}
      gate.resolve();if(rollback)await expect(claim).rejects.toThrow('rollback claim fixture');else expect(await claim).not.toBeNull();
      const result=await other;const maySucceed=rollback&&(mode==='start'||mode==='general');
      if(maySucceed)expect(result).not.toBeNull();else expect(result).toBeNull();
      const s=await snapshot(f.client);expect(s.leases).toHaveLength(rollback?0:1);expect(s.steps).toHaveLength(rollback&&mode==='general'?1:0);expect(s.results).toHaveLength(0);
    }finally{gate.resolve();await Promise.allSettled([claim,...(other?[other]:[])]);}
  }));
  it.each(legacyModes)('legacy %s first preserves its old queued semantics before Claim',async mode=>withSchema(async f=>{
    const run=await createRunRepository(f.client).createRun('legacy first');const gate=barrier();const entered=barrier();let holder=0;let waiter=0;let claim:Promise<unknown>|undefined;
    const db=wrap(f.db,async(c,s,v)=>{
      if(mode==='start'||mode==='finish'){
        if(s.startsWith('UPDATE runs')){
          await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          try {
            const r=await c.query(s,v);holder=await pid(c);entered.resolve();
            await bounded(gate.promise);await c.query('COMMIT');return r;
          } catch(error) { await c.query('ROLLBACK');throw error; }
        }
      }else if(s==='COMMIT'){holder=await pid(c);entered.resolve();await bounded(gate.promise);}
      return c.query(s,v);
    });
    const first=legacy(mode,db,run.id);void first.catch(()=>{});
    try{
      await bounded(entered.promise);
      claim=createRunExecutionLeaseRepository(observed(f.db,p=>{waiter=p;})).tryClaimRunLease(run.id,{ownerId:randomUUID(),leaseSeconds:30});void claim.catch(()=>{});
      if(mode==='finish')expect(await bounded(claim)).not.toBeNull();
      else {await waitFor(async()=>waiter!==0);await blocked(f.client,holder,waiter);}
      gate.resolve();const result=await first;
      if(mode==='start'||mode==='general')expect(result).not.toBeNull();else expect(result).toBeNull();
      if(mode==='start')expect(await claim).toBeNull();else expect(await claim).not.toBeNull();
      const s=await snapshot(f.client);expect(s.steps).toHaveLength(mode==='general'?1:0);expect(s.leases).toHaveLength(mode==='start'?0:1);
    }finally{gate.resolve();await Promise.allSettled([first,...(claim?[claim]:[])]);}
  }));
  it.each(['Pool','PoolClient'] as const)('query-only %s start/finish uses supported READ COMMITTED Claim invariants',async shape=>withSchema(async f=>{
    const pool=new Pool({connectionString:readDatabaseUrl('test'),max:1,options:`-c search_path=${f.schema} -c statement_timeout=5000`});
    let client:PoolClient|undefined;let claim:Promise<unknown>|undefined;
    const gate=barrier();const entered=barrier();let holder=0;let start:Promise<unknown>|undefined;
    try{
      const identityClient=await pool.connect();
      try {
        await assertDatabaseIdentity(identityClient,'test');
        if(shape==='PoolClient')client=identityClient;
      } finally { if(client!==identityClient)identityClient.release(); }
      const target=client??pool;const targetPid=await pid(target);
      const run=await createRunRepository(f.client).createRun('query only');
      claim=createRunExecutionLeaseRepository(wrap(f.db,async(c,s,v)=>{if(s==='COMMIT'){holder=await pid(c);entered.resolve();await bounded(gate.promise);}return c.query(s,v);})).tryClaimRunLease(run.id,{ownerId:randomUUID(),leaseSeconds:30});void claim.catch(()=>{});
      await bounded(entered.promise);const repository=createRunRepository(target);
      expect(await repository.tryFinishRun(run.id,'completed')).toBeNull();
      start=repository.tryStartRun(run.id);void start.catch(()=>{});await blocked(f.client,holder,targetPid);
      gate.resolve();expect(await claim).not.toBeNull();expect(await start).toBeNull();
      expect(await repository.tryFinishRun(run.id,'completed')).toBeNull();
      console.info(JSON.stringify({queryOnly:shape,backendPids:[holder,targetPid],claimWinner:true,legacyStart:null,legacyFinish:null}));
    }finally{gate.resolve();await Promise.allSettled([...(claim?[claim]:[]),...(start?[start]:[])]);client?.release();await pool.end();}
  }));
  it('two independent Lease finalizers create exactly one terminal Step and preserve another Run',async()=>withSchema(async f=>{
    const x=await fresh(f);const other=await createRunRepository(f.client).createRun('other');const pids=new Set<number>();
    const db=observed(f.db,p=>{pids.add(p);});const results=await Promise.all([write('final',db,x.run.id,x.c),write('final',db,x.run.id,x.c)]);
    expect(pids.size).toBe(2);expect(results.filter(Boolean)).toHaveLength(1);expect(results.filter(x=>x===null)).toHaveLength(1);
    const s=await snapshot(f.client);expect(s.steps.map(x=>[x.step_no,x.result_kind])).toEqual([[1,'completed']]);expect(await createRunRepository(f.client).findRunById(other.id)).toEqual(other);
    console.info(JSON.stringify({leaseFinalizerPids:[...pids],winners:1,nulls:1,terminalSteps:1}));
  }));
  it.each((['continue','tool','result'] as const).flatMap(mode=>[false,true].map(finalFirst=>({mode,finalFirst}))))('$mode vs Finalizer finalFirst=$finalFirst serializes Step numbering',async({mode,finalFirst})=>withSchema(async f=>{
    const x=await fresh(f);const gate=barrier();const entered=barrier();let holder=0;let waiter=0;let b:Promise<unknown>|undefined;
    const firstDb=wrap(f.db,async(c,s,v)=>{if(s==='COMMIT'){holder=await pid(c);entered.resolve();await bounded(gate.promise);}return c.query(s,v);});
    const a=write(finalFirst?'final':mode,firstDb,x.run.id,x.c);void a.catch(()=>{});
    try{
      await bounded(entered.promise);b=write(finalFirst?mode:'final',observed(f.db,p=>{waiter=p;}),x.run.id,x.c);void b.catch(()=>{});
      await waitFor(async()=>waiter!==0);await blocked(f.client,holder,waiter);gate.resolve();expect(await a).not.toBeNull();
      if(finalFirst)expect(await b).toBeNull();else expect(await b).not.toBeNull();
      const s=await snapshot(f.client);expect(s.steps.map(r=>r.step_no)).toEqual(finalFirst?[1]:[1,2]);expect(s.steps.at(-1).result_kind).toBe('completed');
      expect(s.results).toHaveLength(!finalFirst&&mode==='result'?1:0);
    }finally{gate.resolve();await Promise.allSettled([a,...(b?[b]:[])]);}
  }));
});

describe('additional contract regressions',()=>{
  it.each(['queued','running','completed','failed'])('general No-Lease append retains %s semantics',async status=>withSchema(async f=>{
    const r=await createRunRepository(f.client).createRun('general compatibility');
    if(status!=='queued')await createRunRepository(f.client).tryStartRun(r.id);
    if(status==='completed'||status==='failed')await createRunRepository(f.client).tryFinishRun(r.id,status);
    expect(await createRunStepRepository(f.db).appendRunStep(r.id,'completed')).toHaveProperty('stepNo',1);
  }));
  it.each(finalizationResultKinds)('Lease Finalizer preserves %s outcome mapping',async kind=>withSchema(async f=>{
    const x=await fresh(f);const result=await createAtomicRunFinalizer(f.db).tryFinalizeWithStepWithLease(x.run.id,kind,x.c);
    expect(result?.run).toEqual({...x.run,status:kind==='completed'?'completed':'failed'});
    expect(result?.step.resultKind).toBe(kind);expect(result?.step.stepNo).toBe(1);
  }));
  it('general legacy append discards an uncertain COMMIT and does not retry the committed Step',async()=>withSchema(async f=>{
    const r=await createRunRepository(f.client).createRun('general ack');const releases:boolean[]=[];let inserts=0;
    const db=wrap(f.db,async(c,s,v)=>{if(s.startsWith('INSERT'))inserts++;const result=await c.query(s,v);if(s==='COMMIT')throw new Error('simulated ack loss');return result;},releases);
    await expect(createRunStepRepository(db).appendRunStep(r.id,'completed')).rejects.toThrow('simulated ack loss');
    expect(releases).toEqual([true]);expect(inserts).toBe(1);expect((await snapshot(f.client)).steps).toHaveLength(1);
  }));
  it.each(modes)('%s waiting writer observes newly renewed expiry, not pre-wait expiry',async mode=>withSchema(async f=>{
    const x=await fresh(f,1);const gate=barrier();const entered=barrier();let holder=0;let waiter=0;let writing:Promise<unknown>|undefined;
    // Let the original interval mostly elapse, using only observed PostgreSQL time.
    await waitFor(async()=>(await f.client.query("SELECT expires_at-clock_timestamp()<INTERVAL '500 milliseconds' AS near FROM run_execution_leases")).rows[0].near);
    const renew=createRunExecutionLeaseRepository(wrap(f.db,async(c,s,v)=>{
      if(s==='COMMIT'){holder=await pid(c);entered.resolve();await bounded(gate.promise);}
      return c.query(s,v);
    })).tryRenewRunLease(x.run.id,x.c);void renew.catch(()=>{});
    try {
      await bounded(entered.promise);writing=write(mode,observed(f.db,p=>{waiter=p;}),x.run.id,x.c);void writing.catch(()=>{});
      await waitFor(async()=>waiter!==0);await blocked(f.client,holder,waiter);
      // Observer still sees the OLD committed Lease until renewal COMMIT.
      await waitFor(async()=>(await f.client.query('SELECT expires_at<=clock_timestamp() AS expired FROM run_execution_leases')).rows[0].expired);
      gate.resolve();expect(await renew).not.toBeNull();expect(await writing).not.toBeNull();
      expect((await snapshot(f.client)).steps).toHaveLength(1);
    }finally{gate.resolve();await Promise.allSettled([renew,...(writing?[writing]:[])]);}
  }));
});
