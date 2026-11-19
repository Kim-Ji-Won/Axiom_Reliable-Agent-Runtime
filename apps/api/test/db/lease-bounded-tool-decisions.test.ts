import { z } from 'zod';
import { createToolRegistry } from '../../src/tools/tool-registry.js';
import { createInMemoryToolExecutor } from '../../src/tools/in-memory-tool-executor.js';
import { createRunToolStepRecorder } from '../../src/persistence/run-tool-step-recorder.js';
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
import { runLeaseBoundedToolDecisions as execute, type LeaseToolDependencies } from '../../src/runtime/run-lease-bounded-tool-decisions.js';

const options = { ownerId: randomUUID(), leaseSeconds: 30, maxDecisions: 2, maxToolAttempts: 1 };
const request = { kind: 'tool_request', toolName: 'echo', arguments: { message: 'private argument' } };
const final = { kind: 'final', content: 'done' };
const output = { message: 'private output' };

function repositories(client: PoolClient, db: { connect(): Promise<PoolClient> }) {
  const runs = createRunRepository(client);
  const leases = createRunExecutionLeaseRepository(db);
  const progress = createRunExecutionProgressRepository(db);
  const handler = vi.fn<() => unknown>(() => output);
  const registry = createToolRegistry([{ name: 'echo', inputSchema: z.strictObject({ message: z.string() }) }]);
  const executor = createInMemoryToolExecutor({ registry, handlers: [{ name: 'echo', handle: handler }], permitExecution: () => true });
  const deps = {
    executor: { execute: vi.fn(executor.execute) },
    tryReserveToolAttempt: progress.tryReserveToolAttempt,
    appendToolSucceededStepWithLease: createRunToolStepRecorder(db).appendToolSucceededStepWithLease,
    tryClaimRunLease: leases.tryClaimRunLease,
    initializeProgress: progress.initializeProgress,
    tryReserveDecision: progress.tryReserveDecision,
    tryConfirmCommittedStep: progress.tryConfirmCommittedStep,
    findRunById: runs.findRunById,
    appendContinuedStepWithLease: createRunContinueRecorder(db).appendContinuedStepWithLease,
    tryFinalizeWithStepWithLease: createAtomicRunFinalizer(db).tryFinalizeWithStepWithLease,
    decide: vi.fn<LeaseToolDependencies['decide']>().mockReturnValueOnce(request).mockReturnValue(final),
  };
  return { client, db, deps, runs, progress, leases, handler, registry };
}

async function withSchema(test: (f: ReturnType<typeof repositories>, id: string, checkedOut: () => number) => Promise<void>) {
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
    await test(f, run.id, () => pool.totalCount - pool.idleCount);
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

it('two fresh claims block on one queued row and admit one handler', async () => withSchema(async (f, id) => {
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
  expect(f.deps.decide).toHaveBeenCalledTimes(2);
  expect(f.handler).toHaveBeenCalledTimes(1);
  expect(f.deps.executor.execute).toHaveBeenCalledTimes(1);
  expect(await steps(f.client, id)).toHaveLength(2);
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 4, decisionsReserved: 2, toolAttemptsReserved: 1 });
  console.info('P3-E claim race', { holder, contenders: pids, winners: 1, decisions: 2, executions: 1 });
}));

