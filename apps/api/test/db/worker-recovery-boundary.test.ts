import { createRunCancellationRepository } from '../../src/persistence/run-cancellation-repository.js';
import { createRunStepRepository } from '../../src/persistence/run-step-repository.js';
import { createToolApprovalGrant, createToolApprovalPermit, inspectToolApprovalGrant } from '../../src/tools/tool-approval-grant.js';
import { createToolAuthorizationPolicy } from '../../src/tools/tool-authorization-policy.js';
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
import type { LeaseToolDependencies } from '../../src/runtime/run-lease-bounded-tool-decisions.js';

import { runOneShotWorker as execute } from '../../src/runtime/run-one-shot-worker.js';
import { createRunRecoveryInspectionRepository } from '../../src/persistence/run-recovery-inspection-repository.js';

const options = { mode: 'tool_enabled', ownerId: randomUUID(), leaseSeconds: 30, maxDecisions: 2, maxToolAttempts: 1 } as const;
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
    tryClaimRunLease: vi.fn(leases.tryClaimRunLease),
    initializeProgress: progress.initializeProgress,
    tryReserveDecision: progress.tryReserveDecision,
    tryConfirmCommittedStep: progress.tryConfirmCommittedStep,
    findRunById: runs.findRunById,
    appendContinuedStepWithLease: createRunContinueRecorder(db).appendContinuedStepWithLease,
    tryFinalizeWithStepWithLease: createAtomicRunFinalizer(db).tryFinalizeWithStepWithLease,
    decide: vi.fn<LeaseToolDependencies['decide']>().mockReturnValueOnce(request).mockReturnValue(final),
  };
  return { client, db, deps, runs, progress, leases, handler, inspect: createRunRecoveryInspectionRepository(client).inspectRunRecovery };
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
  const other = repositories(f.client, f.db);
  const workers = [f, other].map(worker => ({ ...worker.deps, tryClaimRunLease: vi.fn(leases.tryClaimRunLease) }));
  expect(await f.inspect(id)).toMatchObject({ category: 'queued_observed' });
  await f.client.query('BEGIN');
  let jobs: Promise<PromiseSettledResult<Awaited<ReturnType<typeof execute>>>[]> | undefined;
  try {
    await f.client.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE', [id]);
    jobs = Promise.allSettled([execute(id, workers[0]!, options), execute(id, workers[1]!, { ...options, ownerId: randomUUID() })]);
    await waitForDb(async () => {
      if (new Set(pids).size !== 2) return false;
      const { rows } = await f.client.query('SELECT pg_blocking_pids(pid) AS blockers FROM unnest($1::int[]) AS pid', [pids]);
      return rows.every(row => row.blockers.some((p: number) => p === holder || pids.includes(p))) &&
        rows.some(row => row.blockers.includes(holder));
    });
  } finally { await f.client.query('ROLLBACK'); await jobs; }
  const results = await jobs!;
  expect(results.map(r => r.status === 'fulfilled' && r.value.kind).sort()).toEqual(['completed', 'not_started']);
  for (const [i, worker] of [f, other].entries()) {
    const settled = results[i]!;
    if (settled.status !== 'fulfilled') throw new Error('Worker unexpectedly rejected');
    const won = settled.value.kind === 'completed';
    expect(workers[i]!.tryClaimRunLease).toHaveBeenCalledTimes(1);
    expect(worker.deps.decide).toHaveBeenCalledTimes(won ? 2 : 0);
    expect(worker.deps.executor.execute).toHaveBeenCalledTimes(won ? 1 : 0);
    expect(worker.handler).toHaveBeenCalledTimes(won ? 1 : 0);
  }
  expect(await f.inspect(id)).toMatchObject({ category: 'terminal_observed', ambiguousToolAttempt: false,
    unconfirmedNonterminalStep: false, steps: { count: 2, lastKind: 'completed' } });
  expect(await steps(f.client, id)).toHaveLength(2);
  expect(await f.progress.getProgressSnapshot(id)).toMatchObject({ checkpointVersion: 4, decisionsReserved: 2, toolAttemptsReserved: 1 });
  console.info('P3-F worker claim race', { holder, contenders: pids, winners: 1, decisions: 2, executions: 1 });
}));


