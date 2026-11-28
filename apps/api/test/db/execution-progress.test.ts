import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { describe, it, expect } from 'vitest';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository } from '../../src/persistence/run-repository.js';
import { createRunExecutionLeaseRepository } from '../../src/persistence/run-execution-lease-repository.js';
import { createRunContinueRecorder } from '../../src/persistence/run-continue-recorder.js';
import { createRunToolStepRecorder } from '../../src/persistence/run-tool-step-recorder.js';
import { createAtomicRunFinalizer } from '../../src/persistence/atomic-run-finalizer.js';
import { createRunToolResultRepository } from '../../src/persistence/run-tool-result-repository.js';
import { createToolResultPolicy } from '../../src/tools/tool-result-policy.js';
import type { LeaseWriteCredentials } from '../../src/persistence/lease-write-guard.js';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';
import { migrate } from '../../../../db/migrate.js';

import { createRunExecutionProgressRepository as progress } from '../../src/persistence/run-execution-progress-repository.js';
type DB = { connect(): Promise<Pick<PoolClient, 'query' | 'release'>> };
interface Fixture { schema: string; client: PoolClient; db: { connect(): Promise<PoolClient> } }
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
    results: (await c.query('SELECT * FROM run_tool_results ORDER BY run_id,step_no')).rows,
    progress: (await c.query('SELECT *,created_at::text AS created_exact,updated_at::text AS updated_exact FROM run_execution_progress ORDER BY run_id')).rows,
    history: (await c.query('SELECT * FROM pgmigrations ORDER BY id')).rows,
    constraints: (await c.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='run_execution_progress'::regclass ORDER BY conname")).rows };
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

const modes = ['initialize', 'decision', 'tool', 'confirm'] as const;
type Mode = typeof modes[number];
function write(mode: Mode, db: DB, id: string, c: LeaseWriteCredentials, version = 0) {
  const r = progress(db);
  if (mode === 'initialize') return r.initializeProgress(id, c, { maxDecisions: 5, maxToolAttempts: 1 });
  if (mode === 'decision') return r.tryReserveDecision(id, c, version);
  if (mode === 'tool') return r.tryReserveToolAttempt(id, c, version);
  return r.tryConfirmCommittedStep(id, c, { expectedVersion: version, stepNo: 1 });
}
async function prepared(f: Fixture, mode: Mode, seconds = 30) {
  const x = await fresh(f, seconds); let version = 0;
  if (mode !== 'initialize') await write('initialize', f.db, x.run.id, x.c);
  if (mode === 'tool') { await write('decision', f.db, x.run.id, x.c); version = 1; }
  if (mode === 'confirm') await createRunContinueRecorder(f.db).appendContinuedStepWithLease(x.run.id, x.c);
  return { ...x, version };
}

describe('Progress initialization and guard matrix', () => {
  it.each(modes.flatMap(mode => ['owner','token','other-token','no-lease','missing','queued','completed','failed','expired'].map(reason => ({ mode, reason }))))('$mode refuses $reason with all five tables unchanged', async ({ mode, reason }) => withSchema(async f => {
    const x = await prepared(f, mode); const other = await fresh(f); await write('initialize', f.db, other.run.id, other.c);
    let id = x.run.id; let c = x.c;
    if (reason === 'owner') c = { ...c, ownerId: randomUUID() };
    if (reason === 'token') c = { ...c, leaseToken: randomUUID() };
    if (reason === 'other-token') c = { ...c, leaseToken: other.c.leaseToken };
    if (reason === 'missing') id = randomUUID();
    if (reason === 'no-lease') await f.client.query('DELETE FROM run_execution_leases WHERE run_id=$1', [id]);
    if (['queued','completed','failed'].includes(reason)) await f.client.query('UPDATE runs SET status=$2 WHERE id=$1', [id, reason]);
    if (reason === 'expired') await expire(f.client, id);
    const before = await snapshot(f.client);
    expect(await write(mode, f.db, id, c, x.version)).toBeNull(); expect(await snapshot(f.client)).toEqual(before);
  }));
  it.each(['existing', 'step', 'result'])('initialization never backfills or overwrites %s', async reason => withSchema(async f => {
    const x = await fresh(f);
    if (reason === 'existing') await progress(f.db).initializeProgress(x.run.id, x.c, { maxDecisions: 1, maxToolAttempts: 0 });
    else if (reason === 'step') await createRunContinueRecorder(f.db).appendContinuedStepWithLease(x.run.id, x.c);
    else {
      const policy = createToolResultPolicy([{ name: 'fixture', retentionSeconds: 60, project: () => ({ schemaVersion: 1, status: 'ok', itemCount: 0 }) }]);
      await createRunToolResultRepository(f.db, policy).appendToolSucceededStepWithSafeResultWithLease(x.run.id, 'fixture', { kind: 'tool_succeeded', output: { raw: 'PRIVATE' } }, x.c);
      expect((await snapshot(f.client)).results).toHaveLength(1);
    }
    const before = await snapshot(f.client); expect(await write('initialize', f.db, x.run.id, x.c)).toBeNull(); expect(await snapshot(f.client)).toEqual(before);
  }));
  it.each(['decision','tool','confirm'] as const)('%s requires an initialized row', async mode => withSchema(async f => {
    const x = await fresh(f); const before = await snapshot(f.client);
    expect(await write(mode, f.db, x.run.id, x.c)).toBeNull(); expect(await snapshot(f.client)).toEqual(before);
  }));
  it.each([1,2,3,4,5].flatMap(maxDecisions => [0,1].map(maxToolAttempts => ({ maxDecisions, maxToolAttempts }))))('conservative caps $maxDecisions/$maxToolAttempts persist in a separate pool', async caps => withSchema(async f => {
    const x = await fresh(f); const r = progress(f.db); const p = await r.initializeProgress(x.run.id, x.c, caps);
    expect(p).toMatchObject({ schemaVersion: 1, checkpointVersion: 0, lastConfirmedStepNo: null, decisionsReserved: 0, toolAttemptsReserved: 0, ...caps });
    expect(p!.createdAt).toBe(p!.updatedAt); expect(Object.isFrozen(p)).toBe(true);
    expect(await r.tryReserveToolAttempt(x.run.id, x.c, 0)).toBeNull();
    for (let i = 0; i < caps.maxDecisions; i++) expect(await r.tryReserveDecision(x.run.id, x.c, i)).toMatchObject({ checkpointVersion: i + 1, decisionsReserved: i + 1 });
    expect(await r.tryReserveDecision(x.run.id, x.c, caps.maxDecisions)).toBeNull();
    const t = await r.tryReserveToolAttempt(x.run.id, x.c, caps.maxDecisions);
    if (caps.maxToolAttempts) expect(t).toMatchObject({ toolAttemptsReserved: 1, checkpointVersion: caps.maxDecisions + 1 }); else expect(t).toBeNull();
    const version = caps.maxDecisions + caps.maxToolAttempts;
    const before = await snapshot(f.client); expect(await r.tryReserveToolAttempt(x.run.id, x.c, version)).toBeNull(); expect(await snapshot(f.client)).toEqual(before);
    const pool = new Pool({ connectionString: readDatabaseUrl('test'), connectionTimeoutMillis: 5000 });
    try {
      const db = { async connect() { const c = await pool.connect(); try { await assertDatabaseIdentity(c,'test'); await c.query(`SET search_path TO "${f.schema}"`); return c; } catch(e) { c.release(true); throw e; } } };
      expect(await progress(db).getProgressSnapshot(x.run.id)).toMatchObject({ decisionsReserved: caps.maxDecisions, toolAttemptsReserved: caps.maxToolAttempts, checkpointVersion: version, diagnostic: 'aligned' });
    } finally { await pool.end(); }
    expect((await snapshot(f.client)).steps).toEqual([]); // Reservations are not calls or completed Steps.
  }));
  it.each(['decision','tool','confirm'] as const)('%s stale version and overflow deny without partial counters', async mode => withSchema(async f => {
    const x = await prepared(f, mode); const before = await snapshot(f.client);
    expect(await write(mode, f.db, x.run.id, x.c, x.version + 1)).toBeNull(); expect(await snapshot(f.client)).toEqual(before);
    await f.client.query('UPDATE run_execution_progress SET checkpoint_version=2147483647');
    const max = await snapshot(f.client); expect(await write(mode, f.db, x.run.id, x.c, 2147483647)).toBeNull(); expect(await snapshot(f.client)).toEqual(max);
  }));
});

describe('Committed metadata watermark and snapshots', () => {
  it('synthetic Claim -> budgets -> continued #1 -> tool #2, separate commits; no external call or raw Result', async () => withSchema(async f => {
    const x = await fresh(f); const r = progress(f.db); await write('initialize', f.db, x.run.id, x.c); const before = await snapshot(f.client);
    expect(await r.tryReserveDecision(x.run.id,x.c,0)).toMatchObject({ checkpointVersion: 1 });
    expect(await createRunContinueRecorder(f.db).appendContinuedStepWithLease(x.run.id,x.c)).toMatchObject({ stepNo: 1 });
    expect(await r.getProgressSnapshot(x.run.id)).toMatchObject({ diagnostic:'steps_ahead',lastConfirmedStepNo:null,maxStepNo:1 });
    expect(await r.tryConfirmCommittedStep(x.run.id,x.c,{expectedVersion:1,stepNo:1})).toMatchObject({ checkpointVersion:2,lastConfirmedStepNo:1 });
    expect(await r.tryReserveDecision(x.run.id,x.c,2)).toMatchObject({ checkpointVersion:3,decisionsReserved:2 });
    expect(await r.tryReserveToolAttempt(x.run.id,x.c,3)).toMatchObject({ checkpointVersion:4,toolAttemptsReserved:1 });
    expect(await createRunToolStepRecorder(f.db).appendToolSucceededStepWithLease(x.run.id,x.c)).toMatchObject({stepNo:2});
    const ahead = await snapshot(f.client);
    expect(await r.getProgressSnapshot(x.run.id)).toMatchObject({ diagnostic:'steps_ahead',lastConfirmedStepNo:1,maxStepNo:2 });
    expect(await snapshot(f.client)).toEqual(ahead); // Reading performs no repair.
    expect(await r.tryConfirmCommittedStep(x.run.id,x.c,{expectedVersion:4,stepNo:2})).toMatchObject({ checkpointVersion:5,lastConfirmedStepNo:2 });
    const s=await r.getProgressSnapshot(x.run.id);expect(s).toMatchObject({ diagnostic:'aligned',maxStepNo:2,lastConfirmedStepNo:2,decisionsReserved:2,toolAttemptsReserved:1,checkpointVersion:5,leaseState:'active' });
    expect(Object.isFrozen(s)).toBe(true);expect(JSON.stringify(s)).not.toMatch(/leaseToken|ownerId|preserved|PRIVATE|resumable|canReplay/);
    const after=await snapshot(f.client);expect(after.runs).toEqual(before.runs);expect(after.leases).toEqual(before.leases);expect(after.results).toEqual([]);
    expect(after.steps.map(s=>[s.step_no,s.result_kind])).toEqual([[1,'continued'],[2,'tool_succeeded']]);
    console.info('P3-C synthetic: confirmed #1 -> #2; version=5, decisions=2, tools=1; aligned; no Runtime/Tool invocation');
  }));
  it.each(['missing','other-run','skip','duplicate','backwards','terminal-kind','uncommitted'])('rejects %s Step without changing any table', async reason=>withSchema(async f=>{
    const x=await prepared(f,'decision');const r=progress(f.db);let version=0;let stepNo=1;let holder:PoolClient|undefined;let pending:Promise<unknown>|undefined;
    try {
      if(reason==='other-run'){const y=await fresh(f);await createRunContinueRecorder(f.db).appendContinuedStepWithLease(y.run.id,y.c);}
      if(['skip','duplicate','backwards'].includes(reason)){
        await createRunContinueRecorder(f.db).appendContinuedStepWithLease(x.run.id,x.c);await createRunContinueRecorder(f.db).appendContinuedStepWithLease(x.run.id,x.c);
        if(reason==='skip')stepNo=2;
        else {await r.tryConfirmCommittedStep(x.run.id,x.c,{expectedVersion:0,stepNo:1});version=1;
          if(reason==='backwards'){await r.tryConfirmCommittedStep(x.run.id,x.c,{expectedVersion:1,stepNo:2});version=2;}}
      }
      if(reason==='terminal-kind')await f.client.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,1,'completed')",[x.run.id]);
      if(reason==='uncommitted'){
        holder=await f.db.connect();await holder.query('BEGIN');
        // Direct fixture uses NO KEY UPDATE to permit the FK key-share lock, not a supported writer.
        await holder.query('SELECT id FROM runs WHERE id=$1 FOR NO KEY UPDATE',[x.run.id]);
        await holder.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,1,'continued')",[x.run.id]);
        // Supported writer would hold parent FOR UPDATE; confirm would wait then see its COMMIT.
        // Roll back fixture while confirm waits, proving uncommitted data cannot be acknowledged.
        pending=r.tryConfirmCommittedStep(x.run.id,x.c,{expectedVersion:0,stepNo:1});void pending.catch(()=>{});
        await waitFor(async()=>(await f.client.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS b',[await pid(holder!)])).rows[0].b);
        await holder.query('ROLLBACK');expect(await pending).toBeNull();
      }
      const before=await snapshot(f.client);expect(await r.tryConfirmCommittedStep(x.run.id,x.c,{expectedVersion:version,stepNo})).toBeNull();expect(await snapshot(f.client)).toEqual(before);
    }finally{if(holder){try{await holder.query('ROLLBACK');}finally{holder.release();await Promise.allSettled(pending?[pending]:[]);}}}
  }));
  it('terminal finalization remains a separate commit and terminal snapshot is diagnostic only',async()=>withSchema(async f=>{
    const x=await prepared(f,'decision');await createAtomicRunFinalizer(f.db).tryFinalizeWithStepWithLease(x.run.id,'completed',x.c);
    const before=await snapshot(f.client);expect(await write('confirm',f.db,x.run.id,x.c)).toBeNull();
    expect(await progress(f.db).getProgressSnapshot(x.run.id)).toMatchObject({runStatus:'completed',leaseState:'run_not_running',diagnostic:'steps_ahead',lastConfirmedStepNo:null,maxStepNo:1});expect(await snapshot(f.client)).toEqual(before);
  }));
  it('diagnostic priority is inconsistent > steps_ahead > aligned; gaps and invalid watermark are never repaired',async()=>withSchema(async f=>{
    const x=await prepared(f,'decision');expect(await progress(f.db).getProgressSnapshot(randomUUID())).toBeNull();
    await f.client.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,2,'continued')",[x.run.id]);
    const before=await snapshot(f.client);expect(await progress(f.db).getProgressSnapshot(x.run.id)).toMatchObject({diagnostic:'inconsistent',maxStepNo:2});expect(await snapshot(f.client)).toEqual(before);
    await f.client.query('DELETE FROM run_steps');
    const fk=(await f.client.query("SELECT conname FROM pg_constraint WHERE conrelid='run_execution_progress'::regclass AND confrelid='run_steps'::regclass")).rows[0].conname;
    await f.client.query(`ALTER TABLE run_execution_progress DROP CONSTRAINT "${fk}"`);await f.client.query('UPDATE run_execution_progress SET last_confirmed_step_no=3');
    expect(await progress(f.db).getProgressSnapshot(x.run.id)).toMatchObject({diagnostic:'inconsistent',maxStepNo:null,lastConfirmedStepNo:3});
  }));
  it.each(['missing','expired','reverse'])('snapshot observes %s lease without granting permission',async mode=>withSchema(async f=>{
    const x=await prepared(f,'decision');
    if(mode==='missing')await f.client.query('DELETE FROM run_execution_leases');
    if(mode==='expired')await expire(f.client,x.run.id);
    if(mode==='reverse')await f.client.query("WITH tick AS MATERIALIZED(SELECT clock_timestamp()+INTERVAL '1 hour' AS t) UPDATE run_execution_leases SET renewed_at=t,expires_at=t+lease_seconds*INTERVAL '1 second' FROM tick");
    expect(await progress(f.db).getProgressSnapshot(x.run.id)).toMatchObject({leaseState:mode==='reverse'?'invalid_clock':mode});
  }));
});