it.each(['tryReserveDecision', 'tryReserveToolAttempt'] as const)('one contender wins %s and the orchestrator stops', async stage => withSchema(async (f, id) => {
  const reserve = vi.fn<LeaseToolDependencies['tryReserveDecision']>(async (run, auth, version) => {
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
      createRunExecutionProgressRepository(connection(role))[stage](run, auth, version);
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
    expect((await winner)[0]).toMatchObject({ status: 'fulfilled', value: { checkpointVersion: version + 1 } });
    const [lost] = await waiter!;
    if (lost.status === 'rejected') throw lost.reason;
    expect(lost.value).toBeNull();
    console.info('P3-E reservation race', { stage, winnerPid, waiterPid });
    return lost.value;
  });
  expect(await execute(id, { ...f.deps, [stage]: reserve }, options)).toEqual({ kind: stage === 'tryReserveDecision' ? 'decision_admission_conflict' : 'tool_admission_conflict' });
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(f.deps.decide).toHaveBeenCalledTimes(stage === 'tryReserveDecision' ? 0 : 1);
  expect(f.deps.executor.execute).not.toHaveBeenCalled();
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ decisionsReserved: 1, toolAttemptsReserved: stage === 'tryReserveDecision' ? 0 : 1, checkpointVersion: stage === 'tryReserveDecision' ? 1 : 2 });
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

it('observes each committed reservation outside the writer, then verifies metadata-only persistence', async () =>
  withSchema(async (f, id, checkedOut) => {
    const observed: unknown[] = [];
    const snapshots: unknown[] = [];
    f.deps.decide.mockReset().mockImplementation(async (_, context) => {
      expect(checkedOut()).toBe(1); // Only the independent observer holds a connection.
      observed.push(context);
      snapshots.push(await f.progress.getProgressSnapshot(id));
      return observed.length === 1 ? request : final;
    });
    const real = f.deps.executor.execute.getMockImplementation()!;
    let duringTool: unknown;
    f.deps.executor.execute.mockImplementation(async (...args) => {
      expect(checkedOut()).toBe(1);
      duringTool = await f.progress.getProgressSnapshot(id);
      return real(...args);
    });
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'completed', content: 'done' });
    expect(observed).toEqual([{ kind: 'none' }, { kind: 'tool_result', outcome: { kind: 'tool_succeeded', output } }]);
    expect(snapshots).toMatchObject([{ checkpointVersion: 1, decisionsReserved: 1, toolAttemptsReserved: 0, lastConfirmedStepNo: null },
      { checkpointVersion: 4, decisionsReserved: 2, toolAttemptsReserved: 1, lastConfirmedStepNo: 1 }]);
    expect(duringTool).toMatchObject({ checkpointVersion: 2, decisionsReserved: 1, toolAttemptsReserved: 1, maxStepNo: null });
    expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: 'tool_succeeded' }, { step_no: 2, result_kind: 'completed' }]);
    expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 4, decisionsReserved: 2,
      toolAttemptsReserved: 1, lastConfirmedStepNo: 1, diagnostic: 'steps_ahead', runStatus: 'completed' });
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect((await f.client.query('SELECT * FROM run_tool_results WHERE run_id=$1', [id])).rowCount).toBe(0);
    for (const table of ['run_execution_progress', 'run_steps']) {
      const stored = JSON.stringify((await f.client.query(`SELECT * FROM ${table} WHERE run_id=$1`, [id])).rows);
      for (const marker of ['private output', 'private argument', 'private task']) expect(stored).not.toContain(marker);
    }
  }));

const losses = [
  // stage, decision calls, handler calls, committed version, step count, watermark
  ['tryClaimRunLease', 0, 0, null, 0, null],
  ['initializeProgress', 0, 0, 0, 0, null],
  ['tryReserveDecision', 0, 0, 1, 0, null],
  ['tryReserveToolAttempt', 1, 0, 2, 0, null],
  ['appendToolSucceededStepWithLease', 1, 1, 2, 1, null],
  ['tryConfirmCommittedStep', 1, 1, 3, 1, 1],
  ['tryFinalizeWithStepWithLease', 2, 1, 4, 2, 1],
] as const;
it.each(losses)('drops %s response after actual COMMIT and denies re-entry', async (stage, decisions, executions, version, count, watermark) =>
  withSchema(async (f, id) => {
    const lost = new Error('Unconfirmed write');
    const interrupted = vi.fn(async (...args: unknown[]) => {
      const committed = await Reflect.apply(f.deps[stage], undefined, args);
      if (!committed) throw new Error('Expected committed write');
      throw lost;
    });
    await expect(execute(id, { ...f.deps, [stage]: interrupted }, options)).rejects.toBe(lost);
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
    expect(f.deps.decide).toHaveBeenCalledTimes(decisions);
    expect(f.handler).toHaveBeenCalledTimes(executions);
    expect(f.deps.executor.execute).toHaveBeenCalledTimes(executions);
    expect(await steps(f.client, id)).toHaveLength(count);
    expect((await f.runs.findRunById(id))?.status).toBe(count === 2 ? 'completed' : 'running');
    const snapshot = await f.progress.getProgressSnapshot(id);
    if (version === null) expect(snapshot).toBeNull();
    else expect(snapshot).toMatchObject({ checkpointVersion: version, toolAttemptsReserved: version >= 2 ? 1 : 0,
      decisionsReserved: version === 4 ? 2 : Math.min(1, version), lastConfirmedStepNo: watermark,
      diagnostic: count > (watermark ?? 0) ? 'steps_ahead' : 'aligned' });
  }));

it('unconfirmed tool step remains ahead; no automatic confirmation or replay', async () => withSchema(async (f, id) => {
  const confirm = vi.fn(async () => null);
  expect(await execute(id, { ...f.deps, tryConfirmCommittedStep: confirm }, options)).toEqual({ kind: 'checkpoint_conflict' });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
  expect(f.handler).toHaveBeenCalledTimes(1);
  expect(f.deps.decide).toHaveBeenCalledTimes(1);
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 2, lastConfirmedStepNo: null, diagnostic: 'steps_ahead' });
}));