const losses = [
  // Observations after the repository committed and before the caller received its response.
  ['tryClaimRunLease', 'claimed_without_progress', null, 0, 0, 0],
  ['initializeProgress', 'active_lease_unverified', 0, 0, 0, 0],
  ['tryReserveDecision', 'active_lease_unverified', 1, 0, 0, 0],
  ['tryReserveToolAttempt', 'ambiguous_attempt_manual_review', 2, 1, 0, 0],
  ['appendToolSucceededStepWithLease', 'unconfirmed_step_manual_review', 2, 1, 1, 1],
  ['tryConfirmCommittedStep', 'active_lease_unverified', 3, 1, 1, 1],
  ['tryFinalizeWithStepWithLease', 'terminal_observed', 4, 2, 1, 2],
] as const;
it.each(losses)('inspects after losing the %s COMMIT response', async (stage, category, version, decisions, tools, count) =>
  withSchema(async (f, id) => {
    const lost = new Error('Test-owned acknowledgement loss');
    const interrupted = vi.fn(async (...args: unknown[]) => {
      if (!await Reflect.apply(f.deps[stage], undefined, args)) throw new Error('Expected committed write');
      throw lost;
    });
    await expect(execute(id, { ...f.deps, [stage]: interrupted }, options)).rejects.toBe(lost);
    expect(interrupted).toHaveBeenCalledTimes(1);
    const before = await f.inspect(id);
    expect(before).toMatchObject({ category, status: version === 4 ? 'completed' : 'running',
      steps: { count }, ambiguousToolAttempt: stage === 'tryReserveToolAttempt',
      unconfirmedNonterminalStep: stage === 'appendToolSucceededStepWithLease',
      progress: version === null ? null : { checkpointVersion: version, decisionsReserved: version === 4 ? 2 : Math.min(version, 1),
        toolAttemptsReserved: version >= 2 ? 1 : 0, lastConfirmedStepNo: version >= 3 ? 1 : null } });
    expect(f.deps.tryClaimRunLease).toHaveBeenCalledTimes(1);
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
    expect(f.deps.tryClaimRunLease).toHaveBeenCalledTimes(2); // One fresh attempt per explicit invocation.
    expect(await f.inspect(id)).toEqual(before);
    expect(f.deps.decide).toHaveBeenCalledTimes(decisions);
    expect(f.deps.executor.execute).toHaveBeenCalledTimes(tools);
    expect(f.handler).toHaveBeenCalledTimes(tools);
  }));

it('retains ambiguous effect evidence beside a valid failed terminal step', async () => withSchema(async (f, id) => {
  const real = f.deps.executor.execute.getMockImplementation()!;
  f.deps.executor.execute.mockImplementation(async (...args) => { await real(...args); throw new Error('Undelivered outcome'); });
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'tool_failed', code: 'execution_unavailable' });
  expect(await f.inspect(id)).toMatchObject({ category: 'terminal_observed', status: 'failed', ambiguousToolAttempt: true,
    unconfirmedNonterminalStep: false, progress: { checkpointVersion: 2, toolAttemptsReserved: 1, lastConfirmedStepNo: null },
    steps: { count: 1, maxStepNo: 1, lastKind: 'tool_failed' } });
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
  expect(f.handler).toHaveBeenCalledTimes(1);
  expect(f.deps.decide).toHaveBeenCalledTimes(1);
}));

it.each([false, true])('triages DB-clock expiry with unconfirmed continued Step=%s', async ahead =>
  withSchema(async (f, id) => {
    const claim = await f.leases.tryClaimRunLease(id, { ownerId: options.ownerId, leaseSeconds: 1 });
    if (!claim) throw new Error('Expected fresh claim');
    const auth = { ownerId: claim.ownerId, leaseToken: claim.leaseToken };
    await f.progress.initializeProgress(id, auth, { maxDecisions: 2, maxToolAttempts: 0 });
    if (ahead) {
      await f.progress.tryReserveDecision(id, auth, 0);
      await f.deps.appendContinuedStepWithLease(id, auth);
    }
    await waitForDb(async () => (await f.client.query('SELECT clock_timestamp() >= expires_at AS expired FROM run_execution_leases WHERE run_id=$1', [id])).rows[0].expired);
    const state = await f.inspect(id);
    expect(state).toMatchObject({ category: ahead ? 'unconfirmed_step_manual_review' : 'expired_lease_manual_review',
      lease: 'expired', status: 'running', unconfirmedNonterminalStep: ahead, progress: { lastConfirmedStepNo: null } });
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
    expect(await f.inspect(id)).toEqual(state);
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.deps.decide).not.toHaveBeenCalled();
  }));

