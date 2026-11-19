import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';
import { migrate } from '../../../../db/migrate.js';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository } from '../../src/persistence/run-repository.js';
import { createRunExecutionLeaseRepository } from '../../src/persistence/run-execution-lease-repository.js';
import { createRunExecutionProgressRepository } from '../../src/persistence/run-execution-progress-repository.js';
import { createRunContinueRecorder } from '../../src/persistence/run-continue-recorder.js';
import { createAtomicRunFinalizer } from '../../src/persistence/atomic-run-finalizer.js';
import { runLeaseBoundedDecisions as execute, type LeaseDecisionDependencies } from '../../src/runtime/run-lease-bounded-decisions.js';

const options = { ownerId: randomUUID(), leaseSeconds: 30, maxDecisions: 2 };
function repositories(client: PoolClient, db: { connect(): Promise<PoolClient> }) {
  const runs = createRunRepository(client);
  const leases = createRunExecutionLeaseRepository(db);
  const progress = createRunExecutionProgressRepository(db);
  const deps = {
    tryClaimRunLease: leases.tryClaimRunLease,
    initializeProgress: progress.initializeProgress,
    tryReserveDecision: progress.tryReserveDecision,
    tryConfirmCommittedStep: progress.tryConfirmCommittedStep,
    findRunById: runs.findRunById,
    appendContinuedStepWithLease: createRunContinueRecorder(db).appendContinuedStepWithLease,
    tryFinalizeWithStepWithLease: createAtomicRunFinalizer(db).tryFinalizeWithStepWithLease,
    decide: vi.fn<LeaseDecisionDependencies['decide']>().mockReturnValue({ kind: 'final', content: 'private result' }),
  };
  return { client, db, deps, runs, progress, leases };
}

async function withSchema(test: (f: ReturnType<typeof repositories>, id: string) => Promise<void>) {
  const pool = createDatabase(readDatabaseUrl('test'));
  const schema = 'axiom_test_' + randomUUID().replaceAll('-', '');
  let observer: PoolClient | undefined;
  let created = false;
  try {
    observer = await pool.connect();
    await assertDatabaseIdentity(observer, 'test');
    await observer.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const scope = async (client: PoolClient) => {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("SET statement_timeout TO '5s'");
    };
    await scope(observer);
    await migrate('test', 'up', schema);
    const db = { async connect() {
      const client = await pool.connect();
      try { await assertDatabaseIdentity(client, 'test'); await scope(client); return client; }
      catch (error) { client.release(true); throw error; }
    } };
    const f = repositories(observer, db);
    const run = await f.runs.createRun('private task');
    await test(f, run.id);
    expect(pool.totalCount - pool.idleCount).toBe(1);
  } finally {
    try { if (created) await observer!.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { observer?.release(); await pool.end(); }
  }
}

async function steps(client: PoolClient, id: string) {
  return (await client.query('SELECT step_no, result_kind FROM run_steps WHERE run_id=$1 ORDER BY step_no', [id])).rows;
}
async function waitForDb(check: () => Promise<boolean>) {
  const end = performance.now() + 4000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (performance.now() < end);
  throw new Error('Database barrier timeout');
}

it.each([
  ['completed', { kind: 'final', content: 'private result' }],
  ['invalid_decision', { kind: 'invalid', private: 'secret' }],
  ['unsupported_tool_request', { kind: 'tool_request', toolName: 'test_tool', arguments: {} }],
  ['decision_source_error', null],
] as const)('one reservation and one terminal %s Step', async (kind, raw) => withSchema(async (f, id) => {
  f.deps.decide.mockImplementation(() => {
    if (raw === null) throw new Error('private error');
    return raw;
  });
  const result = await execute(id, f.deps, { ...options, maxDecisions: 1 });
  expect(result).toEqual(kind === 'completed' ? { kind, content: 'private result' } : { kind });
  expect((await f.runs.findRunById(id))?.status).toBe(kind === 'completed' ? 'completed' : 'failed');
  expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: kind }]);
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 1, lastConfirmedStepNo: null,
    decisionsReserved: 1, maxToolAttempts: 0, toolAttemptsReserved: 0, leaseState: 'run_not_running', diagnostic: 'steps_ahead' });
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
  expect(f.deps.decide).toHaveBeenCalledTimes(1);
}));