describe.each(modes)('%s locking, clocks and failure atomicity', mode=>{
  it('same-version competitors on distinct backend PIDs produce exactly one winner',async()=>withSchema(async f=>{
    const x=await prepared(f,mode);const entered=barrier();const gate=barrier();let aPid=0;let bPid=0;let b:Promise<unknown>|undefined;
    const a=write(mode,wrap(f.db,async(c,s,v)=>{if(s==='COMMIT'){aPid=await pid(c);entered.resolve();await bounded(gate.promise);}return c.query(s,v);}),x.run.id,x.c,x.version);void a.catch(()=>{});
    try{await bounded(entered.promise);b=write(mode,observed(f.db,p=>{bPid=p;}),x.run.id,x.c,x.version);void b.catch(()=>{});
      await waitFor(async()=>bPid!==0);await blocked(f.client,aPid,bPid);gate.resolve();
      const results=await Promise.all([a,b]);expect(results.filter(Boolean)).toHaveLength(1);expect(results.filter(r=>r===null)).toHaveLength(1);
      expect(await progress(f.db).getProgressSnapshot(x.run.id)).toMatchObject({checkpointVersion:mode==='initialize'?0:x.version+1});
      console.info(JSON.stringify({case:'P3-C CAS',mode,pids:[aPid,bPid],wins:1,denials:1}));
    }finally{gate.resolve();await Promise.allSettled([a,...(b?[b]:[])]);}
  }));
  it.each(['parent','lease','progress'])('waits on %s; expires while blocked, and leaves all tables unchanged',async lock=>withSchema(async f=>{
    const x=await prepared(f,mode,1);const h=await f.db.connect();let pending:Promise<unknown>|undefined;let waiter=0;
    try{
      await h.query('BEGIN');
      const table=lock==='parent'?'runs':lock==='lease'?'run_execution_leases':'run_execution_progress';
      // Initialization has no row; table EXCLUSIVE lock exercises its absent-row SELECT FOR UPDATE wait.
      if(lock==='progress'&&mode==='initialize')await h.query('LOCK TABLE run_execution_progress IN EXCLUSIVE MODE');
      else await h.query(`SELECT 1 FROM ${table} WHERE ${lock==='parent'?'id':'run_id'}=$1 FOR UPDATE`,[x.run.id]);
      const holder=await pid(h);const before=await snapshot(f.client);
      expect((await f.client.query('SELECT expires_at>clock_timestamp() AS valid FROM run_execution_leases')).rows[0].valid).toBe(true);
      pending=write(mode,observed(f.db,p=>{waiter=p;}),x.run.id,x.c,x.version);void pending.catch(()=>{});
      await waitFor(async()=>waiter!==0);await blocked(f.client,holder,waiter);
      await waitFor(async()=>(await f.client.query('SELECT expires_at<=clock_timestamp() AS expired FROM run_execution_leases')).rows[0].expired);
      await h.query('COMMIT');expect(await pending).toBeNull();expect(await snapshot(f.client)).toEqual(before);
      console.info(JSON.stringify({case:'P3-C expiry lock',mode,lock,pids:[holder,waiter]}));
    }finally{try{await h.query('ROLLBACK');}finally{h.release();await Promise.allSettled(pending?[pending]:[]);}}
  }));
  it.each([-1,0,1,'reverse'] as const)('single actual SQL clock replacement: expiry offset %s microseconds',async offset=>withSchema(async f=>{
    const x=await prepared(f,mode);await f.client.query("CREATE TABLE test_clock AS SELECT clock_timestamp()+INTERVAL '1 second' AS t");
    if(offset==='reverse')await f.client.query("UPDATE run_execution_leases SET acquired_at=t,renewed_at=t+INTERVAL '1 microsecond',expires_at=t+INTERVAL '1 microsecond'+lease_seconds*INTERVAL '1 second' FROM test_clock");
    else await f.client.query("UPDATE run_execution_leases SET acquired_at=t-INTERVAL '60 seconds',renewed_at=t+$1*INTERVAL '1 microsecond'-lease_seconds*INTERVAL '1 second',expires_at=t+$1*INTERVAL '1 microsecond' FROM test_clock",[offset]);
    const before=await snapshot(f.client);let samples=0;
    const db=wrap(f.db,async(c,s,v)=>{if(s.includes('/* lease write guard */')){expect(s.match(/clock_timestamp\(\)/g)).toHaveLength(1);samples++;s=s.replace('clock_timestamp()','(SELECT t FROM test_clock)');}return c.query(s,v);});
    const r=await write(mode,db,x.run.id,x.c,x.version);expect(samples).toBe(1);
    if(offset===1)expect(r).not.toBeNull();else {expect(r).toBeNull();expect(await snapshot(f.client)).toEqual(before);}
  }));
  it('valid DML may commit after expiry without retry or deadline repair',async()=>withSchema(async f=>{
    const x=await prepared(f,mode,1);let writes=0;const before=await snapshot(f.client);
    const db=wrap(f.db,async(c,s,v)=>{if(s.includes('/* lease write guard */'))writes++;if(s==='COMMIT')await waitFor(async()=>(await c.query('SELECT expires_at<=clock_timestamp() AS e FROM run_execution_leases')).rows[0].e);return c.query(s,v);});
    expect(await write(mode,db,x.run.id,x.c,x.version)).not.toBeNull();expect(writes).toBe(1);expect((await snapshot(f.client)).leases).toEqual(before.leases);
  }));
  it.each(['renew','progress'])('%s first serializes renewal and Progress, with latest expiry observed',async first=>withSchema(async f=>{
    const x=await prepared(f,mode);const entered=barrier();const gate=barrier();let aPid=0;let bPid=0;let b:Promise<unknown>|undefined;
    const firstDb=wrap(f.db,async(c,s,v)=>{if(s==='COMMIT'){aPid=await pid(c);entered.resolve();await bounded(gate.promise);}return c.query(s,v);});const secondDb=observed(f.db,p=>{bPid=p;});
    const renew=(db:DB)=>createRunExecutionLeaseRepository(db).tryRenewRunLease(x.run.id,x.c);
    const a=first==='renew'?renew(firstDb):write(mode,firstDb,x.run.id,x.c,x.version);void a.catch(()=>{});
    try{await bounded(entered.promise);b=first==='renew'?write(mode,secondDb,x.run.id,x.c,x.version):renew(secondDb);void b.catch(()=>{});
      await waitFor(async()=>bPid!==0);await blocked(f.client,aPid,bPid);gate.resolve();expect(await a).not.toBeNull();expect(await b).not.toBeNull();
      expect(await progress(f.db).getProgressSnapshot(x.run.id)).toMatchObject({leaseState:'active'});
      console.info(JSON.stringify({case:'P3-C renewal order',mode,first,pids:[aPid,bPid]}));
    }finally{gate.resolve();await Promise.allSettled([a,...(b?[b]:[])]);}
  }));
  it.each(['dml','commit','check','fk'])('%s failure preserves all five tables and history; no retry',async stage=>withSchema(async f=>{
    const x=await prepared(f,mode);let writes=0;const releases:boolean[]=[];
    const event=mode==='initialize'?'INSERT':'UPDATE';
    const body=stage==='check'?'NEW.checkpoint_version=-1; RETURN NEW;':stage==='fk'?"NEW.last_confirmed_step_no=2147483647; RETURN NEW;":"RAISE EXCEPTION 'test rejection';";
    await f.client.query(`CREATE FUNCTION reject_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`);
    await f.client.query(stage==='commit'?`CREATE CONSTRAINT TRIGGER reject_progress AFTER ${event} ON run_execution_progress DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_progress()`:`CREATE TRIGGER reject_progress BEFORE ${event} ON run_execution_progress FOR EACH ROW EXECUTE FUNCTION reject_progress()`);
    const before=await snapshot(f.client);
    const db=wrap(f.db,async(c,s,v)=>{if(s.includes('/* lease write guard */'))writes++;return c.query(s,v);},releases);
    await expect(write(mode,db,x.run.id,x.c,x.version)).rejects.toMatchObject({code:stage==='check'?'23514':stage==='fk'?'23503':'P0001'});
    expect(await snapshot(f.client)).toEqual(before);expect(writes).toBe(1);expect(releases).toEqual([stage==='commit']);
  }));
  it('real COMMIT followed by simulated ack loss rejects/discards once, persisted reservation is not refunded',async()=>withSchema(async f=>{
    const x=await prepared(f,mode);let writes=0;const releases:boolean[]=[];
    const db=wrap(f.db,async(c,s,v)=>{if(s.includes('/* lease write guard */'))writes++;const r=await c.query(s,v);if(s==='COMMIT')throw new Error('simulated ack loss');return r;},releases);
    await expect(write(mode,db,x.run.id,x.c,x.version)).rejects.toThrow('simulated ack loss');expect(writes).toBe(1);expect(releases).toEqual([true]);
    expect(await progress(f.db).getProgressSnapshot(x.run.id)).toMatchObject({checkpointVersion:mode==='initialize'?0:x.version+1});
    const before=await snapshot(f.client);expect(await write(mode,f.db,x.run.id,x.c,x.version)).toBeNull();expect(await snapshot(f.client)).toEqual(before);
  }));
  it('failed rollback discards once and connection termination undoes partial DML',async()=>withSchema(async f=>{
    const x=await prepared(f,mode);const before=await snapshot(f.client);const releases:boolean[]=[];
    const db=wrap(f.db,async(c,s,v)=>{if(s==='ROLLBACK')throw new Error('simulated rollback failure');const r=await c.query(s,v);if(s.includes('/* lease write guard */'))throw new Error('after DML');return r;},releases);
    await expect(write(mode,db,x.run.id,x.c,x.version)).rejects.toThrow('after DML');expect(releases).toEqual([true]);
    await waitFor(async()=>(await f.client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n===0);
    expect(await snapshot(f.client)).toEqual(before);
  }));
});

it('one Run blocked on Progress does not block another Run',async()=>withSchema(async f=>{
  const x=await prepared(f,'decision');const y=await prepared(f,'decision');const h=await f.db.connect();let pending:Promise<unknown>|undefined;let waiter=0;
  try{await h.query('BEGIN');await h.query('SELECT 1 FROM run_execution_progress WHERE run_id=$1 FOR UPDATE',[x.run.id]);
    pending=write('decision',observed(f.db,p=>{waiter=p;}),x.run.id,x.c);void pending.catch(()=>{});await waitFor(async()=>waiter!==0);await blocked(f.client,await pid(h),waiter);
    expect(await write('decision',f.db,y.run.id,y.c)).not.toBeNull();await h.query('COMMIT');expect(await pending).not.toBeNull();
  }finally{try{await h.query('ROLLBACK');}finally{h.release();await Promise.allSettled(pending?[pending]:[]);}}
}));

describe('Progress migration nine',()=>{
  it('up/up, exact metadata columns, empty down and re-up preserve prior history/data',async()=>withSchema(async f=>{
    const x=await fresh(f);const before=await snapshot(f.client);expect(before.history).toHaveLength(10);
    const cols=(await f.client.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='run_execution_progress' ORDER BY ordinal_position",[f.schema])).rows;
    expect(cols.map(c=>c.column_name)).toEqual(['run_id','schema_version','checkpoint_version','last_confirmed_step_no','max_decisions','decisions_reserved','max_tool_attempts','tool_attempts_reserved','created_at','updated_at']);
    expect(cols.filter(c=>c.is_nullable==='YES').map(c=>c.column_name)).toEqual(['last_confirmed_step_no']);
    expect((await f.client.query("SELECT confdeltype FROM pg_constraint WHERE conrelid='run_execution_progress'::regclass AND contype='f'")).rows.map(c=>c.confdeltype)).toEqual(['a','a']);
    expect(cols.map(c=>c.data_type)).not.toContain('text');expect(cols.map(c=>c.data_type)).not.toContain('jsonb');
    expect(await migrate('test','up',f.schema)).toHaveLength(0);
    await migrate('test','down',f.schema); // cancellation checks (#10)
    expect(await migrate('test','down',f.schema)).toHaveLength(1);
    expect((await f.client.query("SELECT to_regclass('run_execution_progress') AS p")).rows[0].p).toBeNull();
    expect((await f.client.query('SELECT * FROM pgmigrations ORDER BY id')).rows).toEqual(before.history.slice(0,8));
    expect(await createRunRepository(f.client).findRunById(x.run.id)).toEqual({...x.run,status:'running'});
    expect(await migrate('test','up',f.schema)).toHaveLength(2);const after=await snapshot(f.client);
    for(const key of ['runs','leases','steps','results','constraints'] as const)expect(after[key]).toEqual(before[key]);
  }));
  it.each(['active','expired','terminal','exhausted'])('nonempty %s down preserves data, constraints and all history',async reason=>withSchema(async f=>{
    const x=await fresh(f);await progress(f.db).initializeProgress(x.run.id,x.c,{maxDecisions:1,maxToolAttempts:0});
    if(reason==='expired')await expire(f.client,x.run.id);
    if(reason==='terminal')await createAtomicRunFinalizer(f.db).tryFinalizeWithStepWithLease(x.run.id,'completed',x.c);
    if(reason==='exhausted')await write('decision',f.db,x.run.id,x.c);
    await migrate('test','down',f.schema); // exercise migration #9
    const before=await snapshot(f.client);await expect(migrate('test','down',f.schema)).rejects.toThrow('Cannot drop nonempty run_execution_progress');expect(await snapshot(f.client)).toEqual(before);
  }));
  it.each([
    ['schema_version','2','23514'],['checkpoint_version','-1','23514'],['checkpoint_version','2147483648','22003'],
    ['last_confirmed_step_no','0','23514'],['max_decisions','0','23514'],['max_decisions','6','23514'],
    ['decisions_reserved','-1','23514'],['decisions_reserved','6','23514'],['max_tool_attempts','-1','23514'],['max_tool_attempts','2','23514'],
    ['tool_attempts_reserved','-1','23514'],['tool_attempts_reserved','1','23514'],['tool_attempts_reserved','2','23514'],
    ['created_at',"'infinity'",'23514'],['updated_at',"'-infinity'",'23514'],['updated_at',"created_at-INTERVAL '1 microsecond'",'23514'],
    ['last_confirmed_step_no','1','23503'],['run_id',"'00000000-0000-4000-8000-000000000001'",'23503'],
    ...['run_id','schema_version','checkpoint_version','max_decisions','decisions_reserved','max_tool_attempts','tool_attempts_reserved','created_at','updated_at'].map(k=>[k,'NULL','23502']),
  ])('DB independently rejects %s=%s (%s)',async(column,value,code)=>withSchema(async f=>{
    const x=await prepared(f,'decision');const before=await snapshot(f.client);
    await expect(f.client.query(`UPDATE run_execution_progress SET ${column}=${value} WHERE run_id=$1`,[x.run.id])).rejects.toMatchObject({code});expect(await snapshot(f.client)).toEqual(before);
  }));
  it('PK, Run no-cascade and composite Step FK protect rows including cross-Run substitution',async()=>withSchema(async f=>{
    const x=await prepared(f,'confirm');const y=await fresh(f);const before=await snapshot(f.client);
    await expect(f.client.query('INSERT INTO run_execution_progress SELECT * FROM run_execution_progress')).rejects.toMatchObject({code:'23505'});
    await expect(f.client.query('DELETE FROM runs WHERE id=$1',[x.run.id])).rejects.toMatchObject({code:'23503'});
    await f.client.query('UPDATE run_execution_progress SET last_confirmed_step_no=1');const confirmed=await snapshot(f.client);
    await expect(f.client.query('UPDATE run_execution_progress SET run_id=$1',[y.run.id])).rejects.toMatchObject({code:'23503'});
    await expect(f.client.query('DELETE FROM run_steps WHERE run_id=$1',[x.run.id])).rejects.toMatchObject({code:'23503'});expect(await snapshot(f.client)).toEqual(confirmed);
    expect(confirmed.runs).toEqual(before.runs);
  }));
  it('in-flight initialized writer commits first; down waits on parent and then refuses',async()=>withSchema(async f=>{
    await migrate('test','down',f.schema); // exercise migration #9
    const x=await fresh(f);const entered=barrier();const gate=barrier();let holder=0;let down:Promise<unknown>|undefined;
    const writer=write('initialize',wrap(f.db,async(c,s,v)=>{if(s==='COMMIT'){holder=await pid(c);entered.resolve();await bounded(gate.promise);}return c.query(s,v);}),x.run.id,x.c);void writer.catch(()=>{});
    try{await bounded(entered.promise);down=migrate('test','down',f.schema).then(()=>({ok:true}),()=>({ok:false}));
      await waitFor(async()=>(await f.client.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS b',[holder])).rows[0].b);
      gate.resolve();expect(await writer).not.toBeNull();expect(await down).toEqual({ok:false});expect((await snapshot(f.client)).history).toHaveLength(9);
    }finally{gate.resolve();await Promise.allSettled([writer,...(down?[down]:[])]);}
  }));
  it('down first holds parent through DROP; waiting writer fails closed on missing table without any partial write',async()=>withSchema(async f=>{
    await migrate('test','down',f.schema); // exercise migration #9
    // Deterministic direct transaction executes the actual migration down SQL, like the runner's single TX.
    const { createRequire }=await import('node:module');const require=createRequire(import.meta.url);
    const migration=require('../../../../db/migrations/1794960000000-create-run-execution-progress.cjs') as {down(pgm:{sql(s:string):void}):void};
    let sql='';migration.down({sql:s=>{sql=s;}});const x=await fresh(f);const before=await snapshot(f.client);
    const holder=await f.db.connect();let pending:Promise<unknown>|undefined;let waiter=0;
    try{await holder.query('BEGIN');await holder.query(sql);pending=write('initialize',observed(f.db,p=>{waiter=p;}),x.run.id,x.c);void pending.catch(()=>{});
      await waitFor(async()=>waiter!==0);await blocked(f.client,await pid(holder),waiter);await holder.query('COMMIT');
      await expect(pending).rejects.toMatchObject({code:'42P01'});
      expect((await f.client.query('SELECT * FROM runs ORDER BY id')).rows).toEqual(before.runs);
      expect((await f.client.query('SELECT * FROM run_steps')).rows).toEqual(before.steps);
      // This fixture intentionally does not edit migration history; production uses migrate().
      expect((await f.client.query('SELECT * FROM pgmigrations ORDER BY id')).rows).toEqual(before.history);
    }finally{try{await holder.query('ROLLBACK');}finally{holder.release();await Promise.allSettled(pending?[pending]:[]);}}
  }));
});

it.each(['decision','tool','confirm'] as const)('%s reaches INTEGER max once and denies the next mutation',async mode=>withSchema(async f=>{
  const x=await prepared(f,mode);await f.client.query('UPDATE run_execution_progress SET checkpoint_version=2147483646');
  expect(await write(mode,f.db,x.run.id,x.c,2147483646)).toMatchObject({checkpointVersion:2147483647});
  const before=await snapshot(f.client);expect(await write(mode,f.db,x.run.id,x.c,2147483647)).toBeNull();expect(await snapshot(f.client)).toEqual(before);
}));
it.each(['decision','tool','confirm'] as const)('%s denies observed Progress clock reversal without changing Lease or ledger',async mode=>withSchema(async f=>{
  const x=await prepared(f,mode);await f.client.query("UPDATE run_execution_progress SET updated_at=clock_timestamp()+INTERVAL '1 hour'");
  const before=await snapshot(f.client);expect(await write(mode,f.db,x.run.id,x.c,x.version)).toBeNull();expect(await snapshot(f.client)).toEqual(before);
}));
it.each(['decision','confirm'] as const)('%s uses the renewed expiry after waiting: old expiry is insufficient',async mode=>withSchema(async f=>{
  const x=await prepared(f,mode);await f.client.query('CREATE TABLE renewal_clock AS SELECT renewed_at AS original, expires_at AS old_expiry FROM run_execution_leases');
  const entered=barrier();const gate=barrier();let holder=0;let waiter=0;let pending:Promise<unknown>|undefined;
  const renewDb=wrap(f.db,async(c,s,v)=>{
    if(s.includes('/* lease renewal */'))s=s.replace('clock_timestamp()',"(SELECT original+INTERVAL '1 second' FROM renewal_clock)");
    if(s==='COMMIT'){holder=await pid(c);entered.resolve();await bounded(gate.promise);}return c.query(s,v);
  });
  const renewing=createRunExecutionLeaseRepository(renewDb).tryRenewRunLease(x.run.id,x.c);void renewing.catch(()=>{});
  const db=wrap(f.db,async(c,s,v)=>{
    if(s.startsWith('BEGIN'))waiter=await pid(c);
    if(s.includes('/* lease write guard */')){expect(s.match(/clock_timestamp\(\)/g)).toHaveLength(1);s=s.replace('clock_timestamp()',"(SELECT old_expiry+INTERVAL '1 microsecond' FROM renewal_clock)");}
    return c.query(s,v);
  });
  try{await bounded(entered.promise);pending=write(mode,db,x.run.id,x.c,x.version);void pending.catch(()=>{});await waitFor(async()=>waiter!==0);await blocked(f.client,holder,waiter);
    gate.resolve();expect(await renewing).not.toBeNull();expect(await pending).not.toBeNull();
    console.info(JSON.stringify({case:'P3-C fresh renewed expiry',mode,pids:[holder,waiter],clock:'old expiry + 1us',result:'accepted under new expiry'}));
  }finally{gate.resolve();await Promise.allSettled([renewing,...(pending?[pending]:[])]);}
}));