it('inspects missing, queued, and legacy-running evidence separately', async () => withSchema(async (f, id) => {
  expect(await f.inspect(randomUUID())).toEqual({ category: 'missing_run' });
  expect(await f.inspect(id)).toMatchObject({ category: 'queued_observed', lease: 'absent', progress: null, steps: { count: 0 } });
  await f.runs.tryStartRun(id);
  expect(await f.inspect(id)).toMatchObject({ category: 'legacy_or_inconsistent_manual_review', status: 'running', progress: null });
}));

it('repeated READ ONLY observations leave row versions, counters and timestamps intact', async () => withSchema(async (f, id) => {
  expect(await execute(id, f.deps, options)).toEqual({ kind: 'completed', content: 'done' });
  const tables = [
    ['runs', 'id', 'status, created_at::text'],
    ['run_execution_leases', 'run_id', 'acquired_at::text, renewed_at::text, expires_at::text'],
    ['run_execution_progress', 'run_id', 'checkpoint_version, decisions_reserved, tool_attempts_reserved, last_confirmed_step_no, created_at::text, updated_at::text'],
    ['run_steps', 'run_id', 'step_no, result_kind, created_at::text'],
    ['run_tool_results', 'run_id', 'step_no'],
  ] as const;
  async function versions() {
    const result = [];
    for (const [table, key, fields] of tables) result.push((await f.client.query(
      `SELECT xmin::text, ctid::text, ${fields} FROM ${table} WHERE ${key}=$1 ORDER BY ctid`, [id])).rows);
    return result;
  }
  const before = await versions();
  const statements: string[] = [];
  const reader = createRunRecoveryInspectionRepository({ query: (async (sql: string, args: unknown[]) => {
    statements.push(sql);
    return f.client.query(sql, args);
  }) as PoolClient['query'] });
  await f.client.query('BEGIN READ ONLY');
  try {
    const state = await reader.inspectRunRecovery(id);
    expect(await reader.inspectRunRecovery(id)).toEqual(state);
    expect(state).toMatchObject({ category: 'terminal_observed' });
    expect(JSON.stringify(state)).not.toMatch(/private|leaseToken|ownerId|credentials|output/);
  } finally { await f.client.query('ROLLBACK'); }
  expect(statements).toHaveLength(2);
  for (const sql of statements) {
    expect(sql).not.toMatch(/\b(update|insert|delete|lock|task|owner_id|lease_token|output|arguments)\b|for\s+share/i);
    expect(sql.match(/clock_timestamp\(\)/gi)).toHaveLength(1);
  }
  expect(await versions()).toEqual(before);
  expect(f.deps.decide).toHaveBeenCalledTimes(2);
  expect(f.handler).toHaveBeenCalledTimes(1);
}));