it('five reservations with four acknowledged watermarks before the limit', async () => withSchema(async (f, id) => {
  let count = 0;
  f.deps.decide.mockImplementation(async () => {
    count++;
    const snapshot = await f.progress.getProgressSnapshot(id);
    expect(snapshot).toMatchObject({ checkpointVersion: 2 * count - 1, decisionsReserved: count, diagnostic: 'aligned',
      lastConfirmedStepNo: count === 1 ? null : count - 1 });
    return { kind: 'continue' };
  });
  expect(await execute(id, f.deps, { ...options, maxDecisions: 5 })).toEqual({ kind: 'decision_limit_exceeded' });
  expect(count).toBe(5);
  expect(await steps(f.client, id)).toEqual(Array.from({ length: 5 }, (_, i) => ({
    step_no: i + 1, result_kind: i === 4 ? 'decision_limit_exceeded' : 'continued',
  })));
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 9, decisionsReserved: 5,
    lastConfirmedStepNo: 4, maxStepNo: 5, diagnostic: 'steps_ahead' });
}));

it('two independent claim writers block on one queued row and admit one callback', async () => withSchema(async (f, id) => {
  const { rows: [{ pid: holder }] } = await f.client.query('SELECT pg_backend_pid() AS pid');
  const pids: number[] = [];
  const leases = createRunExecutionLeaseRepository({ async connect() {
    const client = await f.db.connect();
    try {
      pids.push((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return client;
    } catch (err) { client.release(true); throw err; }
  } });
  const deps = { ...f.deps, tryClaimRunLease: leases.tryClaimRunLease };
  await f.client.query('BEGIN');
  let jobs: Promise<PromiseSettledResult<Awaited<ReturnType<typeof execute>>>[]> | undefined;
  try {
    await f.client.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE', [id]);
    jobs = Promise.allSettled([execute(id, deps, options), execute(id, deps, { ...options, ownerId: randomUUID() })]);
    await waitForDb(async () => {
      if (new Set(pids).size !== 2) return false;
      const { rows } = await f.client.query('SELECT pg_blocking_pids(pid) AS blockers FROM unnest($1::int[]) AS pid', [pids]);
      return rows.every(row => row.blockers.some((p: number) => p === holder || pids.includes(p))) &&
        rows.some(row => row.blockers.includes(holder));
    });
  } finally { await f.client.query('ROLLBACK'); await jobs; }
  const results = await jobs!;
  expect(results.map(r => r.status === 'fulfilled' && r.value.kind).sort()).toEqual(['completed', 'not_started']);
  expect(f.deps.decide).toHaveBeenCalledTimes(1);
  expect(await steps(f.client, id)).toHaveLength(1);
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 1, decisionsReserved: 1 });
  console.info('P3-D claim race', { holder, contenders: pids, winners: 1, callbacks: 1 });
}));

it('DB clock crosses expiry during the callback; the reservation survives refusal', async () => withSchema(async (f, id) => {
  let expired = false;
  f.deps.decide.mockImplementation(async () => {
    await waitForDb(async () => (await f.client.query(
      'SELECT clock_timestamp() >= expires_at AS expired FROM run_execution_leases WHERE run_id=$1', [id])).rows[0].expired);
    expired = true;
    return { kind: 'final', content: 'late' };
  });
  expect(await execute(id, f.deps, { ...options, leaseSeconds: 1 })).toEqual({ kind: 'finalize_conflict' });
  expect(expired).toBe(true);
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ runStatus: 'running', leaseState: 'expired',
    decisionsReserved: 1, checkpointVersion: 1, maxStepNo: null });
  expect(f.deps.decide).toHaveBeenCalledTimes(1);
}));

it('a competing same-credential reservation wins the version CAS while the caller waits', async () => withSchema(async (f, id) => {
  const reserve = vi.fn<LeaseDecisionDependencies['tryReserveDecision']>(async (run, auth, version) => {
    let winnerPid = 0;
    let waiterPid = 0;
    let releaseCommit!: () => void;
    const gate = new Promise<void>(resolve => { releaseCommit = resolve; });
    let atCommit = false;
    function connection(role: 'winner' | 'waiter') {
      return { async connect() {
        const client = await f.db.connect();
        try {
          const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          if (role === 'winner') winnerPid = pid;
          else waiterPid = pid;
          return {
            query: (async (sql: string, values?: unknown[]) => {
              if (role === 'winner' && sql === 'COMMIT') {
                atCommit = true;
                await gate;
              }
              return client.query(sql, values);
            }) as PoolClient['query'],
            release: (discard?: boolean) => client.release(discard),
          };
        } catch (error) { client.release(true); throw error; }
      } };
    }
    const attempt = (role: 'winner' | 'waiter') =>
      createRunExecutionProgressRepository(connection(role)).tryReserveDecision(run, auth, version);
    const winner = Promise.allSettled([attempt('winner')]);
    let waiter: typeof winner | undefined;
    try {
      await waitForDb(async () => atCommit);
      waiter = Promise.allSettled([attempt('waiter')]);
      await waitForDb(async () => waiterPid !== 0 && (await f.client.query(
        'SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked', [winnerPid, waiterPid])).rows[0].blocked);
    } finally {
      releaseCommit();
      await Promise.all([winner, waiter]);
    }
    expect(winnerPid).not.toBe(waiterPid);
    expect((await winner)[0]).toMatchObject({ status: 'fulfilled', value: { checkpointVersion: 1 } });
    const [lost] = await waiter!;
    if (lost.status === 'rejected') throw lost.reason;
    console.info('P3-D reservation race', { winnerPid, waiterPid });
    return lost.value;
  });
  expect(await execute(id, { ...f.deps, tryReserveDecision: reserve }, options)).toEqual({ kind: 'decision_admission_conflict' });
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(f.deps.decide).not.toHaveBeenCalled();
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ decisionsReserved: 1, checkpointVersion: 1 });
}));


