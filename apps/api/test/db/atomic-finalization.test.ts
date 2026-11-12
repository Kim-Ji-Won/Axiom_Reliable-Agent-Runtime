import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository, type Run } from '../../src/persistence/run-repository.js';
import { createRunStepRepository } from '../../src/persistence/run-step-repository.js';
import { createAtomicRunFinalizer, finalizationResultKinds } from '../../src/persistence/atomic-run-finalizer.js';
import { runOneDecision } from '../../src/runtime/run-one-decision.js';
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

describe('real PostgreSQL atomic finalization', () => {
  it.each(finalizationResultKinds)('commits %s status and one metadata Step with unchanged GET fields', async kind => withSchema(async ({ client, db, pool }) => {
    const runs = createRunRepository(client);
    const created = await runs.createRun('  original task 😀  ');
    await runs.tryStartRun(created.id);
    const result = await createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, kind);
    const status = kind === 'completed' ? 'completed' : 'failed';
    expect(result!.run).toEqual({ ...created, status });
    expect(result!.step).toEqual({ runId: created.id, stepNo: 1, resultKind: kind, createdAt: expect.any(Date) });
    expect(await createRunStepRepository(db).listRunSteps(created.id)).toEqual([result!.step]);
    expect(await runs.findRunById(created.id)).toEqual(result!.run);
    await checkGet(client, created, status);
    expect(pool.totalCount - pool.idleCount).toBe(1);
  }));

  it.each(['missing', 'queued', 'completed', 'failed'] as const)('returns null without changing %s Run or history', async state => withSchema(async ({ client, db }) => {
    const runs = createRunRepository(client);
    const steps = createRunStepRepository(db);
    let id = randomUUID() as string;
    if (state !== 'missing') {
      id = (await runs.createRun('not finalizable')).id;
      if (state !== 'queued') {
        await runs.tryStartRun(id);
        await createAtomicRunFinalizer(db).tryFinalizeWithStep(id, state === 'completed' ? 'completed' : 'invalid_decision');
      }
    }
    const beforeRun = await runs.findRunById(id);
    const beforeSteps = await steps.listRunSteps(id);
    expect(await createAtomicRunFinalizer(db).tryFinalizeWithStep(id, 'completed')).toBeNull();
    expect(await runs.findRunById(id)).toEqual(beforeRun);
    expect(await steps.listRunSteps(id)).toEqual(beforeSteps);
  }));

  it('has one atomic winner and one Step across two distinct backend PIDs', async () => withSchema(async ({ client, db }) => {
    const runs = createRunRepository(client);
    const created = await runs.createRun('competing finalizers');
    await runs.tryStartRun(created.id);
    const leases: ReturnType<typeof lease>[] = [];
    const pids: number[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const c = await db.connect(); leases.push(lease(c));
        pids.push((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      }
      expect(pids[0]).not.toBe(pids[1]);
      const kinds = ['completed', 'invalid_decision'] as const;
      const settled = await Promise.allSettled(leases.map((l, i) => createAtomicRunFinalizer(l.db).tryFinalizeWithStep(created.id, kinds[i]!)));
      expect(settled.every(r => r.status === 'fulfilled')).toBe(true);
      const results = settled.map(r => r.status === 'fulfilled' ? r.value : null);
      expect(results.filter(r => r === null)).toHaveLength(1);
      const winner = results.find(r => r !== null)!;
      expect(winner.step.resultKind).toBe(kinds[results.findIndex(r => r !== null)]);
      expect(winner.run.status).toBe(winner.step.resultKind === 'completed' ? 'completed' : 'failed');
      expect(await createRunStepRepository(db).listRunSteps(created.id)).toEqual([winner.step]);
      expect(await createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, 'decision_source_error')).toBeNull();
      await checkGet(client, created, winner.run.status);
      console.info(JSON.stringify({ atomicBackendPids: pids, results: results.map(r => r && { status: r.run.status, kind: r.step.resultKind, stepNo: r.step.stepNo }), rows: 1 }));
    } finally { leases.forEach(l => l.release()); }
  }));

  it('serializes existing append and atomic finalization on the same parent row', async () => withSchema(async ({ client, db }) => {
    const runs = createRunRepository(client);
    const created = await runs.createRun('append versus finalize');
    await runs.tryStartRun(created.id);
    const leases: ReturnType<typeof lease>[] = [];
    const pids: number[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const c = await db.connect(); leases.push(lease(c));
        pids.push((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      }
      expect(pids[0]).not.toBe(pids[1]);
      const settled = await Promise.allSettled([
        createRunStepRepository(leases[0]!.db).appendRunStep(created.id, 'invalid_decision'),
        createAtomicRunFinalizer(leases[1]!.db).tryFinalizeWithStep(created.id, 'completed'),
      ]);
      expect(settled.every(r => r.status === 'fulfilled' && r.value !== null)).toBe(true);
      const steps = await createRunStepRepository(db).listRunSteps(created.id);
      expect(steps!.map(s => s.stepNo)).toEqual([1, 2]);
      expect(steps!.map(s => s.resultKind).sort()).toEqual(['completed', 'invalid_decision']);
      const other = await runs.createRun('independent sequence');
      expect((await createRunStepRepository(db).appendRunStep(other.id, 'completed'))!.stepNo).toBe(1);
      await checkGet(client, created, 'completed');
      console.info(JSON.stringify({ appendFinalizePids: pids, stepNumbers: steps!.map(s => s.stepNo), rows: steps!.length, otherRunStep: 1 }));
    } finally { leases.forEach(l => l.release()); }
  }));

  it.each(['insert', 'commit'] as const)('rolls back Run and Step together on %s failure', async stage => withSchema(async ({ client, db, pool }) => {
    const runs = createRunRepository(client);
    const steps = createRunStepRepository(db);
    const created = await runs.createRun('rollback atomic finalization');
    const running = await runs.tryStartRun(created.id);
    await steps.appendRunStep(created.id, 'completed');
    const other = await runs.createRun('unaffected Run');
    await steps.appendRunStep(other.id, 'completed');
    const before = (await client.query('SELECT * FROM run_steps ORDER BY run_id, step_no')).rows;
    await client.query(`CREATE FUNCTION reject_atomic_step() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.result_kind = 'invalid_decision' THEN RAISE EXCEPTION 'injected atomic failure'; END IF; RETURN NEW; END $$`);
    await client.query(stage === 'commit'
      ? 'CREATE CONSTRAINT TRIGGER reject_atomic_step AFTER INSERT ON run_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_atomic_step()'
      : 'CREATE TRIGGER reject_atomic_step AFTER INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_atomic_step()');
    await expect(createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, 'invalid_decision')).rejects.toMatchObject({ code: 'P0001' });
    expect(await runs.findRunById(created.id)).toEqual(running);
    expect((await client.query('SELECT * FROM run_steps ORDER BY run_id, step_no')).rows).toEqual(before);
    expect(await runs.findRunById(other.id)).toEqual(other);
    expect(pool.totalCount - pool.idleCount).toBe(1);
    const result = await createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, 'completed');
    expect(result!.step.stepNo).toBe(2);
    expect(await steps.listRunSteps(other.id)).toHaveLength(1);
    await checkGet(client, created, 'completed');
    expect(pool.totalCount - pool.idleCount).toBe(1);
    console.info(JSON.stringify({ atomicFailure: stage, rollbackStatus: 'running', existingStepsPreserved: true, nextStep: 2, leasedConnections: 1 }));
  }));

  it.each([
    { label: 'final', kind: 'completed', decide: async () => ({ kind: 'final', content: ' FINAL_SENTINEL 😀 ' }) },
    { label: 'tool', kind: 'unsupported_tool_request', decide: async () => ({ kind: 'tool_request', toolName: 'tool_sentinel', arguments: { secret: 'ARG_SENTINEL' } }) },
    { label: 'invalid', kind: 'invalid_decision', decide: async () => ({ kind: 'final', content: '', secret: 'RAW_SENTINEL' }) },
    { label: 'throw', kind: 'decision_source_error', decide: () => { throw new Error('ERROR_SENTINEL', { cause: 'CAUSE_SENTINEL' }); } },
    { label: 'reject', kind: 'decision_source_error', decide: async () => { throw new Error('ERROR_SENTINEL'); } },
  ] as const)('integrates Runtime $label with one matching Step and GET', async test => withSchema(async ({ client, db }) => {
    const repository = createRunRepository(client);
    const created = await repository.createRun('TASK_SENTINEL');
    const decide = vi.fn(test.decide);
    const result = await runOneDecision(created.id, { repository, finalizer: createAtomicRunFinalizer(db), decide });
    expect(result).toEqual(test.kind === 'completed' ? { kind: 'completed', content: ' FINAL_SENTINEL 😀 ' } : { kind: test.kind });
    expect(decide).toHaveBeenCalledExactlyOnceWith({ ...created, status: 'running' });
    const steps = await createRunStepRepository(db).listRunSteps(created.id);
    expect(steps).toEqual([{ runId: created.id, stepNo: 1, resultKind: test.kind, createdAt: expect.any(Date) }]);
    expect(JSON.stringify(steps)).not.toMatch(/SENTINEL|tool_sentinel/);
    const persisted = (await client.query('SELECT row_to_json(r) AS run FROM runs r WHERE id=$1', [created.id])).rows[0].run;
    expect(Object.keys(persisted).sort()).toEqual(['created_at', 'id', 'status', 'task']);
    expect(JSON.stringify(persisted)).not.toMatch(/FINAL_SENTINEL|ARG_SENTINEL|RAW_SENTINEL|ERROR_SENTINEL|CAUSE_SENTINEL/);
    await checkGet(client, created, test.kind === 'completed' ? 'completed' : 'failed');
  }));
});