it('sees both Run and Step before or after terminal COMMIT in an independent snapshot', async () => withSchema(async (f, id) => {
  const claim = await f.leases.tryClaimRunLease(id, { ownerId: options.ownerId, leaseSeconds: 30 });
  if (!claim) throw new Error('Expected fresh claim');
  const auth = { ownerId: claim.ownerId, leaseToken: claim.leaseToken };
  await f.progress.initializeProgress(id, auth, { maxDecisions: 1, maxToolAttempts: 0 });
  await f.progress.tryReserveDecision(id, auth, 0);
  const readerPid = (await f.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  let writerPid: number | undefined;
  let signal!: () => void;
  let resume!: () => void;
  const atCommit = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const finalizer = createAtomicRunFinalizer({ async connect() {
    const client = await f.db.connect();
    try { writerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; }
    catch (error) { client.release(true); throw error; }
    return { query: (async (sql: string, args?: unknown[]) => {
      if (sql === 'COMMIT') { signal(); await gate; }
      return client.query(sql, args);
    }) as PoolClient['query'], release: (discard?: boolean) => client.release(discard) };
  } });
  await f.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const job = finalizer.tryFinalizeWithStepWithLease(id, 'completed', auth);
  try {
    await Promise.race([atCommit, job.then(() => { throw new Error('Missing commit barrier'); })]);
    expect(readerPid).not.toBe(writerPid);
    const before = await f.inspect(id);
    expect(before).toMatchObject({ category: 'active_lease_unverified', status: 'running', lease: 'active',
      progress: { checkpointVersion: 1 }, steps: { count: 0, lastKind: null } });
    resume();
    expect(await job).not.toBeNull();
    expect(await f.inspect(id)).toEqual(before);
  } finally {
    resume();
    try { await job; } finally { await f.client.query('ROLLBACK'); }
  }
  expect(await f.inspect(id)).toMatchObject({ category: 'terminal_observed', status: 'completed', lease: 'active',
    progress: { checkpointVersion: 1, lastConfirmedStepNo: null }, steps: { count: 1, lastKind: 'completed' } });
  console.info('P3-F snapshot', { readerPid, writerPid, isolation: 'repeatable read' });
}));

it('cannot distinguish handler completion from an unused reservation before the Tool Step', async () =>
  withSchema(async (f, id) => {
    const interrupted = new Error('Stopped before appending');
    const stop = vi.fn(async () => { throw interrupted; });
    await expect(execute(id, { ...f.deps, appendToolSucceededStepWithLease: stop }, options)).rejects.toBe(interrupted);
    expect(stop).toHaveBeenCalledTimes(1);
    const state = await f.inspect(id);
    expect(state).toMatchObject({ category: 'ambiguous_attempt_manual_review', status: 'running', ambiguousToolAttempt: true,
      progress: { checkpointVersion: 2, decisionsReserved: 1, toolAttemptsReserved: 1 }, steps: { count: 0 } });
    expect(await execute(id, f.deps, options)).toEqual({ kind: 'not_started' });
    expect(await f.inspect(id)).toEqual(state);
    expect(f.deps.decide).toHaveBeenCalledTimes(1);
    expect(f.deps.executor.execute).toHaveBeenCalledTimes(1);
    expect(f.handler).toHaveBeenCalledTimes(1);
  }));

it.each(['future renewal', 'missing first step', 'wrong terminal'] as const)(
  'observes %s in a disposable schema without changing constraints', async mode => withSchema(async (f, id) => {
    const claim = await f.leases.tryClaimRunLease(id, { ownerId: options.ownerId, leaseSeconds: 30 });
    if (!claim) throw new Error('Expected fresh claim');
    await f.progress.initializeProgress(id, { ownerId: claim.ownerId, leaseToken: claim.leaseToken }, { maxDecisions: 2, maxToolAttempts: 0 });
    if (mode === 'future renewal') {
      await f.client.query(`UPDATE run_execution_leases SET renewed_at=renewed_at+interval '1 day',
        expires_at=expires_at+interval '1 day' WHERE run_id=$1`, [id]);
    } else if (mode === 'missing first step') {
      await f.client.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,2,'continued')", [id]);
    } else {
      await f.client.query("UPDATE runs SET status='failed' WHERE id=$1", [id]);
      await f.client.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,1,'completed')", [id]);
    }
    expect(await f.inspect(id)).toMatchObject({ category: 'legacy_or_inconsistent_manual_review',
      lease: mode === 'future renewal' ? 'invalid_clock' : 'active' });
    expect(f.deps.decide).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  }));

type CancellationFixture = ReturnType<typeof repositories>;
type CancellationDb = Pick<CancellationFixture['db'], 'connect'>;

function latch() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

// Intercept transaction control on a real, exclusively checked-out backend.
function observeConnection(db: CancellationDb, beforeCommit?: () => Promise<void>, afterCommit?: () => void) {
  const releases: boolean[] = [];
  let pid = 0;
  const observed = { async connect() {
    const client = await db.connect();
    try { pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; }
    catch (error) { client.release(true); throw error; }
    return {
      query: (async (sql: string, args?: unknown[]) => {
        if (sql === 'COMMIT') await beforeCommit?.();
        const result = await client.query(sql, args);
        if (sql === 'COMMIT') afterCommit?.();
        return result;
      }) as PoolClient['query'],
      release(discard?: boolean | Error) { releases.push(Boolean(discard)); client.release(discard); },
    };
  } };
  return { db: observed, pid: () => pid, releases };
}