it('loses executor response after the pure handler returns; no success step or second invocation', async () =>
  withSchema(async (f, id) => {
    const real = f.deps.executor.execute.getMockImplementation()!;
    f.deps.executor.execute.mockImplementation(async (...args) => {
      await real(...args);
      throw new Error('Undelivered output');
    });
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'tool_failed', code: 'execution_unavailable' });
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(f.deps.executor.execute).toHaveBeenCalledTimes(1);
    expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: 'tool_failed' }]);
    expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 2, toolAttemptsReserved: 1, lastConfirmedStepNo: null });
  }));

it.each(['before reservation', 'during handler'] as const)('observes database lease expiry %s', async phase =>
  withSchema(async (f, id) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    if (phase === 'before reservation') f.deps.decide.mockReset().mockImplementationOnce(async () => {
      entered = true; await gate; return request;
    });
    else f.handler.mockImplementationOnce(async () => { entered = true; await gate; return output; });
    const job = Promise.allSettled([execute(id, f.deps, { ...options, leaseSeconds: 1 })]);
    try {
      await waitForDb(async () => entered && (await f.client.query(
        'SELECT clock_timestamp() >= expires_at AS expired FROM run_execution_leases WHERE run_id=$1', [id])).rows[0]?.expired);
    } finally { release(); await job; }
    const attempted = phase === 'during handler' ? 1 : 0;
    expect((await job)[0]).toMatchObject({ status: 'fulfilled', value: { kind: attempted ? 'step_persistence_conflict' : 'tool_admission_conflict' } });
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
    expect(f.deps.executor.execute).toHaveBeenCalledTimes(attempted);
    expect(f.handler).toHaveBeenCalledTimes(attempted);
    expect(f.deps.decide).toHaveBeenCalledTimes(1);
    expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ runStatus: 'running', leaseState: 'expired',
      decisionsReserved: 1, toolAttemptsReserved: attempted, checkpointVersion: 1 + attempted, maxStepNo: null });
  }));

it.each([
  [1, 1, 'decision_limit_exceeded', 0], [2, 0, 'tool_execution_limit_exceeded', 0],
  [2, 1, 'decision_limit_exceeded', 1], [3, 1, 'tool_execution_limit_exceeded', 1],
] as const)('enforces %i decisions and %i attempts', async (max, tools, kind, calls) => withSchema(async (f, id) => {
  f.deps.decide.mockReset().mockReturnValue(request);
  expect(await execute(id, f.deps, { ...options, maxDecisions: max, maxToolAttempts: tools })).toEqual({ kind });
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ toolAttemptsReserved: calls, decisionsReserved: 1 + calls });
  expect(f.handler).toHaveBeenCalledTimes(calls);
}));

it.each(['preflight', 'default deny', 'invalid output', 'handler failure'] as const)('records %s with no refund', async mode =>
  withSchema(async (f, id) => {
    if (mode === 'preflight') f.deps.decide.mockReset().mockReturnValue({ ...request, toolName: 'absent' });
    if (mode === 'default deny') f.deps.executor.execute.mockImplementation(createInMemoryToolExecutor({
      registry: f.registry, handlers: [{ name: 'echo', handle: f.handler }],
    }).execute);
    if (mode === 'invalid output') f.handler.mockReturnValue(42);
    if (mode === 'handler failure') f.handler.mockImplementation(() => { throw new Error('private'); });
    const kind = mode === 'preflight' ? 'tool_request_rejected' : 'tool_failed';
    const code = mode === 'default deny' ? 'execution_unavailable' : mode === 'invalid output' ? 'invalid_tool_output' : 'handler_error';
    expect(await execute(id, f.deps, options)).toEqual(mode === 'preflight' ? { kind } : { kind, code });
    expect(f.handler).toHaveBeenCalledTimes(mode === 'invalid output' || mode === 'handler failure' ? 1 : 0);
    expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ toolAttemptsReserved: 1, checkpointVersion: 2 });
    expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: kind }]);
  }));


it.each([1, 2, 3, 4, 5])('confirms every continued slot up to the decision limit %i', async max =>
  withSchema(async (f, id) => {
    f.deps.decide.mockReset().mockReturnValue({ kind: 'continue' });
    expect(await execute(id, f.deps, { ...options, maxDecisions: max })).toEqual({ kind: 'decision_limit_exceeded' });
    expect(f.deps.decide).toHaveBeenCalledTimes(max);
    expect(f.handler).not.toHaveBeenCalled();
    expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ decisionsReserved: max, toolAttemptsReserved: 0,
      checkpointVersion: 2 * max - 1, lastConfirmedStepNo: max === 1 ? null : max - 1, maxStepNo: max });
  }));