// Drop only the acknowledgment delivered to this caller, after the real repository has committed.
const interruptions = [
  ['tryClaimRunLease', 0, null, 0], ['initializeProgress', 0, 0, 0], ['tryReserveDecision', 0, 1, 0],
  ['appendContinuedStepWithLease', 1, 1, 1], ['tryConfirmCommittedStep', 1, 2, 1], ['tryFinalizeWithStepWithLease', 1, 1, 1],
] as const;
it.each(interruptions)('lost %s acknowledgement leaves committed state and denies re-entry', async (stage, calls, version, nSteps) =>
  withSchema(async (f, id) => {
    if (stage !== 'tryFinalizeWithStepWithLease') f.deps.decide.mockReturnValue({ kind: 'continue' });
    const lost = new Error('Unconfirmed write');
    const interrupted = vi.fn(async (...args: unknown[]) => {
      const value = await Reflect.apply(f.deps[stage], undefined, args);
      if (!value) throw new Error('Expected a committed write');
      throw lost;
    });
    await expect(execute(id, { ...f.deps, [stage]: interrupted }, options)).rejects.toBe(lost);
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
    expect(f.deps.decide).toHaveBeenCalledTimes(calls);
    expect(await steps(f.client, id)).toHaveLength(nSteps);
    expect((await f.runs.findRunById(id))?.status).toBe(stage === 'tryFinalizeWithStepWithLease' ? 'completed' : 'running');
    const snapshot = await f.progress.getProgressSnapshot(id);
    if (version === null) expect(snapshot).toBeNull();
    else expect(snapshot).toMatchObject({ checkpointVersion: version, decisionsReserved: version === 0 ? 0 : 1,
      lastConfirmedStepNo: stage === 'tryConfirmCommittedStep' ? 1 : null,
      diagnostic: nSteps && stage !== 'tryConfirmCommittedStep' ? 'steps_ahead' : 'aligned' });
  }));

it('refused confirmation preserves Step ahead and ends the invocation', async () => withSchema(async (f, id) => {
  f.deps.decide.mockReturnValue({ kind: 'continue' });
  const refuse = vi.fn(async () => null);
  expect(await execute(id, { ...f.deps, tryConfirmCommittedStep: refuse }, options)).toEqual({ kind: 'checkpoint_conflict' });
  expect(refuse).toHaveBeenCalledTimes(1);
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 1, lastConfirmedStepNo: null,
    maxStepNo: 1, diagnostic: 'steps_ahead' });
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
  expect(f.deps.decide).toHaveBeenCalledTimes(1);
}));

it('missing or legacy-started runs cannot enter the protocol', async () => withSchema(async (f, id) => {
  await f.runs.tryStartRun(id);
  for (const runId of [id, randomUUID()]) {
    expect(await execute(runId, f.deps, options)).toEqual({ kind: 'not_started' });
    expect(await f.progress.getProgressSnapshot(runId)).toBeNull();
  }
  expect(f.deps.decide).not.toHaveBeenCalled();
}));

it('a preexisting Step prevents initialization after a fresh claim', async () => withSchema(async (f, id) => {
  await f.client.query("INSERT INTO run_steps(run_id, step_no, result_kind) VALUES ($1, 1, 'continued')", [id]);
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'initialization_conflict' });
  expect((await f.runs.findRunById(id))?.status).toBe('running');
  expect(await f.progress.getProgressSnapshot(id)).toBeNull();
  expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: 'continued' }]);
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
  expect(f.deps.decide).not.toHaveBeenCalled();
}));