it.each([
  ['cancel', 'cancel'], ['cancel', 'claim'], ['claim', 'cancel'], ['cancel', 'finish'], ['finish', 'cancel'],
  ['cancel', 'reserve'], ['reserve', 'cancel'], ['cancel', 'append'], ['cancel', 'downgrade'],
] as const)('serializes %s before %s on independent PostgreSQL backends', async (first, second) =>
  withSchema(async (f, id) => {
    const legacyRunning = first === 'finish' || second === 'finish';
    if (legacyRunning) expect(await f.runs.tryStartRun(id)).not.toBeNull();
    const reservation = first === 'reserve' || second === 'reserve';
    const claimArgs = { ownerId: options.ownerId, leaseSeconds: 30 };
    const claim = reservation ? await f.leases.tryClaimRunLease(id, claimArgs) : null;
    const auth = { ownerId: options.ownerId, leaseToken: claim?.leaseToken ?? '' };
    if (reservation) expect(await f.progress.initializeProgress(id, auth, { maxDecisions: 2, maxToolAttempts: 1 })).not.toBeNull();
    const schema = (await f.client.query('SELECT current_schema() AS name')).rows[0].name;
    const gate = latch();
    let atCommit = false;
    const holder = observeConnection(f.db, async () => { atCommit = true; await gate.promise; });
    const waiter = observeConnection(f.db);
    const history = async () => (await f.client.query('SELECT name FROM pgmigrations ORDER BY id')).rows;
    const before = await history();
    async function act(operation: typeof first | typeof second, db: typeof holder.db) {
      switch (operation) {
        case 'cancel': return createRunCancellationRepository(db).tryCancelRun(id);
        case 'claim': return createRunExecutionLeaseRepository(db).tryClaimRunLease(id, claimArgs);
        case 'finish': return createAtomicRunFinalizer(db).tryFinalizeWithStep(id, 'completed');
        case 'reserve': return createRunExecutionProgressRepository(db).tryReserveDecision(id, auth, 0);
        case 'append': return createRunStepRepository(db).appendRunStep(id, 'completed');
        case 'downgrade': return migrate('test', 'down', schema);
      }
    }
    const winner = act(first, holder.db);
    const jobs: Promise<unknown>[] = [winner];
    void winner.catch(() => {});
    try {
      await waitForDb(async () => atCommit);
      const loser = act(second, waiter.db);
      void loser.catch(() => {});
      jobs.push(loser);
      let blockedPid = 0;
      await waitForDb(async () => {
        const { rows } = await f.client.query(`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))
          AND ($2::int IS NULL OR pid=$2)`, [holder.pid(), second === 'downgrade' ? null : waiter.pid()]);
        blockedPid = rows[0]?.pid;
        return Boolean(blockedPid);
      });
      expect(blockedPid).not.toBe(holder.pid());
      gate.open();
      expect(await winner).not.toBeNull();
      if (second === 'downgrade') await expect(loser).rejects.toThrow('Cannot remove recorded Run cancellation');
      else if (first === 'claim' || first === 'reserve') expect(await loser).toEqual({ kind: 'cancelled', runId: id, stepNo: 1 });
      else expect(await loser).toBeNull();
      expect(holder.releases).toEqual([false]);
      if (second !== 'downgrade') expect(waiter.releases).toEqual([false]);
      console.info('C1 parent lock', { first, second, holder: holder.pid(), waiter: blockedPid });
    } finally { gate.open(); await Promise.allSettled(jobs); }
    const terminal = first === 'finish' ? 'completed' : 'cancelled';
    expect(await f.runs.findRunById(id)).toMatchObject({ status: terminal });
    expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: terminal }]);
    expect(await history()).toEqual(before);
    expect((await f.client.query('SELECT 1 FROM run_execution_leases WHERE run_id=$1', [id])).rowCount)
      .toBe(reservation || first === 'claim' ? 1 : 0);
    if (reservation) expect(await f.progress.getProgressSnapshot(id)).toMatchObject({
      decisionsReserved: first === 'reserve' ? 1 : 0, toolAttemptsReserved: 0, lastConfirmedStepNo: null,
    });
  }));

