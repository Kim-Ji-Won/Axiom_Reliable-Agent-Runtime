import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository, type Run } from '../../src/persistence/run-repository.js';
import { createRunStepRepository } from '../../src/persistence/run-step-repository.js';
import { createAtomicRunFinalizer } from '../../src/persistence/atomic-run-finalizer.js';
import { runOneDecision } from '../../src/runtime/run-one-decision.js';
import { runBoundedDecisions } from '../../src/runtime/run-bounded-decisions.js';
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
    const response = await app.inject(`/runs/${created.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...created, status, createdAt: created.createdAt.toISOString() });
  } finally { await app.close(); }
}

function runtime(client: PoolClient, db: Fixture['db'], decide: (run: Run) => Promise<unknown>) {
  return {
    repository: createRunRepository(client), finalizer: createAtomicRunFinalizer(db),
    continueRecorder: createRunContinueRecorder(db), decide,
  };
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

describe('real PostgreSQL bounded decisions', () => {
  it.each([
    { name: 'continue continue final', decisions: [{ kind: 'continue' }, { kind: 'continue' }, { kind: 'final', content: 'FINAL_SENTINEL' }], kinds: ['continued', 'continued', 'completed'], result: { kind: 'completed', content: 'FINAL_SENTINEL' }, status: 'completed' },
    { name: 'continue through limit', decisions: [{ kind: 'continue' }, { kind: 'continue' }, { kind: 'continue' }], kinds: ['continued', 'continued', 'decision_limit_exceeded'], result: { kind: 'decision_limit_exceeded' }, status: 'failed' },
    { name: 'continue then tool', decisions: [{ kind: 'continue' }, { kind: 'tool_request', toolName: 'tool_sentinel', arguments: { secret: 'ARG_SENTINEL' } }], kinds: ['continued', 'unsupported_tool_request'], result: { kind: 'unsupported_tool_request' }, status: 'failed' },
  ])('$name preserves GET fields and exactly one Step per decision', async test => withSchema(async ({ client, db, pool }) => {
    const created = await createRunRepository(client).createRun('  TASK_SENTINEL 😀  ');
    const decide = vi.fn(async () => test.decisions[decide.mock.calls.length - 1]);
    expect(await runBoundedDecisions(created.id, runtime(client, db, decide), { maxDecisions: 3 })).toEqual(test.result);
    expect(decide).toHaveBeenCalledTimes(test.decisions.length);
    const steps = await createRunStepRepository(db).listRunSteps(created.id);
    expect(steps!.map(s => s.resultKind)).toEqual(test.kinds);
    expect(steps!.map(s => s.stepNo)).toEqual(test.kinds.map((_, i) => i + 1));
    expect(JSON.stringify(steps)).not.toMatch(/SENTINEL|tool_sentinel/);
    const persisted = await createRunRepository(client).findRunById(created.id);
    expect(persisted).toEqual({ ...created, status: test.status });
    expect(JSON.stringify(persisted)).not.toMatch(/FINAL_SENTINEL|ARG_SENTINEL/);
    await checkGet(client, created, test.status);
    expect(pool.totalCount - pool.idleCount).toBe(1);
    console.info(JSON.stringify({ boundedScenario: test.name, decisions: decide.mock.calls.length, stepKinds: steps!.map(s => s.resultKind), getStatus: 200, runStatus: test.status, fieldsPreserved: true }));
  }));

  it('one-shot continue uses a single failed limit Step', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('one shot');
    const decide = vi.fn(async () => ({ kind: 'continue' }));
    expect(await runOneDecision(created.id, runtime(client, db, decide))).toEqual({ kind: 'decision_limit_exceeded' });
    expect(decide).toHaveBeenCalledTimes(1);
    expect((await createRunStepRepository(db).listRunSteps(created.id))!.map(s => s.resultKind)).toEqual(['decision_limit_exceeded']);
    await checkGet(client, created, 'failed');
  }));

  it('only one of two independent backends claims and performs the bounded decisions', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('concurrent loop');
    const clients: PoolClient[] = []; const leases: ReturnType<typeof lease>[] = [];
    try {
      for (let i = 0; i < 2; i++) { const c = await db.connect(); clients.push(c); leases.push(lease(c)); }
      const pids = await Promise.all(clients.map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      expect(pids[0]).not.toBe(pids[1]);
      const decisions = clients.map(() => vi.fn().mockResolvedValueOnce({ kind: 'continue' }).mockResolvedValueOnce({ kind: 'final', content: 'winner' }));
      const settled = await Promise.allSettled(clients.map((c, i) => runBoundedDecisions(created.id, {
        repository: createRunRepository(c), finalizer: createAtomicRunFinalizer(leases[i]!.db),
        continueRecorder: createRunContinueRecorder(leases[i]!.db), decide: decisions[i]!,
      }, { maxDecisions: 3 })));
      expect(settled.every(r => r.status === 'fulfilled')).toBe(true);
      const results = settled.map(r => r.status === 'fulfilled' ? r.value : null);
      expect(results.filter(r => r?.kind === 'not_started')).toHaveLength(1);
      expect(results.filter(r => r?.kind === 'completed')).toEqual([{ kind: 'completed', content: 'winner' }]);
      decisions.forEach((d, i) => expect(d).toHaveBeenCalledTimes(results[i]?.kind === 'completed' ? 2 : 0));
      const steps = await createRunStepRepository(db).listRunSteps(created.id);
      expect(steps!.map(s => [s.stepNo, s.resultKind])).toEqual([[1, 'continued'], [2, 'completed']]);
      await checkGet(client, created, 'completed');
      console.info(JSON.stringify({ boundedBackendPids: pids, resultKinds: results.map(r => r?.kind), decisionCalls: decisions.map(d => d.mock.calls.length), stepKinds: steps!.map(s => s.resultKind) }));
    } finally { leases.forEach(l => l.release()); }
  }));

  it('serializes continued and legacy append on separate backends without duplicate sequence numbers', async () => withSchema(async ({ client, db }) => {
    const repo = createRunRepository(client); const created = await repo.createRun('append compatibility'); await repo.tryStartRun(created.id);
    const leases: ReturnType<typeof lease>[] = [];
    try {
      const a = await db.connect(); leases.push(lease(a)); const b = await db.connect(); leases.push(lease(b));
      const pids = await Promise.all([a, b].map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      expect(pids[0]).not.toBe(pids[1]);
      const settled = await Promise.allSettled([
        createRunContinueRecorder(leases[0]!.db).appendContinuedStepIfRunning(created.id),
        createRunStepRepository(leases[1]!.db).appendRunStep(created.id, 'invalid_decision'),
      ]);
      expect(settled.every(r => r.status === 'fulfilled' && r.value !== null)).toBe(true);
      const steps = await createRunStepRepository(db).listRunSteps(created.id);
      expect(steps!.map(s => s.stepNo)).toEqual([1, 2]);
      expect(steps!.map(s => s.resultKind).sort()).toEqual(['continued', 'invalid_decision']);
      expect((await repo.findRunById(created.id))!.status).toBe('running');
    } finally { leases.forEach(l => l.release()); }
  }));

  it.each(['continue', 'final'] as const)('preserves committed history when an external finish wins during a %s decision', async kind => withSchema(async ({ client, db }) => {
    const repo = createRunRepository(client); const created = await repo.createRun('external winner'); const other = await db.connect();
    try {
      const decide = vi.fn().mockResolvedValueOnce({ kind: 'continue' }).mockImplementationOnce(async () => {
        await createRunRepository(other).tryFinishRun(created.id, 'completed');
        return kind === 'continue' ? { kind } : { kind, content: 'MUST_NOT_RETURN' };
      });
      expect(await runBoundedDecisions(created.id, runtime(client, db, decide), { maxDecisions: 3 })).toEqual({ kind: 'finalize_conflict' });
      expect(decide).toHaveBeenCalledTimes(2);
      expect((await createRunStepRepository(db).listRunSteps(created.id))!.map(s => [s.stepNo, s.resultKind])).toEqual([[1, 'continued']]);
      await checkGet(client, created, 'completed');
    } finally { other.release(); }
  }));

  it.each(['missing', 'queued', 'completed', 'failed'] as const)('continued recorder rejects %s without writing', async status => withSchema(async ({ client, db }) => {
    const repo = createRunRepository(client); let id = randomUUID() as string;
    if (status !== 'missing') {
      id = (await repo.createRun('not running')).id;
      if (status !== 'queued') { await repo.tryStartRun(id); await repo.tryFinishRun(id, status); }
    }
    const before = await snapshot(client);
    expect(await createRunContinueRecorder(db).appendContinuedStepIfRunning(id)).toBeNull();
    expect(await snapshot(client)).toEqual(before);
  }));

  it('does not call the next source when an external writer finishes after continued COMMIT', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('stop between decisions');
    const other = await db.connect();
    try {
      const decide = vi.fn(async () => ({ kind: 'continue' }));
      const deps = runtime(client, db, decide);
      const append = deps.continueRecorder.appendContinuedStepIfRunning;
      deps.continueRecorder.appendContinuedStepIfRunning = async id => {
        const step = await append(id);
        await createRunRepository(other).tryFinishRun(id, 'completed');
        return step;
      };
      expect(await runBoundedDecisions(created.id, deps, { maxDecisions: 5 })).toEqual({ kind: 'finalize_conflict' });
      expect(decide).toHaveBeenCalledTimes(1);
      expect((await createRunStepRepository(db).listRunSteps(created.id))!.map(s => s.resultKind)).toEqual(['continued']);
      await checkGet(client, created, 'completed');
    } finally { other.release(); }
  }));

  it.each([
    ['direct', 'continue'], ['direct', 'finish'], ['atomic', 'continue'], ['atomic', 'finish'],
  ] as const)('serializes %s finish with recorder when %s locks first', async (mode, first) => withSchema(async ({ client, db }) => {
    const repo = createRunRepository(client); const created = await repo.createRun('lock ordering'); await repo.tryStartRun(created.id);
    const clients: PoolClient[] = []; const leases: ReturnType<typeof lease>[] = [];
    let unblock!: () => void; let atCommit!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const reached = new Promise<void>(resolve => { atCommit = resolve; });
    const pending: Promise<unknown>[] = [];
    try {
      for (let i = 0; i < 2; i++) { const c = await db.connect(); clients.push(c); leases.push(lease(c)); }
      const pids = await Promise.all(clients.map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      expect(pids[0]).not.toBe(pids[1]);
      const gated = { connect: async () => {
        const leased = await leases[0]!.db.connect();
        return { ...leased, query: (async (sql: string, values?: unknown[]) => {
          if (sql === 'COMMIT') { atCommit(); await gate; }
          return clients[0]!.query(sql, values);
        }) as PoolClient['query'] };
      } };
      const start = (action: string, index: number) => {
        const provider = index === 0 ? gated : leases[index]!.db;
        if (action === 'continue') return createRunContinueRecorder(provider).appendContinuedStepIfRunning(created.id);
        if (mode === 'atomic') return createAtomicRunFinalizer(provider).tryFinalizeWithStep(created.id, 'completed');
        return (async () => {
          await clients[index]!.query('BEGIN');
          try {
            const result = await createRunRepository(clients[index]!).tryFinishRun(created.id, 'completed');
            if (index === 0) { atCommit(); await gate; }
            await clients[index]!.query('COMMIT'); return result;
          } catch (error) { await clients[index]!.query('ROLLBACK'); throw error; }
        })();
      };
      const a = start(first, 0); pending.push(a);
      await Promise.race([reached, a.then(() => { throw new Error('First operation did not reach commit'); })]);
      const b = start(first === 'continue' ? 'finish' : 'continue', 1); pending.push(b);
      await waitForLock(client, pids[1]!);
      unblock();
      const settled = await Promise.allSettled([a, b]);
      expect(settled.every(r => r.status === 'fulfilled')).toBe(true);
      const results = settled.map(r => r.status === 'fulfilled' ? r.value : undefined);
      if (first === 'finish') expect(results[1]).toBeNull(); else expect(results.every(r => r !== null)).toBe(true);
      const kinds = first === 'continue' ? (mode === 'atomic' ? ['continued', 'completed'] : ['continued']) : (mode === 'atomic' ? ['completed'] : []);
      const steps = await createRunStepRepository(db).listRunSteps(created.id);
      expect(steps!.map(s => s.resultKind)).toEqual(kinds);
      expect(steps!.map(s => s.stepNo)).toEqual(kinds.map((_, i) => i + 1));
      expect(await createRunContinueRecorder(db).appendContinuedStepIfRunning(created.id)).toBeNull();
      await checkGet(client, created, 'completed');
      console.info(JSON.stringify({ recorderRace: mode, firstLock: first, backendPids: pids, stepKinds: kinds }));
    } finally {
      unblock(); await Promise.allSettled(pending);
      for (const c of clients) { try { await c.query('ROLLBACK'); } catch { /* release below */ } }
      leases.forEach(l => l.release());
    }
  }), 15000);

  it.each([
    ['continued', 'insert'], ['continued', 'commit'], ['invalid_decision', 'insert'], ['invalid_decision', 'commit'],
  ] as const)('rolls back %s %s failure, stops the loop, preserves history, then recovers', async (kind, stage) => withSchema(async ({ client, db, pool }) => {
    const repo = createRunRepository(client); const steps = createRunStepRepository(db);
    const created = await repo.createRun('failure scope'); const other = await repo.createRun('unaffected');
    await steps.appendRunStep(other.id, 'completed'); const otherSteps = await steps.listRunSteps(other.id);
    await client.query(`CREATE FUNCTION reject_loop_step() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.step_no = 2 AND NEW.result_kind = '${kind}' THEN RAISE EXCEPTION 'injected loop failure'; END IF; RETURN NEW; END $$`);
    await client.query(stage === 'commit'
      ? 'CREATE CONSTRAINT TRIGGER reject_loop_step AFTER INSERT ON run_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_loop_step()'
      : 'CREATE TRIGGER reject_loop_step AFTER INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_loop_step()');
    const decide = vi.fn().mockResolvedValueOnce({ kind: 'continue' }).mockResolvedValue(kind === 'continued' ? { kind: 'continue' } : { kind: 'invalid' });
    await expect(runBoundedDecisions(created.id, runtime(client, db, decide), { maxDecisions: 3 })).rejects.toMatchObject({ code: 'P0001' });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(await repo.findRunById(created.id)).toEqual({ ...created, status: 'running' });
    expect((await steps.listRunSteps(created.id))!.map(s => [s.stepNo, s.resultKind])).toEqual([[1, 'continued']]);
    expect(await repo.findRunById(other.id)).toEqual(other); expect(await steps.listRunSteps(other.id)).toEqual(otherSteps);
    expect(pool.totalCount - pool.idleCount).toBe(1);
    await client.query('DROP TRIGGER reject_loop_step ON run_steps');
    expect((await createRunContinueRecorder(db).appendContinuedStepIfRunning(created.id))!.stepNo).toBe(2);
    expect((await createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, 'completed'))!.step.stepNo).toBe(3);
    await checkGet(client, created, 'completed');
    expect(pool.totalCount - pool.idleCount).toBe(1);
    console.info(JSON.stringify({ loopFailure: kind, stage, priorStepsPreserved: 1, recoverySteps: [2, 3], leasedConnections: 1 }));
  }));

  it('discards a real recorder connection when rollback itself fails', async () => withSchema(async ({ client, db, pool }) => {
    const repo = createRunRepository(client); const created = await repo.createRun('rollback disconnect'); await repo.tryStartRun(created.id);
    await client.query("CREATE FUNCTION reject_continue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$");
    await client.query('CREATE TRIGGER reject_continue AFTER INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_continue()');
    let pid = 0; let discarded = false;
    const recorder = createRunContinueRecorder({ connect: async () => {
      const connection = await db.connect(); pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return {
        query: (async (sql: string, values?: unknown[]) => { if (sql === 'ROLLBACK') throw new Error('rollback unavailable'); return connection.query(sql, values); }) as PoolClient['query'],
        release: (error?: boolean | Error) => { discarded = Boolean(error); connection.release(error); },
      };
    } });
    await expect(recorder.appendContinuedStepIfRunning(created.id)).rejects.toMatchObject({ code: 'P0001' });
    expect(discarded).toBe(true);
    // The observer waits for the failed transaction's lock to be released by disconnect.
    await client.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE', [created.id]);
    expect((await client.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid])).rowCount).toBe(0);
    expect(await createRunStepRepository(db).listRunSteps(created.id)).toEqual([]);
    expect((await repo.findRunById(created.id))!.status).toBe('running');
    await client.query('DROP TRIGGER reject_continue ON run_steps');
    expect((await createRunContinueRecorder(db).appendContinuedStepIfRunning(created.id))!.stepNo).toBe(1);
    expect(pool.totalCount - pool.idleCount).toBe(1);
  }));

  it('adds only the fifth constraint extension, preserves old data, safely downs and reapplies', async () => withSchema(async ({ schema, client, db }) => {
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(5);
    await migrate('test', 'down', schema);
    const repo = createRunRepository(client); const steps = createRunStepRepository(db);
    const created = await repo.createRun('preserved queued'); const running = await repo.createRun('preserved running'); await repo.tryStartRun(running.id);
    for (const kind of ['completed', 'unsupported_tool_request', 'invalid_decision', 'decision_source_error', 'finalize_conflict'] as const) await steps.appendRunStep(created.id, kind);
    const before = await snapshot(client);
    const columns = (await client.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('runs','run_steps') ORDER BY table_name,ordinal_position", [schema])).rows;
    expect(await migrate('test', 'up', schema)).toHaveLength(1);
    expect(await migrate('test', 'up', schema)).toHaveLength(0);
    const after = await snapshot(client);
    expect(after.runs).toEqual(before.runs); expect(after.steps).toEqual(before.steps);
    expect(after.history.slice(0, 4)).toEqual(before.history);
    expect(after.constraints.filter(c => c.conname !== 'run_steps_result_kind_check')).toEqual(before.constraints.filter(c => c.conname !== 'run_steps_result_kind_check'));
    expect((await client.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('runs','run_steps') ORDER BY table_name,ordinal_position", [schema])).rows).toEqual(columns);
    expect(await migrate('test', 'down', schema)).toHaveLength(1);
    expect(await snapshot(client)).toEqual(before);
    for (const kind of ['continued', 'decision_limit_exceeded', 'unknown']) {
      await expect(client.query('INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,6,$2)', [created.id, kind])).rejects.toMatchObject({ code: '23514' });
    }
    expect(await migrate('test', 'up', schema)).toHaveLength(1);
    await expect(client.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,6,'unknown')", [created.id])).rejects.toMatchObject({ code: '23514' });
  }));

  it.each(['continued', 'decision_limit_exceeded'] as const)('refuses down with %s preserving data, constraints and full migration history', async kind => withSchema(async ({ schema, client, db }) => {
    const repo = createRunRepository(client); const created = await repo.createRun('preserve new kind'); await repo.tryStartRun(created.id);
    if (kind === 'continued') await createRunContinueRecorder(db).appendContinuedStepIfRunning(created.id);
    else await createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, kind);
    const before = await snapshot(client);
    await expect(migrate('test', 'down', schema)).rejects.toThrow('Cannot remove recorded loop Step kinds');
    expect(await snapshot(client)).toEqual(before);
    expect(await migrate('test', 'up', schema)).toHaveLength(0);
  }));

  it('locks before down checks and refuses a concurrently committed new Step', async () => withSchema(async ({ schema, client, db }) => {
    const created = await createRunRepository(client).createRun('migration race');
    const writer = await db.connect(); let downgrade: Promise<{ error?: unknown }> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,1,'continued')", [created.id]);
      const before = await snapshot(client);
      downgrade = migrate('test', 'down', schema).then(() => ({}), error => ({ error }));
      const deadline = Date.now() + 3000; let waiting = false;
      while (Date.now() < deadline) {
        if ((await client.query("SELECT 1 FROM pg_locks WHERE relation='run_steps'::regclass AND mode='AccessExclusiveLock' AND NOT granted")).rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true); await writer.query('COMMIT');
      expect((await downgrade).error).toBeInstanceOf(Error);
      const after = await snapshot(client);
      expect(after.runs).toEqual(before.runs); expect(after.history).toEqual(before.history); expect(after.constraints).toEqual(before.constraints);
      expect(after.steps).toHaveLength(1); expect(after.steps[0].result_kind).toBe('continued');
      console.info('Loop migration down waited for INSERT and preserved committed Step, constraint and history');
    } finally { try { await writer.query('ROLLBACK'); } finally { writer.release(); if (downgrade) await downgrade; } }
  }), 15000);
});
