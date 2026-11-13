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
import { runBoundedToolDecisions, type BoundedToolRuntimeDependencies } from '../../src/runtime/run-bounded-tool-decisions.js';
import { createRunContinueRecorder } from '../../src/persistence/run-continue-recorder.js';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';
import { migrate } from '../../../../db/migrate.js';

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

const budgets = { maxDecisions: 3, maxToolExecutions: 1 };
const request = { kind: 'tool_request', toolName: 'echo', arguments: { message: 'ARG_SECRET' } };
const final = { kind: 'final', content: 'done' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for test barrier')), 3000); })]); }
  finally { clearTimeout(timer); }
}
function runtime(client: PoolClient, db: Fixture['db']) {
  const handler = vi.fn((_args: unknown): unknown => ({ value: 'OUTPUT_SECRET' }));
  const gate = vi.fn(() => true);
  const executor = createInMemoryToolExecutor({
    registry: createToolRegistry([{ name: 'echo', inputSchema: z.strictObject({ message: z.string() }) }]),
    handlers: [{ name: 'echo', handle: handler }], permitExecution: gate,
  });
  const decide = vi.fn<BoundedToolRuntimeDependencies['decide']>().mockReturnValueOnce(request).mockReturnValue(final);
  const deps = {
    repository: createRunRepository(client), finalizer: createAtomicRunFinalizer(db),
    continueRecorder: createRunContinueRecorder(db), toolRecorder: createRunToolStepRecorder(db), executor, decide,
  };
  return { deps, handler, gate, decide };
}
async function snapshot(client: PoolClient) {
  return {
    runs: (await client.query('SELECT * FROM runs ORDER BY id')).rows,
    steps: (await client.query('SELECT * FROM run_steps ORDER BY run_id, step_no')).rows,
    history: (await client.query('SELECT * FROM pgmigrations ORDER BY id')).rows,
    constraints: (await client.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('runs'::regclass, 'run_steps'::regclass) ORDER BY conname")).rows,
  };
}
async function waitForLock(client: PoolClient, pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await client.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected backend lock wait');
}

describe('real PostgreSQL bounded tool Runtime', () => {
  it.each(['tool-final', 'continue-tool-final', 'tool-continue-final'])('%s commits ordered metadata and preserves four HTTP fields', async mode => withSchema(async ({ schema, client, db, pool }) => {
    const created = await createRunRepository(client).createRun('  TASK_SECRET 😀  ');
    const { deps, decide, handler, gate } = runtime(client, db);
    const decisions = mode === 'tool-final' ? [request, final] : mode === 'continue-tool-final' ? [{ kind: 'continue' }, request, final] : [request, { kind: 'continue' }, final];
    decide.mockReset().mockImplementation(async (_r, context) => {
      const index = decide.mock.calls.length - 1;
      if (index > 0 && decisions[index - 1] === request) {
        expect(context.kind).toBe('tool_result'); expect(Object.isFrozen(context)).toBe(true);
        expect((await createRunStepRepository(db).listRunSteps(created.id))!.at(-1)!.resultKind).toBe('tool_succeeded');
        expect((await deps.repository.findRunById(created.id))!.status).toBe('running');
      } else expect(context).toEqual({ kind: 'none' });
      return decisions[index];
    });
    expect(await runBoundedToolDecisions(created.id, deps, budgets)).toEqual({ kind: 'completed', content: 'done' });
    expect(handler).toHaveBeenCalledTimes(1); expect(gate).toHaveBeenCalledTimes(1);
    const steps = await createRunStepRepository(db).listRunSteps(created.id);
    const kinds = decisions.map(d => d.kind === 'tool_request' ? 'tool_succeeded' : d.kind === 'continue' ? 'continued' : 'completed');
    expect(steps!.map(s => s.resultKind)).toEqual(kinds); expect(steps!.map(s => s.stepNo)).toEqual(kinds.map((_, i) => i + 1));
    expect(JSON.stringify(steps)).not.toMatch(/SECRET|message|output|arguments|content/);
    const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='run_steps' ORDER BY ordinal_position", [schema])).rows.map(r => r.column_name);
    expect(columns).toEqual(['run_id','step_no','result_kind','created_at']);
    expect(JSON.stringify((await client.query('SELECT * FROM runs')).rows)).not.toMatch(/ARG_SECRET|OUTPUT_SECRET/);
    await checkGet(client, created, 'completed'); expect(pool.totalCount - pool.idleCount).toBe(1);
    console.info(JSON.stringify({ toolScenario: mode, handlerCalls: handler.mock.calls.length, stepKinds: kinds, httpStatus: 200, fourFieldsPreserved: true }));
  }));

  it('two independent PostgreSQL backends allow one claim, one Gate and one Handler', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('claim race');
    const clients: PoolClient[] = [];
    try {
      for (let i = 0; i < 2; i++) clients.push(await db.connect());
      const pids = await Promise.all(clients.map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      expect(pids[0]).not.toBe(pids[1]);
      const workers = clients.map(c => runtime(c, db));
      const settled = await Promise.allSettled(workers.map(w => runBoundedToolDecisions(created.id, w.deps, budgets)));
      expect(settled.every(r => r.status === 'fulfilled')).toBe(true);
      const results = settled.map(r => r.status === 'fulfilled' ? r.value : null);
      expect(results.filter(r => r?.kind === 'completed')).toHaveLength(1); expect(results.filter(r => r?.kind === 'not_started')).toHaveLength(1);
      workers.forEach((w, i) => { const winner = results[i]!.kind === 'completed'; expect(w.decide).toHaveBeenCalledTimes(winner ? 2 : 0); expect(w.handler).toHaveBeenCalledTimes(winner ? 1 : 0); expect(w.gate).toHaveBeenCalledTimes(winner ? 1 : 0); });
      expect((await createRunStepRepository(db).listRunSteps(created.id))!.map(s => [s.stepNo,s.resultKind])).toEqual([[1,'tool_succeeded'],[2,'completed']]);
      await checkGet(client, created, 'completed');
      console.info(JSON.stringify({ toolClaimBackendPids: pids, results: results.map(r => r!.kind), handlerCalls: workers.map(w => w.handler.mock.calls.length), gateCalls: workers.map(w => w.gate.mock.calls.length) }));
    } finally { clients.forEach(c => c.release()); }
  }));

  it('external terminal commit before dispatch prevents Gate, Handler and Tool Step', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('external finish first'); const w = runtime(client, db);
    w.decide.mockReset().mockImplementation(async () => { await createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, 'completed'); return request; });
    expect(await runBoundedToolDecisions(created.id, w.deps, budgets)).toEqual({ kind: 'finalize_conflict' });
    expect(w.decide).toHaveBeenCalledTimes(1); expect(w.handler).not.toHaveBeenCalled(); expect(w.gate).not.toHaveBeenCalled();
    expect((await createRunStepRepository(db).listRunSteps(created.id))!.map(s => s.resultKind)).toEqual(['completed']);
    await checkGet(client, created, 'completed');
    console.info('External finish before handler: calls 0, terminal Step preserved, finalize_conflict');
  }));

  it.each(['success','reject'])('external finish during deferred Handler %s preserves terminal history and blocks next decision', async mode => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('external finish in flight'); const w = runtime(client, db);
    const entered = deferred(); const release = deferred();
    w.handler.mockImplementation(async () => { entered.resolve(); await release.promise; if (mode === 'reject') throw new Error('SECRET'); return { secret: 'OUTPUT_SECRET' }; });
    const pending = runBoundedToolDecisions(created.id, w.deps, budgets);
    try {
      await bounded(entered.promise);
      // This must complete while the handler is blocked: no Run lock spans it.
      await bounded(createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, 'completed'));
      const terminal = await createRunStepRepository(db).listRunSteps(created.id);
      release.resolve(); const result = await bounded(pending);
      expect(result).toEqual({ kind: 'finalize_conflict' }); expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(await createRunStepRepository(db).listRunSteps(created.id)).toEqual(terminal);
      expect(terminal!.map(s => s.resultKind)).toEqual(['completed']); expect(w.decide).toHaveBeenCalledTimes(1); expect(w.handler).toHaveBeenCalledTimes(1);
      await checkGet(client, created, 'completed');
      console.info(JSON.stringify({ externalFinishDuringHandler: mode, result: result.kind, handlerCalls: 1, decisions: 1, stepKinds: ['completed'] }));
    } finally { release.resolve(); await Promise.allSettled([pending]); }
  }));

  it('waits for a real Tool Step COMMIT before the next decision', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('commit boundary'); const w = runtime(client, db);
    const atCommit = deferred(); const release = deferred(); let released = false;
    w.deps.toolRecorder = createRunToolStepRecorder({ connect: async () => {
      const c = await db.connect(); return {
        query: (async (sql: string, values?: unknown[]) => { if (sql === 'COMMIT') { atCommit.resolve(); await release.promise; } return c.query(sql, values); }) as PoolClient['query'],
        release: (error?: Error | boolean) => { released = true; c.release(error); },
      };
    } });
    const pending = runBoundedToolDecisions(created.id, w.deps, budgets);
    try {
      await bounded(atCommit.promise); expect(w.decide).toHaveBeenCalledTimes(1); expect(released).toBe(false);
      expect((await client.query('SELECT * FROM run_steps WHERE run_id=$1', [created.id])).rows).toEqual([]);
      expect((await w.deps.repository.findRunById(created.id))!.status).toBe('running');
      release.resolve(); expect(await bounded(pending)).toEqual({ kind: 'completed', content: 'done' });
      expect(w.decide).toHaveBeenCalledTimes(2); expect(released).toBe(true);
    } finally { release.resolve(); await Promise.allSettled([pending]); }
  }));

  it.each(['deny','throw','reject','invalid-output','unknown','arguments','budget','last-slot','second-tool'])('%s fails atomically without excess Handler calls', async mode => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('fixed failure'); const w = runtime(client, db);
    let expected = 'tool_failed'; let expectedCalls = 1; let opts = budgets;
    if (mode === 'deny') { w.gate.mockReturnValue(false); expectedCalls = 0; }
    if (mode === 'throw') w.handler.mockImplementation(() => { throw new Error('SECRET'); });
    if (mode === 'reject') w.handler.mockImplementation(() => Promise.reject(new Error('SECRET')));
    if (mode === 'invalid-output') w.handler.mockReturnValue({ secret: undefined });
    if (mode === 'unknown' || mode === 'arguments') { w.decide.mockReset().mockReturnValue(mode === 'unknown' ? { ...request, toolName: 'unknown' } : { ...request, arguments: { message: 5 } }); expected = 'tool_request_rejected'; expectedCalls = 0; }
    if (mode === 'budget') { opts = { ...budgets, maxToolExecutions: 0 }; expected = 'tool_execution_limit_exceeded'; expectedCalls = 0; }
    if (mode === 'last-slot') { opts = { ...budgets, maxDecisions: 1 }; expected = 'decision_limit_exceeded'; expectedCalls = 0; }
    if (mode === 'second-tool') { w.decide.mockReset().mockReturnValue(request); expected = 'tool_execution_limit_exceeded'; }
    const result = await runBoundedToolDecisions(created.id, w.deps, opts);
    expect(result.kind).toBe(expected); expect(JSON.stringify(result)).not.toContain('SECRET'); expect(w.handler).toHaveBeenCalledTimes(expectedCalls);
    const steps = await createRunStepRepository(db).listRunSteps(created.id);
    expect(steps!.map(s => s.resultKind)).toEqual(mode === 'second-tool' ? ['tool_succeeded',expected] : [expected]);
    expect(JSON.stringify(steps)).not.toContain('SECRET'); await checkGet(client, created, 'failed');
    expect(w.decide).toHaveBeenCalledTimes(mode === 'second-tool' ? 2 : 1);
  }));

  it.each(['insert','commit'] as const)('rolls back Tool Step %s failure and prevents the next decision', async stage => withSchema(async ({ client, db, pool }) => {
    const created = await createRunRepository(client).createRun('recorder failure'); const w = runtime(client, db);
    await client.query("CREATE FUNCTION reject_tool_step() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result_kind='tool_succeeded' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$");
    await client.query(stage === 'commit' ? 'CREATE CONSTRAINT TRIGGER reject_tool AFTER INSERT ON run_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_tool_step()' : 'CREATE TRIGGER reject_tool AFTER INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_tool_step()');
    let discarded: boolean | undefined; let releases = 0;
    w.deps.toolRecorder = createRunToolStepRecorder({ connect: async () => { const c = await db.connect(); return { query: c.query.bind(c), release: (error?: boolean | Error) => { discarded = Boolean(error); releases++; c.release(error); } }; } });
    await expect(runBoundedToolDecisions(created.id, w.deps, budgets)).rejects.toMatchObject({ code: 'P0001' });
    expect(discarded).toBe(stage === 'commit'); expect(releases).toBe(1);
    expect(await createRunStepRepository(db).listRunSteps(created.id)).toEqual([]);
    expect((await w.deps.repository.findRunById(created.id))!.status).toBe('running'); expect(w.decide).toHaveBeenCalledTimes(1); expect(w.handler).toHaveBeenCalledTimes(1);
    expect(pool.totalCount - pool.idleCount).toBe(1);
    console.info(JSON.stringify({ toolRecorderFailure: stage, discarded, releases, decisions: 1, steps: 0 }));
  }));

  it('discards an uncertain COMMIT response after the real commit without retry or next decision', async () => withSchema(async ({ client, db, pool }) => {
    const created = await createRunRepository(client).createRun('uncertain commit'); const w = runtime(client, db);
    const error = new Error('commit acknowledgement lost'); let discarded = false; let commits = 0;
    w.deps.toolRecorder = createRunToolStepRecorder({ connect: async () => { const c = await db.connect(); return {
      query: (async (sql: string, values?: unknown[]) => { const result = await c.query(sql, values); if (sql === 'COMMIT') { commits++; throw error; } return result; }) as PoolClient['query'],
      release: (e?: boolean | Error) => { discarded = Boolean(e); c.release(e); },
    }; } });
    await expect(runBoundedToolDecisions(created.id, w.deps, budgets)).rejects.toBe(error);
    expect(commits).toBe(1); expect(discarded).toBe(true); expect(w.handler).toHaveBeenCalledTimes(1); expect(w.decide).toHaveBeenCalledTimes(1);
    expect((await createRunStepRepository(db).listRunSteps(created.id))!.map(s => s.resultKind)).toEqual(['tool_succeeded']);
    expect((await w.deps.repository.findRunById(created.id))!.status).toBe('running'); expect(pool.totalCount - pool.idleCount).toBe(1);
    console.info('Tool COMMIT response loss: persisted Step 1, connection discarded, no retry or next decision');
  }));

  it('discards a real connection on rollback failure and releases its uncommitted row lock', async () => withSchema(async ({ client, db, pool }) => {
    const created = await createRunRepository(client).createRun('rollback failure'); await createRunRepository(client).tryStartRun(created.id);
    await client.query("CREATE FUNCTION reject_tool() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$");
    await client.query('CREATE TRIGGER reject_tool AFTER INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_tool()');
    let pid = 0; let discarded = false;
    const recorder = createRunToolStepRecorder({ connect: async () => { const c = await db.connect(); pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; return {
      query: (async (sql: string, values?: unknown[]) => { if (sql === 'ROLLBACK') throw new Error('rollback unavailable'); return c.query(sql, values); }) as PoolClient['query'],
      release: (e?: boolean | Error) => { discarded = Boolean(e); c.release(e); },
    }; } });
    await expect(recorder.appendToolSucceededStepIfRunning(created.id)).rejects.toMatchObject({ code: 'P0001' });
    expect(discarded).toBe(true); await client.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE', [created.id]);
    expect((await client.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid])).rowCount).toBe(0);
    expect(await createRunStepRepository(db).listRunSteps(created.id)).toEqual([]); expect(pool.totalCount - pool.idleCount).toBe(1);
  }));

  it.each((['tool_failed','tool_request_rejected','tool_execution_limit_exceeded','completed'] as const).flatMap(kind => (['insert','commit'] as const).map(stage => ({ kind, stage }))))('finalizer rollback preserves Run and prior Step when $kind $stage fails', async ({ kind, stage }) => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('finalizer atomicity'); const repo = createRunRepository(client); await repo.tryStartRun(created.id);
    await createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(created.id);
    await client.query("CREATE FUNCTION reject_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.step_no=2 THEN RAISE EXCEPTION 'terminal insert failure'; END IF; RETURN NEW; END $$");
    await client.query(stage === 'commit'
      ? 'CREATE CONSTRAINT TRIGGER reject_terminal AFTER INSERT ON run_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_terminal()'
      : 'CREATE TRIGGER reject_terminal AFTER INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_terminal()');
    // Include the injected deferred constraint in the baseline before execution.
    const before = await snapshot(client);
    await expect(createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, kind)).rejects.toMatchObject({ code: 'P0001' });
    expect(await snapshot(client)).toEqual(before);
  }));

  it.each(['tool','finish'] as const)('serializes Tool Step versus external finish when %s holds the parent lock first', async first => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('parent lock ordering'); await createRunRepository(client).tryStartRun(created.id);
    const clients: PoolClient[] = []; const leases: ReturnType<typeof lease>[] = []; const pending: Promise<unknown>[] = [];
    const reached = deferred(); const release = deferred();
    try {
      for (let i = 0; i < 2; i++) { const c = await db.connect(); clients.push(c); leases.push(lease(c)); }
      const pids = await Promise.all(clients.map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)); expect(pids[0]).not.toBe(pids[1]);
      const gated = { connect: async () => { const l = await leases[0]!.db.connect(); return { ...l, query: (async (sql: string, values?: unknown[]) => { if (sql === 'COMMIT') { reached.resolve(); await release.promise; } return clients[0]!.query(sql, values); }) as PoolClient['query'] }; } };
      const action = (kind: string, i: number) => kind === 'tool' ? createRunToolStepRecorder(i === 0 ? gated : leases[i]!.db).appendToolSucceededStepIfRunning(created.id) : createAtomicRunFinalizer(i === 0 ? gated : leases[i]!.db).tryFinalizeWithStep(created.id, 'completed');
      const a = action(first, 0); pending.push(a); await bounded(Promise.race([reached.promise, a.then(() => { throw new Error('missing barrier'); })]));
      const b = action(first === 'tool' ? 'finish' : 'tool', 1); pending.push(b);
      await waitForLock(client, pids[1]); release.resolve(); const results = await Promise.all([a,b]);
      if (first === 'finish') expect(results[1]).toBeNull();
      const kinds = first === 'tool' ? ['tool_succeeded','completed'] : ['completed'];
      expect((await createRunStepRepository(db).listRunSteps(created.id))!.map(s => s.resultKind)).toEqual(kinds);
      await checkGet(client, created, 'completed');
      console.info(JSON.stringify({ toolRecorderLockFirst: first, pids, stepKinds: kinds }));
    } finally {
      release.resolve(); await Promise.allSettled(pending);
      await Promise.allSettled(clients.map(c => c.query('ROLLBACK')));
      leases.forEach(l => l.release());
    }
  }), 15000);

  it('recorder does not append to missing, queued or terminal Runs', async () => withSchema(async ({ client, db }) => {
    const repo = createRunRepository(client); const recorder = createRunToolStepRecorder(db);
    expect(await recorder.appendToolSucceededStepIfRunning(randomUUID())).toBeNull();
    for (const state of ['queued','completed','failed'] as const) {
      const r = await repo.createRun('no append');
      if (state !== 'queued') { await repo.tryStartRun(r.id); await repo.tryFinishRun(r.id,state); }
      expect(await recorder.appendToolSucceededStepIfRunning(r.id)).toBeNull(); expect(await createRunStepRepository(db).listRunSteps(r.id)).toEqual([]);
    }
  }));

  it('migration six preserves old data, safely downs and reapplies without changing Run constraints', async () => withSchema(async ({ schema, client, db }) => {
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(7);
    await migrate('test','down',schema); // safe result table; exercise migration six
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(6);
    expect(await migrate('test','down',schema)).toHaveLength(1);
    const repo = createRunRepository(client); const created = await repo.createRun('preserved'); await repo.tryStartRun(created.id);
    await createRunContinueRecorder(db).appendContinuedStepIfRunning(created.id);
    const before = await snapshot(client);
    expect(await migrate('test','up',schema)).toHaveLength(2); expect(await migrate('test','up',schema)).toHaveLength(0);
    const after = await snapshot(client); expect(after.runs).toEqual(before.runs); expect(after.steps).toEqual(before.steps); expect(after.history.slice(0,5)).toEqual(before.history);
    expect(after.constraints.filter(c => c.conname === 'run_steps_result_binding')).toEqual([{ conname: 'run_steps_result_binding', definition: 'UNIQUE (run_id, step_no, result_kind)' }]);
    expect(after.constraints.filter(c => !['run_steps_result_kind_check', 'run_steps_result_binding'].includes(c.conname))).toEqual(before.constraints.filter(c => !['run_steps_result_kind_check', 'run_steps_result_binding'].includes(c.conname)));
    await expect(client.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,2,'unknown')",[created.id])).rejects.toMatchObject({ code: '23514' });
    expect(await migrate('test','down',schema)).toHaveLength(1); // safe result table
    expect(await migrate('test','down',schema)).toHaveLength(1); expect(await snapshot(client)).toEqual(before);
    for (const kind of ['tool_succeeded','tool_failed','tool_request_rejected','tool_execution_limit_exceeded']) {
      await expect(client.query('INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,2,$2)',[created.id,kind])).rejects.toMatchObject({ code: '23514' });
    }
    expect(await migrate('test','up',schema)).toHaveLength(2);
  }));

  it.each(['tool_succeeded','tool_failed','tool_request_rejected','tool_execution_limit_exceeded'] as const)('refuses down with %s preserving data, constraints and history', async kind => withSchema(async ({ schema, client, db }) => {
    await migrate('test','down',schema); // exercise migration six guard
    const created = await createRunRepository(client).createRun('down guard'); await createRunRepository(client).tryStartRun(created.id);
    if (kind === 'tool_succeeded') await createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(created.id);
    else await createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id,kind);
    const before = await snapshot(client);
    await expect(migrate('test','down',schema)).rejects.toThrow('Cannot remove recorded tool Step kinds');
    expect(await snapshot(client)).toEqual(before); expect(await migrate('test','up',schema)).toHaveLength(1);
    expect(await migrate('test','up',schema)).toHaveLength(0);
  }));

  it('down waits for a concurrent Tool Step INSERT and preserves the committed row and migration history', async () => withSchema(async ({ schema, client, db }) => {
    await migrate('test','down',schema); // exercise migration six lock
    const created = await createRunRepository(client).createRun('migration lock'); const writer = await db.connect();
    let pending: Promise<{ error?: unknown }> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,1,'tool_succeeded')",[created.id]);
      const before = await snapshot(client); pending = migrate('test','down',schema).then(() => ({}), error => ({ error }));
      await vi.waitFor(async () => expect((await client.query("SELECT 1 FROM pg_locks WHERE relation='run_steps'::regclass AND mode='AccessExclusiveLock' AND NOT granted")).rowCount).toBe(1), { timeout: 3000 });
      await writer.query('COMMIT'); expect((await pending).error).toBeInstanceOf(Error);
      const after = await snapshot(client); expect(after.runs).toEqual(before.runs); expect(after.history).toEqual(before.history); expect(after.constraints).toEqual(before.constraints);
      expect(after.steps.map(s => s.result_kind)).toEqual(['tool_succeeded']);
    } finally { try { await writer.query('ROLLBACK'); } finally { writer.release(); if (pending) await pending; } }
  }), 15000);
});