it.each(['before claim', 'decision pending', 'handler pending', 'reservation ACK pending'] as const)(
  'cancels at %s with an actual Worker, Executor and Host grant', async phase => withSchema(async (f, id) => {
    const scope = { runId: id, toolName: request.toolName, arguments: request.arguments };
    const policy = createToolAuthorizationPolicy([{ ...scope, effect: 'approval_required' }]);
    const grant = createToolApprovalGrant(policy, { ...scope, kind: 'pending_authorization' }, 300);
    const gate = vi.fn(createToolApprovalPermit(policy, grant));
    const cancel = createRunCancellationRepository(f.db);
    const proceed = latch();
    let waiting = false;
    const pause = async () => { waiting = true; await proceed.promise; };
    if (phase === 'handler pending') f.handler.mockImplementationOnce(async () => { await pause(); return output; });
    if (phase === 'decision pending') f.deps.decide.mockReset().mockImplementationOnce(async () => { await pause(); return request; });
    f.deps.executor.execute.mockImplementation(createInMemoryToolExecutor({
      registry: createToolRegistry([{ name: 'echo', inputSchema: z.strictObject({ message: z.string() }) }]),
      handlers: [{ name: 'echo', handle: f.handler }], permitExecution: gate,
    }).execute);
    const deps = { ...f.deps, async tryReserveToolAttempt(...args: Parameters<typeof f.deps.tryReserveToolAttempt>) {
      const result = await f.deps.tryReserveToolAttempt(...args);
      if (phase === 'reservation ACK pending' && result) await pause();
      return result;
    } };
    if (phase === 'before claim') expect(await cancel.tryCancelRun(id)).not.toBeNull();
    const job = execute(id, deps, options);
    void job.catch(() => {});
    try {
      if (phase !== 'before claim') {
        await waitForDb(async () => waiting);
        const calls = phase === 'handler pending' ? 1 : 0;
        expect(f.handler).toHaveBeenCalledTimes(calls);
        expect(gate).toHaveBeenCalledTimes(calls);
        const snapshot = await f.progress.getProgressSnapshot(id);
        expect(snapshot).toMatchObject({ decisionsReserved: 1, toolAttemptsReserved: phase === 'decision pending' ? 0 : 1 });
        expect(await cancel.tryCancelRun(id)).toEqual({ kind: 'cancelled', runId: id, stepNo: 1 });
        expect(inspectToolApprovalGrant(grant).kind).toBe(calls ? 'consumed' : 'active');
      }
    } finally { proceed.open(); await job; }
    const admitted = phase === 'handler pending' || phase === 'reservation ACK pending';
    expect(await job).toEqual({ kind: phase === 'before claim' ? 'not_started' :
      phase === 'decision pending' ? 'tool_admission_conflict' : 'step_persistence_conflict' });
    expect(await execute(id, deps, options)).toEqual({ kind: 'not_started' });
    expect(f.deps.decide).toHaveBeenCalledTimes(phase === 'before claim' ? 0 : 1);
    expect(f.handler).toHaveBeenCalledTimes(admitted ? 1 : 0);
    expect(gate).toHaveBeenCalledTimes(admitted ? 1 : 0);
    expect(inspectToolApprovalGrant(grant).kind).toBe(admitted ? 'consumed' : 'active');
    expect(await f.inspect(id)).toMatchObject({ category: 'terminal_observed', status: 'cancelled',
      ambiguousToolAttempt: admitted, unconfirmedNonterminalStep: false,
      progress: phase === 'before claim' ? null : { decisionsReserved: 1, toolAttemptsReserved: admitted ? 1 : 0,
        checkpointVersion: admitted ? 2 : 1, lastConfirmedStepNo: null } });
    expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: 'cancelled' }]);
  }));

