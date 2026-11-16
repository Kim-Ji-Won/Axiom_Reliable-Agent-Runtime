import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository } from '../../src/persistence/run-repository.js';
import { createAtomicRunFinalizer } from '../../src/persistence/atomic-run-finalizer.js';
import { createRunExecutionLeaseRepository } from '../../src/persistence/run-execution-lease-repository.js';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';
import { migrate } from '../../../../db/migrate.js';

type Connection = Pick<PoolClient, 'query' | 'release'>;
interface Fixture { schema: string; pool: Pool; client: PoolClient; db: { connect(): Promise<PoolClient> } }
async function withSchema(work: (f: Fixture) => Promise<void>) {
  const pool = createDatabase(readDatabaseUrl('test')); const schema = `axiom_test_${randomUUID().replaceAll('-', '')}`;
  let client: PoolClient | undefined; let created = false;
  try {
    client = await pool.connect(); await assertDatabaseIdentity(client, 'test');
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}"`); await client.query("SET statement_timeout TO '5s'");
    await migrate('test', 'up', schema);
    const db = { async connect() {
      const c = await pool.connect();
      try { await assertDatabaseIdentity(c, 'test'); await c.query(`SET search_path TO "${schema}"`); await c.query("SET statement_timeout TO '5s'"); return c; }
      catch (e) { c.release(true); throw e; }
    } };
    await work({ pool, schema, client, db });
    expect(pool.totalCount - pool.idleCount).toBe(1);
  } finally {
    try { if (created) await client!.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { client?.release(); await pool.end(); }
  }
}
async function state(c: PoolClient) {
  return { runs: (await c.query('SELECT * FROM runs ORDER BY id')).rows,
    leases: (await c.query('SELECT *, acquired_at::text AS acquired_exact, renewed_at::text AS renewed_exact, expires_at::text AS expires_exact FROM run_execution_leases ORDER BY run_id')).rows,
    steps: (await c.query('SELECT * FROM run_steps ORDER BY run_id,step_no')).rows,
    results: (await c.query('SELECT * FROM run_tool_results ORDER BY run_id,step_no')).rows,
    history: (await c.query('SELECT * FROM pgmigrations ORDER BY id')).rows,
    constraints: (await c.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='run_execution_leases'::regclass ORDER BY conname")).rows };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Lease test barrier timeout')), 4000); })]); }
  finally { clearTimeout(timer); }
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function waitFor(check: () => Promise<boolean>, label: string) {
  const until = performance.now() + 4000;
  while (performance.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`Timed out observing ${label}`);
}
async function pid(c: PoolClient) { return (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number; }
function wrap(db: Fixture['db'], intercept: (c: PoolClient, sql: string, values?: unknown[]) => Promise<unknown>, releases: boolean[] = []) {
  return { async connect(): Promise<Connection> {
    const c = await db.connect(); return { query: ((sql: string, values?: unknown[]) => intercept(c, sql, values)) as PoolClient['query'],
      release: discard => { releases.push(Boolean(discard)); c.release(discard); } };
  } };
}
async function fresh(f: Fixture, seconds = 30) {
  const run = await createRunRepository(f.client).createRun('  lease field preservation 😀  '); const ownerId = randomUUID();
  const repo = createRunExecutionLeaseRepository(f.db); const handle = await repo.tryClaimRunLease(run.id, { ownerId, leaseSeconds: seconds });
  expect(handle).not.toBeNull(); return { run, ownerId, repo, handle: handle! };
}
async function expire(c: PoolClient, id: string) {
  await c.query("WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS t) UPDATE run_execution_leases SET acquired_at=t-INTERVAL '1 hour', renewed_at=t-INTERVAL '30 minutes', expires_at=t-INTERVAL '30 minutes' + lease_seconds*INTERVAL '1 second' FROM tick WHERE run_id=$1", [id]);
}
// Fixed clock fixture replaces ONLY the one clock expression in the actual repository
// statement; no copied predicate and no production time injection API.
function fixedClock(db: Fixture['db'], seen: string[]) {
  return wrap(db, async (c, sql, values) => {
    if (sql.includes('/* lease renewal */') || sql.includes('/* lease snapshot */')) {
      expect(sql.match(/clock_timestamp\(\)/g)).toHaveLength(1); seen.push(sql);
      sql = sql.replace('clock_timestamp()', '(SELECT t FROM lease_test_clock)');
    }
    return c.query(sql, values);
  });
}

describe('real PostgreSQL execution Lease foundation', () => {
  it.each([1, 300])('atomically claims %i seconds, preserves Run fields, creates no Step/Result; persists across pools', async seconds => withSchema(async f => {
    const x = await fresh(f, seconds); const found = await createRunRepository(f.client).findRunById(x.run.id);
    expect(found).toEqual({ ...x.run, status: 'running' }); expect(x.handle.acquiredAt).toBe(x.handle.renewedAt);
    const renewed = await x.repo.tryRenewRunLease(x.run.id, { ownerId: x.ownerId, leaseToken: x.handle.leaseToken });
    expect(renewed?.leaseSeconds).toBe(seconds); expect(renewed?.acquiredAt).toBe(x.handle.acquiredAt);
    const s = await state(f.client); expect(s.leases).toHaveLength(1); expect(s.steps).toHaveLength(0); expect(s.results).toHaveLength(0);
    const pool = createDatabase(readDatabaseUrl('test'));
    try {
      const repo = createRunExecutionLeaseRepository({ async connect() { const c = await pool.connect(); try { await assertDatabaseIdentity(c, 'test'); await c.query(`SET search_path TO "${f.schema}"`); return c; } catch (error) { c.release(true); throw error; } } });
      const snapshot = await repo.getRunLeaseSnapshot(x.run.id); expect(snapshot?.state).toBe('active');
      expect(snapshot).not.toHaveProperty('leaseToken'); expect(snapshot?.acquiredAt).toBe(x.handle.acquiredAt);
    } finally { await pool.end(); }
  }));
  it.each(['missing','running','completed','failed','same-owner','queued-with-lease'])('claim %s refuses without changing any table', async mode => withSchema(async f => {
    const x = await fresh(f); let id = x.run.id;
    if (mode === 'missing') id = randomUUID();
    if (mode === 'completed' || mode === 'failed') await createAtomicRunFinalizer(f.db).tryFinalizeWithStepWithLease(id, mode === 'completed' ? 'completed' : 'invalid_decision', { ownerId: x.ownerId, leaseToken: x.handle.leaseToken });
    if (mode === 'queued-with-lease') await f.client.query("UPDATE runs SET status='queued' WHERE id=$1", [id]);
    const before = await state(f.client);
    expect(await x.repo.tryClaimRunLease(id, { ownerId: mode === 'same-owner' ? x.ownerId : randomUUID(), leaseSeconds: 30 })).toBeNull();
    expect(await state(f.client)).toEqual(before);
  }));
  it('renewal accepts uppercase ids, retains owner/token/TTL/acquired_at and two same-owner renewals serialize', async () => withSchema(async f => {
    const x = await fresh(f); const input = { ownerId: x.ownerId.toUpperCase(), leaseToken: x.handle.leaseToken.toUpperCase() };
    const results = await Promise.all([x.repo.tryRenewRunLease(x.run.id.toUpperCase(), input), x.repo.tryRenewRunLease(x.run.id, input)]);
    for (const r of results) { expect(r).not.toBeNull(); expect(r!.leaseToken === x.handle.leaseToken).toBe(true); expect(r?.ownerId).toBe(x.ownerId); expect(r?.leaseSeconds).toBe(30); expect(r?.acquiredAt).toBe(x.handle.acquiredAt); expect(r!.renewedAt >= x.handle.renewedAt).toBe(true); }
    expect((await x.repo.getRunLeaseSnapshot(x.run.id))?.state).toBe('active');
  }));
  it.each(['owner','token','missing','expired','completed','failed'])('renewal %s returns null with full data preservation', async mode => withSchema(async f => {
    const x = await fresh(f); if (mode === 'expired') await expire(f.client,x.run.id);
    if (mode === 'completed' || mode === 'failed') await createAtomicRunFinalizer(f.db).tryFinalizeWithStepWithLease(x.run.id, mode === 'completed' ? 'completed' : 'invalid_decision', { ownerId: x.ownerId, leaseToken: x.handle.leaseToken });
    const before = await state(f.client);
    expect(await x.repo.tryRenewRunLease(mode === 'missing' ? randomUUID() : x.run.id, { ownerId: mode === 'owner' ? randomUUID() : x.ownerId, leaseToken: mode === 'token' ? randomUUID() : x.handle.leaseToken })).toBeNull();
    expect(await state(f.client)).toEqual(before);
    expect((await x.repo.getRunLeaseSnapshot(x.run.id))?.state).toBe(mode === 'expired' ? 'expired' : mode === 'completed' || mode === 'failed' ? 'run_not_running' : 'active');
  }));
  it('P3-B blocks tokenless finish/finalizer on a Lease Run without changing data', async () => withSchema(async f => {
    const x = await fresh(f); const before = await state(f.client);
    expect(await createRunRepository(f.client).tryFinishRun(x.run.id, 'completed')).toBeNull();
    expect(await createAtomicRunFinalizer(f.db).tryFinalizeWithStep(x.run.id, 'completed')).toBeNull();
    expect(await state(f.client)).toEqual(before);
  }));
  it('legacy running without lease cannot renew or gain a lease; missing snapshot is null', async () => withSchema(async f => {
    const r = createRunRepository(f.client); const run = await r.createRun('legacy'); await r.tryStartRun(run.id); const repo = createRunExecutionLeaseRepository(f.db);
    expect(await repo.tryClaimRunLease(run.id,{ownerId:randomUUID(),leaseSeconds:30})).toBeNull();
    expect(await repo.tryRenewRunLease(run.id,{ownerId:randomUUID(),leaseToken:randomUUID()})).toBeNull(); expect(await repo.getRunLeaseSnapshot(run.id)).toBeNull();
  }));
  it('two distinct backend owners claim once; unrelated Run is unchanged', async () => withSchema(async f => {
    const runs = createRunRepository(f.client); const run = await runs.createRun('claim race'); const other = await runs.createRun('other'); const pids = new Set<number>();
    const db = wrap(f.db, async (c,sql,v) => { if (sql.startsWith('BEGIN')) pids.add(await pid(c)); return c.query(sql,v); }); const repo = createRunExecutionLeaseRepository(db);
    const results = await Promise.all([repo.tryClaimRunLease(run.id,{ownerId:randomUUID(),leaseSeconds:30}),repo.tryClaimRunLease(run.id,{ownerId:randomUUID(),leaseSeconds:30})]);
    expect(pids.size).toBe(2); expect(results.filter(Boolean)).toHaveLength(1); expect(results.filter(r=>r===null)).toHaveLength(1);
    expect((await state(f.client)).leases).toHaveLength(1); expect(await runs.findRunById(other.id)).toEqual(other);
    console.info(JSON.stringify({leaseClaimPids:[...pids],winners:1,nulls:1,leaseRows:1}));
  }));
  it.each(['lease','legacy'])('%s acquires the parent lock first and wins against the other start path', async winner => withSchema(async f => {
    const run = await createRunRepository(f.client).createRun('legacy competition');
    const clients: PoolClient[] = [];
    const reached = barrier(); const gate = barrier(); let first: Promise<unknown> | undefined; let second: Promise<unknown> | undefined;
    try {
      const a = await f.db.connect(); clients.push(a); const b = await f.db.connect(); clients.push(b);
      const [pa, pb] = await Promise.all([pid(a), pid(b)]); expect(pa).not.toBe(pb);
      if (winner === 'lease') {
        const db = { async connect() { return { query: (async (sql: string, v?: unknown[]) => {
          if (sql === 'COMMIT') { reached.resolve(); await bounded(gate.promise); }
          return a.query(sql, v);
        }) as PoolClient['query'], release() {} }; } };
        first = createRunExecutionLeaseRepository(db).tryClaimRunLease(run.id, { ownerId: randomUUID(), leaseSeconds: 30 });
        void first.catch(() => {}); await bounded(reached.promise);
        second = createRunRepository(b).tryStartRun(run.id);
      } else {
        await a.query('BEGIN'); await createRunRepository(a).tryStartRun(run.id);
        second = createRunExecutionLeaseRepository({ async connect() { return { query: b.query.bind(b), release() {} }; } }).tryClaimRunLease(run.id, { ownerId: randomUUID(), leaseSeconds: 30 });
      }
      void second.catch(() => {});
      await waitFor(async () => (await f.client.query('SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked', [pa, pb])).rows[0].blocked, 'legacy start wait');
      if (first) { gate.resolve(); expect(await first).not.toBeNull(); } else await a.query('COMMIT');
      expect(await second).toBeNull(); expect((await state(f.client)).leases).toHaveLength(winner === 'lease' ? 1 : 0);
    } finally {
      gate.resolve(); await Promise.allSettled(first ? [first] : []);
      try { await clients[0]?.query('ROLLBACK'); } finally {
        await Promise.allSettled(second ? [second] : []); clients.forEach(c => c.release());
      }
    }
  }));
  it('rejects renewal after observed parent-lock wait expires; retains original microsecond times', async () => withSchema(async f => {
    const x = await fresh(f,1); const blocker = await f.db.connect(); let waitingPid = 0; let pending: Promise<unknown> | undefined;
    const db = wrap(f.db,async(c,sql,v)=>{if(sql.startsWith('BEGIN'))waitingPid=await pid(c);return c.query(sql,v);});
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[x.run.id]);
      const before = await state(f.client); expect((await f.client.query('SELECT expires_at>clock_timestamp() AS valid FROM run_execution_leases WHERE run_id=$1',[x.run.id])).rows[0].valid).toBe(true);
      pending = createRunExecutionLeaseRepository(db).tryRenewRunLease(x.run.id,{ownerId:x.ownerId,leaseToken:x.handle.leaseToken});
      void pending.catch(() => {});
      await waitFor(async()=>waitingPid!==0&&(await f.client.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[waitingPid])).rows[0].blocked,'renewal parent-lock wait');
      await waitFor(async()=>(await f.client.query('SELECT expires_at<=clock_timestamp() AS expired FROM run_execution_leases WHERE run_id=$1',[x.run.id])).rows[0].expired,'database expiry');
      await blocker.query('COMMIT'); expect(await pending).toBeNull(); expect(await state(f.client)).toEqual(before);
      console.info('Lease renewal: DB-observed lock wait, DB-observed expiry, null, original timestamps preserved');
    } finally { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); await Promise.allSettled(pending?[pending]:[]); } }
  }));
  it.each([-1,0,1])('actual renewal SQL tests expiry offset %i microseconds with fixed DB clock', async offset => withSchema(async f => {
    const x = await fresh(f,1); await f.client.query("CREATE TABLE lease_test_clock AS SELECT '2026-11-15T00:00:01.000000Z'::timestamptz AS t");
    await f.client.query(`UPDATE run_execution_leases SET acquired_at=t-INTERVAL '2 seconds', renewed_at=t-INTERVAL '1 second'+$2*INTERVAL '1 microsecond', expires_at=t+$2*INTERVAL '1 microsecond' FROM lease_test_clock WHERE run_id=$1`,[x.run.id,offset]);
    const seen:string[]=[]; const repo=createRunExecutionLeaseRepository(fixedClock(f.db,seen)); const before=await state(f.client);
    const snapshot=await repo.getRunLeaseSnapshot(x.run.id); expect(snapshot?.state).toBe(offset>0?'active':'expired');
    const result=await repo.tryRenewRunLease(x.run.id,{ownerId:x.ownerId,leaseToken:x.handle.leaseToken}); expect(result!==null).toBe(offset>0);
    if(offset<=0)expect(await state(f.client)).toEqual(before); else expect(result?.renewedAt).toBe('2026-11-15T00:00:01.000000Z');
    expect(seen).toHaveLength(2);
  }));
  it('rejects one-microsecond clock reversal using the actual renewal SQL', async()=>withSchema(async f=>{
    const x=await fresh(f); await f.client.query("CREATE TABLE lease_test_clock AS SELECT '2026-11-15T00:00:00Z'::timestamptz AS t");
    await f.client.query("UPDATE run_execution_leases SET acquired_at=t,renewed_at=t+INTERVAL '1 microsecond',expires_at=t+INTERVAL '1 microsecond'+lease_seconds*INTERVAL '1 second' FROM lease_test_clock WHERE run_id=$1",[x.run.id]);
    const before=await state(f.client); const seen:string[]=[];
    expect(await createRunExecutionLeaseRepository(fixedClock(f.db,seen)).tryRenewRunLease(x.run.id,{ownerId:x.ownerId,leaseToken:x.handle.leaseToken})).toBeNull(); expect(await state(f.client)).toEqual(before); expect(seen).toHaveLength(1);
  }));
  it.each(['finish','renew'])('%s wins lock order with credentialed finalization; terminal Step and lease survive', async winner => withSchema(async f => {
    const x = await fresh(f); const reached = barrier(); const gate = barrier(); let firstPid = 0; let secondPid = 0;
    const firstDb = wrap(f.db, async (c, sql, v) => {
      if (sql === 'COMMIT') { firstPid = await pid(c); reached.resolve(); await bounded(gate.promise); }
      return c.query(sql, v);
    });
    const secondDb = wrap(f.db, async (c, sql, v) => { if (sql.startsWith('BEGIN')) secondPid = await pid(c); return c.query(sql, v); });
    const input = { ownerId: x.ownerId, leaseToken: x.handle.leaseToken };
    const first = winner === 'finish' ? createAtomicRunFinalizer(firstDb).tryFinalizeWithStepWithLease(x.run.id, 'completed', { ownerId: x.ownerId, leaseToken: x.handle.leaseToken }) : createRunExecutionLeaseRepository(firstDb).tryRenewRunLease(x.run.id, input);
    void first.catch(() => {}); let second: Promise<unknown> | undefined;
    try {
      await bounded(reached.promise);
      second = winner === 'finish' ? createRunExecutionLeaseRepository(secondDb).tryRenewRunLease(x.run.id, input) : createAtomicRunFinalizer(secondDb).tryFinalizeWithStepWithLease(x.run.id, 'completed', { ownerId: x.ownerId, leaseToken: x.handle.leaseToken });
      void second.catch(() => {});
      await waitFor(async () => secondPid !== 0 && (await f.client.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked', [firstPid, secondPid])).rows[0].blocked, 'finish/renew wait');
      expect(firstPid).not.toBe(secondPid); gate.resolve(); expect(await first).not.toBeNull();
      const result = await second; if (winner === 'finish') expect(result).toBeNull(); else expect(result).not.toBeNull();
      const s = await state(f.client); expect(s.runs[0].status).toBe('completed'); expect(s.steps.map(r => r.result_kind)).toEqual(['completed']); expect(s.leases).toHaveLength(1);
      expect((await x.repo.getRunLeaseSnapshot(x.run.id))?.state).toBe('run_not_running');
      const before = await state(f.client); expect(await x.repo.tryRenewRunLease(x.run.id, input)).toBeNull(); expect(await state(f.client)).toEqual(before);
    } finally { gate.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  }));

});

const constraintCases: [string,string,string,string?][] = [
  ...['run_id','owner_id','lease_token','lease_seconds','acquired_at','renewed_at','expires_at'].map(k=>['null-'+k,k+' = NULL','23502',k] as [string,string,string,string]),
  ['seconds-zero','lease_seconds=0, expires_at=renewed_at','23514','run_execution_leases_seconds'],
  ['seconds-negative',"lease_seconds=-1, expires_at=renewed_at-INTERVAL '1 second'",'23514','run_execution_leases_seconds'],
  ['seconds-large',"lease_seconds=301, expires_at=renewed_at+INTERVAL '301 seconds'",'23514','run_execution_leases_seconds'],
  ['acquired-infinity',"acquired_at='-infinity'",'23514','run_execution_leases_finite'],
  ['renewed-infinity',"renewed_at='infinity',expires_at='infinity'",'23514','run_execution_leases_finite'],
  ['expires-infinity',"expires_at='infinity'",'23514','run_execution_leases_expiry'],
  ['reversed',"acquired_at=renewed_at+INTERVAL '1 microsecond'",'23514','run_execution_leases_order'],
  ['expiry-microsecond',"expires_at=expires_at-INTERVAL '1 microsecond'",'23514','run_execution_leases_expiry'],
];
describe('Lease database constraints, failure atomicity and migration safety',()=>{
  it.each(constraintCases)('direct SQL rejects %s with intended constraint',async(_label,change,code,constraint)=>withSchema(async f=>{
    const x=await fresh(f);const before=await state(f.client);
    await expect(f.client.query(`UPDATE run_execution_leases SET ${change} WHERE run_id=$1`,[x.run.id])).rejects.toMatchObject(code==='23502'?{code,column:constraint}:{code,constraint});
    expect(await state(f.client)).toEqual(before);
  }));
  it('enforces primary key, token UNIQUE, foreign key and non-cascading parent delete',async()=>withSchema(async f=>{
    const x=await fresh(f);const other=await createRunRepository(f.client).createRun('other');const before=await state(f.client);
    const insert='INSERT INTO run_execution_leases SELECT $1,owner_id,$2,lease_seconds,acquired_at,renewed_at,expires_at FROM run_execution_leases WHERE run_id=$3';
    await expect(f.client.query(insert,[x.run.id,randomUUID(),x.run.id])).rejects.toMatchObject({code:'23505',constraint:'run_execution_leases_pkey'});
    await expect(f.client.query(insert,[other.id,x.handle.leaseToken,x.run.id])).rejects.toMatchObject({code:'23505',constraint:'run_execution_leases_lease_token_key'});
    await expect(f.client.query(insert,[randomUUID(),randomUUID(),x.run.id])).rejects.toMatchObject({code:'23503',constraint:'run_execution_leases_run_id_fkey'});
    await expect(f.client.query('DELETE FROM runs WHERE id=$1',[x.run.id])).rejects.toMatchObject({code:'23503',constraint:'run_execution_leases_run_id_fkey'});
    expect(await state(f.client)).toEqual(before);
  }));
  it.each(['claim-update','claim-insert','claim-commit','renew-update','renew-commit'])('%s injected database failure leaves no partial state',async stage=>withSchema(async f=>{
    const run=await createRunRepository(f.client).createRun('fault');const ownerId=randomUUID();const repo=createRunExecutionLeaseRepository(f.db);
    const h=stage.startsWith('renew')?(await repo.tryClaimRunLease(run.id,{ownerId,leaseSeconds:30}))!:null;
    const table=stage==='claim-update'?'runs':'run_execution_leases';const event=stage==='claim-update'||stage.startsWith('renew')?'UPDATE':'INSERT';
    await f.client.query("CREATE FUNCTION reject_lease_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected lease write failure'; END $$");
    await f.client.query(stage.endsWith('commit')?`CREATE CONSTRAINT TRIGGER reject_lease AFTER ${event} ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_lease_write()`:`CREATE TRIGGER reject_lease BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_lease_write()`);
    const before=await state(f.client);const releases:boolean[]=[];let attempts=0;
    const instrumented=createRunExecutionLeaseRepository(wrap(f.db,async(c,sql,v)=>{if(sql.includes('/* lease'))attempts++;return c.query(sql,v);},releases));
    await expect(h?instrumented.tryRenewRunLease(run.id,{ownerId,leaseToken:h.leaseToken}):instrumented.tryClaimRunLease(run.id,{ownerId,leaseSeconds:30})).rejects.toMatchObject({code:'P0001'});
    expect(await state(f.client)).toEqual(before);expect(attempts).toBe(1);expect(releases).toEqual([stage.endsWith('commit')]);
  }));
  it.each(['claim','renew'])('%s real COMMIT then simulated ack loss rejects, discards and never retries',async mode=>withSchema(async f=>{
    const run=await createRunRepository(f.client).createRun('ack uncertainty');const ownerId=randomUUID();const repo=createRunExecutionLeaseRepository(f.db);
    const h=mode==='renew'?(await repo.tryClaimRunLease(run.id,{ownerId,leaseSeconds:30}))!:null;const releases:boolean[]=[];let writes=0;
    const broken=createRunExecutionLeaseRepository(wrap(f.db,async(c,sql,v)=>{if(sql.includes('/* lease'))writes++;const r=await c.query(sql,v);if(sql==='COMMIT')throw new Error('simulated lost acknowledgement');return r;},releases));
    await expect(h?broken.tryRenewRunLease(run.id,{ownerId,leaseToken:h.leaseToken}):broken.tryClaimRunLease(run.id,{ownerId,leaseSeconds:30})).rejects.toThrow('simulated lost acknowledgement');
    expect(releases).toEqual([true]);expect(writes).toBe(1);const s=await state(f.client);expect(s.runs[0].status).toBe('running');expect(s.leases).toHaveLength(1);
    const snapshot=await repo.getRunLeaseSnapshot(run.id);expect(snapshot?.state).toBe('active');expect(snapshot).not.toHaveProperty('leaseToken');
    if(h)expect(snapshot!.renewedAt>=h.renewedAt).toBe(true);
  }));
  it.each(['claim', 'renew'])('%s delayed COMMIT can return an already expired handle without retry or deadline repair', async mode => withSchema(async f => {
    const run = await createRunRepository(f.client).createRun('commit delay'); const ownerId = randomUUID();
    const initial = mode === 'renew' ? await createRunExecutionLeaseRepository(f.db).tryClaimRunLease(run.id, { ownerId, leaseSeconds: 1 }) : null;
    let writes = 0;
    const repo = createRunExecutionLeaseRepository(wrap(f.db, async (c, sql, v) => {
      if (sql.includes('/* lease')) writes++;
      if (sql === 'COMMIT') await waitFor(async () => (await c.query('SELECT expires_at <= clock_timestamp() AS expired FROM run_execution_leases WHERE run_id=$1', [run.id])).rows[0].expired, 'expiry before delayed commit');
      return c.query(sql, v);
    }));
    const result = initial ? await repo.tryRenewRunLease(run.id, { ownerId, leaseToken: initial.leaseToken }) : await repo.tryClaimRunLease(run.id, { ownerId, leaseSeconds: 1 });
    expect(result).not.toBeNull(); expect(writes).toBe(1);
    expect((await createRunExecutionLeaseRepository(f.db).getRunLeaseSnapshot(run.id))?.state).toBe('expired');
  }));
  it.each(['claim','renew'])('%s row validation and rollback failure discard a real connection without partial writes',async mode=>withSchema(async f=>{
    const run=await createRunRepository(f.client).createRun('bad return');const ownerId=randomUUID();const repo=createRunExecutionLeaseRepository(f.db);
    const h=mode==='renew'?(await repo.tryClaimRunLease(run.id,{ownerId,leaseSeconds:30}))!:null;const before=await state(f.client);const releases:boolean[]=[];
    const broken=createRunExecutionLeaseRepository(wrap(f.db,async(c,sql,v)=>{
      if(sql==='ROLLBACK')throw new Error('simulated rollback failure');
      const r=await c.query(sql,v);if(sql.includes('/* lease'))r.rows[0].time_valid=false;return r;
    },releases));
    await expect(h?broken.tryRenewRunLease(run.id,{ownerId,leaseToken:h.leaseToken}):broken.tryClaimRunLease(run.id,{ownerId,leaseSeconds:30})).rejects.toThrow('Invalid persisted execution lease');
    expect(releases).toEqual([true]);
    await waitFor(async()=>(await f.client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE '%lease%'")).rows[0].n===0,'discarded transaction cleanup');
    expect(await state(f.client)).toEqual(before);
  }));
  it('migration eight up/up, empty down and re-up preserve seven earlier migrations and rows',async()=>withSchema(async f=>{
    const run=await createRunRepository(f.client).createRun('preserved');const before=await state(f.client);expect(before.history).toHaveLength(8);
    expect(await migrate('test','up',f.schema)).toHaveLength(0);expect(await migrate('test','down',f.schema)).toHaveLength(1);
    expect((await f.client.query('SELECT * FROM pgmigrations ORDER BY id')).rows).toEqual(before.history.slice(0,7));
    expect((await f.client.query("SELECT to_regclass('run_execution_leases') AS table")).rows[0].table).toBeNull();
    expect(await migrate('test','up',f.schema)).toHaveLength(1);expect(await createRunRepository(f.client).findRunById(run.id)).toEqual(run);
    expect((await state(f.client)).constraints).toEqual(before.constraints);
  }));
  it.each(['active','expired','terminal'])('nonempty %s down preserves data, constraints and full migration history',async mode=>withSchema(async f=>{
    const x=await fresh(f);if(mode==='expired')await expire(f.client,x.run.id);if(mode==='terminal')await createAtomicRunFinalizer(f.db).tryFinalizeWithStepWithLease(x.run.id,'completed',{ownerId:x.ownerId,leaseToken:x.handle.leaseToken});
    // Seed an independently approved Safe Result fixture to prove down preserves it.
    const other=await createRunRepository(f.client).createRun('other');await createRunRepository(f.client).tryStartRun(other.id);
    await f.client.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES ($1,1,'tool_succeeded')",[other.id]);
    await f.client.query("INSERT INTO run_tool_results(run_id,step_no,schema_version,status,item_count,expires_at) VALUES ($1,1,1,'ok',0,statement_timestamp()+INTERVAL '60 seconds')",[other.id]);
    const before=await state(f.client);await expect(migrate('test','down',f.schema)).rejects.toThrow('Cannot drop nonempty run_execution_leases');expect(await state(f.client)).toEqual(before);
  }));
  it('in-flight Claim holds parent then Lease; down waits and refuses after Claim commits',async()=>withSchema(async f=>{
    const run=await createRunRepository(f.client).createRun('migration race');let reached!:()=>void;let release!:()=>void;const entered=new Promise<void>(r=>{reached=r;});const gate=new Promise<void>(r=>{release=r;});let holderPid=0;const releases:boolean[]=[];
    const repo=createRunExecutionLeaseRepository(wrap(f.db,async(c,sql,v)=>{if(sql==='COMMIT'){holderPid=await pid(c);reached();await bounded(gate);}return c.query(sql,v);},releases));
    const claim=repo.tryClaimRunLease(run.id,{ownerId:randomUUID(),leaseSeconds:30});void claim.catch(()=>{});let down:Promise<unknown>|undefined;
    try{
      await bounded(entered);const history=(await f.client.query('SELECT * FROM pgmigrations ORDER BY id')).rows;
      down=migrate('test','down',f.schema).then(()=>({ok:true}),()=>({ok:false}));
      await waitFor(async()=>(await f.client.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[holderPid])).rows[0].blocked,'migration table lock');
      release();expect(await claim).not.toBeNull();expect(await down).toEqual({ok:false});const s=await state(f.client);expect(s.history).toEqual(history);expect(s.leases).toHaveLength(1);expect(s.runs[0].status).toBe('running');expect(releases).toEqual([false]);
    }finally{release();await Promise.allSettled([claim,...(down?[down]:[])]);}
  }));
});