it('observes an atomic cancellation pair across snapshots despite a lost COMMIT response', async () => withSchema(async (f, id) => {
  const lost = Error('Test cancellation acknowledgement lost');
  const writer = observeConnection(f.db, undefined, () => { throw lost; });
  await f.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const before = await f.inspect(id);
    expect(before).toMatchObject({ status: 'queued', steps: { count: 0 } });
    await expect(createRunCancellationRepository(writer.db).tryCancelRun(id)).rejects.toBe(lost);
    expect(writer.releases).toEqual([true]);
    expect(await f.inspect(id)).toEqual(before);
  } finally { await f.client.query('ROLLBACK'); }
  expect(await f.inspect(id)).toMatchObject({ category: 'terminal_observed', status: 'cancelled', steps: { count: 1, lastKind: 'cancelled' } });
  expect(await createRunCancellationRepository(f.db).tryCancelRun(id)).toBeNull();
  expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: 'cancelled' }]);
}));

it('cancels an expired lease and retains ambiguous attempts and unconfirmed nonterminal history', async () => withSchema(async (f, id) => {
  const claim = await f.leases.tryClaimRunLease(id, { ownerId: options.ownerId, leaseSeconds: 1 });
  if (!claim) throw Error('Expected fresh claim');
  const auth = { ownerId: claim.ownerId, leaseToken: claim.leaseToken };
  expect(await f.progress.initializeProgress(id, auth, { maxDecisions: 2, maxToolAttempts: 1 })).not.toBeNull();
  expect(await f.progress.tryReserveDecision(id, auth, 0)).not.toBeNull();
  expect(await f.progress.tryReserveToolAttempt(id, auth, 1)).not.toBeNull();
  expect(await f.deps.appendContinuedStepWithLease(id, auth)).not.toBeNull();
  await waitForDb(async () => (await f.client.query('SELECT clock_timestamp() >= expires_at AS expired FROM run_execution_leases WHERE run_id=$1', [id])).rows[0].expired);
  expect(await createRunCancellationRepository(f.db).tryCancelRun(id)).toEqual({ kind: 'cancelled', runId: id, stepNo: 2 });
  expect(await f.inspect(id)).toMatchObject({ category: 'terminal_observed', lease: 'expired', status: 'cancelled',
    ambiguousToolAttempt: true, unconfirmedNonterminalStep: true, progress: { checkpointVersion: 2, lastConfirmedStepNo: null } });
  expect(await steps(f.client, id)).toEqual([{ step_no: 1, result_kind: 'continued' }, { step_no: 2, result_kind: 'cancelled' }]);
}));

it.each(['gap', 'terminal prefix', 'queued steps', 'queued lease', 'queued progress'])(
  'leaves unsupported %s history intact', async mode => withSchema(async (f, id) => {
    if (mode.startsWith('queued') && mode !== 'queued steps') {
      const claim = await f.leases.tryClaimRunLease(id, { ownerId: options.ownerId, leaseSeconds: 30 });
      if (!claim) throw Error('Expected lease');
      if (mode === 'queued progress') {
        await f.progress.initializeProgress(id, { ownerId: claim.ownerId, leaseToken: claim.leaseToken }, { maxDecisions: 1, maxToolAttempts: 0 });
        await f.client.query('DELETE FROM run_execution_leases WHERE run_id=$1', [id]);
      }
      await f.client.query("UPDATE runs SET status='queued' WHERE id=$1", [id]);
    } else {
      if (mode !== 'queued steps') await f.runs.tryStartRun(id);
      await f.client.query('INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,$2,$3)',
        [id, mode === 'gap' ? 2 : 1, mode === 'terminal prefix' ? 'completed' : 'continued']);
    }
    const original = await f.runs.findRunById(id);
    const oldSteps = await steps(f.client, id);
    const inspection = await f.inspect(id);
    expect(await createRunCancellationRepository(f.db).tryCancelRun(id)).toBeNull();
    expect(await f.runs.findRunById(id)).toEqual(original);
    expect(await steps(f.client, id)).toEqual(oldSteps);
    expect(await f.inspect(id)).toEqual(inspection);
  }));

it('rolls back the Run update and marker when COMMIT has not been sent', async () => withSchema(async (f, id) => {
  const lost = Error('Test failure before commit');
  const writer = observeConnection(f.db, async () => { throw lost; });
  await expect(createRunCancellationRepository(writer.db).tryCancelRun(id)).rejects.toBe(lost);
  expect(writer.releases).toEqual([true]);
  expect(await f.runs.findRunById(id)).toMatchObject({ status: 'queued' });
  expect(await steps(f.client, id)).toEqual([]);
}));
