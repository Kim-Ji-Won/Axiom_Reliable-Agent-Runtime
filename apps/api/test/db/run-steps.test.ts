import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository } from '../../src/persistence/run-repository.js';
import { createRunStepRepository, appendRunStepResultKinds } from '../../src/persistence/run-step-repository.js';
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
async function snapshot(client: PoolClient) {
  return {
    runs: (await client.query('SELECT * FROM runs ORDER BY id')).rows,
    steps: (await client.query('SELECT * FROM run_steps ORDER BY run_id, step_no')).rows,
    history: (await client.query('SELECT * FROM pgmigrations ORDER BY id')).rows,
    constraints: (await client.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('runs'::regclass, 'run_steps'::regclass) ORDER BY conname")).rows,
  };
}

describe('real PostgreSQL Run Step history', () => {
  it('adds migration four without changing Runs, downgrades empty history and reapplies', async () => withSchema(async ({ schema, client }) => {
    expect(await migrate('test', 'down', schema)).toHaveLength(1); // loop Step kinds
    expect(await migrate('test', 'down', schema)).toHaveLength(1); // Step table
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(3);
    const runs = createRunRepository(client);
    const queued = await runs.createRun('preserve existing queued');
    const terminal = await runs.createRun('preserve existing completed');
    await runs.tryStartRun(terminal.id);
    await runs.tryFinishRun(terminal.id, 'completed');
    const before = (await client.query('SELECT * FROM runs ORDER BY id')).rows;
    const runDefinition = async () => ({
      constraints: (await client.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='runs'::regclass ORDER BY conname")).rows,
      columns: (await client.query("SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='runs' ORDER BY ordinal_position", [schema])).rows,
    });
    const definition = await runDefinition();
    expect(await migrate('test', 'up', schema)).toHaveLength(2);
    expect((await client.query('SELECT * FROM runs ORDER BY id')).rows).toEqual(before);
    expect(await runDefinition()).toEqual(definition);
    const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='run_steps' ORDER BY ordinal_position", [schema])).rows;
    expect(columns.map(c => c.column_name)).toEqual(['run_id', 'step_no', 'result_kind', 'created_at']);
    const constraints = (await client.query("SELECT contype, confdeltype FROM pg_constraint WHERE conrelid='run_steps'::regclass")).rows;
    expect(constraints.some(c => c.contype === 'p')).toBe(true);
    expect(constraints.filter(c => c.contype === 'c')).toHaveLength(2);
    expect(constraints.find(c => c.contype === 'f').confdeltype).toBe('a');
    expect(await migrate('test', 'down', schema)).toHaveLength(1); // loop Step kinds
    expect(await migrate('test', 'down', schema)).toHaveLength(1); // Step table
    expect((await client.query("SELECT to_regclass('run_steps') AS name")).rows[0].name).toBeNull();
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(3);
    expect((await client.query('SELECT * FROM runs ORDER BY id')).rows).toEqual(before);
    expect(await runDefinition()).toEqual(definition);
    expect((await runs.createRun('default remains')).status).toBe('queued');
    expect(await runs.findRunById(queued.id)).toEqual(queued);
    expect(await migrate('test', 'up', schema)).toHaveLength(2);
    expect(await migrate('test', 'up', schema)).toHaveLength(0);
  }));

  it('stores only ordered metadata with DB time and distinguishes empty from missing Runs', async () => withSchema(async ({ client, db, pool }) => {
    const repo = createRunStepRepository(db);
    const run = await createRunRepository(client).createRun('TASK_MUST_NOT_BE_COPIED');
    const other = await createRunRepository(client).createRun('independent');
    const missing = randomUUID();
    expect(await repo.listRunSteps(run.id)).toEqual([]);
    expect(await repo.listRunSteps(missing)).toBeNull();
    expect(await repo.appendRunStep(missing, 'completed')).toBeNull();
    const before = (await client.query('SELECT clock_timestamp() AS time')).rows[0].time as Date;
    const steps = [];
    for (const kind of appendRunStepResultKinds) steps.push(await repo.appendRunStep(run.id, kind));
    const after = (await client.query('SELECT clock_timestamp() AS time')).rows[0].time as Date;
    expect(steps.map(step => step!.stepNo)).toEqual([1, 2, 3, 4, 5]);
    steps.forEach(step => {
      expect(Object.keys(step!).sort()).toEqual(['createdAt', 'resultKind', 'runId', 'stepNo']);
      expect(step!.createdAt).toBeInstanceOf(Date);
      expect(step!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(step!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
    const persisted = (await client.query('SELECT created_at FROM run_steps WHERE run_id=$1 ORDER BY step_no', [run.id])).rows;
    expect(steps.map(s => s!.createdAt)).toEqual(persisted.map(r => r.created_at));
    expect(await repo.listRunSteps(run.id)).toEqual(steps);
    expect((await repo.appendRunStep(other.id, 'completed'))!.stepNo).toBe(1);
    expect(await createRunRepository(client).findRunById(run.id)).toEqual(run);
    expect(JSON.stringify(await repo.listRunSteps(run.id))).not.toContain(run.task);
    expect(pool.totalCount - pool.idleCount).toBe(1); // only the fixture's observer remains leased
  }));

  it.each([
    [0, 'completed', '23514'], [-1, 'completed', '23514'],
    [1, 'not_started', '23514'], [1, 'unknown', '23514'],
    [null, 'completed', '23502'], [1, null, '23502'],
  ])('enforces SQL constraints for case %#', async (step, kind, code) => withSchema(async ({ client }) => {
    const run = await createRunRepository(client).createRun('constraints');
    await expect(client.query('INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,$2,$3)', [run.id, step, kind])).rejects.toMatchObject({ code });
  }));

  it('enforces FK, composite PK, and prevents automatic parent deletion', async () => withSchema(async ({ client, db }) => {
    const run = await createRunRepository(client).createRun('constraints');
    await expect(client.query("INSERT INTO run_steps VALUES($1,1,'completed',NOW())", [randomUUID()])).rejects.toMatchObject({ code: '23503' });
    await createRunStepRepository(db).appendRunStep(run.id, 'completed');
    await expect(client.query("INSERT INTO run_steps VALUES($1,1,'completed',NOW())", [run.id])).rejects.toMatchObject({ code: '23505' });
    await expect(client.query('DELETE FROM runs WHERE id=$1', [run.id])).rejects.toMatchObject({ code: '23503' });
    expect((await createRunStepRepository(db).listRunSteps(run.id))!.length).toBe(1);
  }));

  it('assigns 1 and 2 to concurrent appends on distinct PostgreSQL backends', async () => withSchema(async ({ client, db }) => {
    const run = await createRunRepository(client).createRun('concurrent append');
    const other = await createRunRepository(client).createRun('independent counter');
    const connections: PoolClient[] = [];
    try {
      connections.push(await db.connect());
      connections.push(await db.connect());
      const pids = await Promise.all(connections.map(c => c.query('SELECT pg_backend_pid() AS pid')));
      expect(pids[0]!.rows[0].pid).not.toBe(pids[1]!.rows[0].pid);
      // These leases stay exclusive to their repository for the duration of each append.
      // The fixture owns their final release so both can be inspected after settlement.
      const repositories = connections.map(c => createRunStepRepository({ connect: async () => ({ query: c.query.bind(c), release: () => {} }) }));
      const settled = await Promise.allSettled(repositories.map(repo => repo.appendRunStep(run.id, 'completed')));
      expect(settled.every(r => r.status === 'fulfilled')).toBe(true);
      const steps = settled.map(r => r.status === 'fulfilled' ? r.value : null);
      expect(steps.map(s => s!.stepNo).sort()).toEqual([1, 2]);
      const listed = await createRunStepRepository(db).listRunSteps(run.id);
      expect(listed!.map(s => s.stepNo)).toEqual([1, 2]);
      expect(listed).toEqual(steps.sort((a, b) => a!.stepNo - b!.stepNo));
      expect((await createRunStepRepository(db).appendRunStep(other.id, 'completed'))!.stepNo).toBe(1);
      console.info(JSON.stringify({ stepBackendPids: pids.map(r => r.rows[0].pid), stepNumbers: listed!.map(s => s.stepNo), rows: listed!.length, otherRunStep: 1 }));
    } finally { connections.forEach(c => c.release()); }
  }));

  it.each(['statement', 'commit'])('rolls back an injected %s failure and reuses the next sequence number', async failure => withSchema(async ({ client, db, pool }) => {
    const run = await createRunRepository(client).createRun('rollback insertion');
    const other = await createRunRepository(client).createRun('unaffected');
    const repo = createRunStepRepository(db);
    await repo.appendRunStep(other.id, 'completed');
    const unchanged = await repo.listRunSteps(other.id);
    await client.query(`CREATE FUNCTION reject_test_step() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.result_kind = 'invalid_decision' THEN RAISE EXCEPTION 'injected step failure'; END IF; RETURN NEW; END $$`);
    await client.query(failure === 'commit'
      ? 'CREATE CONSTRAINT TRIGGER reject_test_step AFTER INSERT ON run_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_test_step()'
      : 'CREATE TRIGGER reject_test_step AFTER INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_test_step()');
    await expect(repo.appendRunStep(run.id, 'invalid_decision')).rejects.toMatchObject({ code: 'P0001' });
    expect(await repo.listRunSteps(run.id)).toEqual([]);
    expect(pool.totalCount - pool.idleCount).toBe(1);
    expect((await repo.appendRunStep(run.id, 'completed'))!.stepNo).toBe(1);
    expect(await repo.listRunSteps(other.id)).toEqual(unchanged);
    expect(pool.totalCount - pool.idleCount).toBe(1);
  }));

  it('refuses nonempty down without changing rows, constraints or migration history', async () => withSchema(async ({ schema, client, db }) => {
    await migrate('test', 'down', schema); // test the original Step-table downgrade
    const run = await createRunRepository(client).createRun('preserve history');
    await createRunStepRepository(db).appendRunStep(run.id, 'completed');
    const before = await snapshot(client);
    await expect(migrate('test', 'down', schema)).rejects.toThrow('Cannot drop nonempty run_steps');
    expect(await snapshot(client)).toEqual(before);
    expect(await migrate('test', 'up', schema)).toHaveLength(1);
    expect((await createRunStepRepository(db).appendRunStep(run.id, 'completed'))!.stepNo).toBe(2);
  }));

  it('waits for an in-flight INSERT before checking whether down can drop the table', async () => withSchema(async ({ schema, client, db }) => {
    await migrate('test', 'down', schema); // test the original Step-table downgrade
    const run = await createRunRepository(client).createRun('down versus insert');
    const writer = await db.connect();
    let downgrade: Promise<{ error?: unknown }> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query("INSERT INTO run_steps(run_id,step_no,result_kind) VALUES($1,1,'completed')", [run.id]);
      const history = (await client.query('SELECT * FROM pgmigrations ORDER BY id')).rows;
      downgrade = migrate('test', 'down', schema).then(() => ({}), error => ({ error }));
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        const locks = await client.query("SELECT 1 FROM pg_locks WHERE relation='run_steps'::regclass AND mode='AccessExclusiveLock' AND NOT granted");
        if (locks.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query('COMMIT');
      const result = await downgrade;
      expect(result.error).toBeInstanceOf(Error);
      expect((await createRunStepRepository(db).listRunSteps(run.id))!.map(s => s.stepNo)).toEqual([1]);
      expect((await client.query('SELECT * FROM pgmigrations ORDER BY id')).rows).toEqual(history);
      console.info('Step rollback race: waited for INSERT, refused down after commit, Step 1 and migration history preserved');
    } finally {
      try { await writer.query('ROLLBACK'); }
      finally { writer.release(); if (downgrade) await downgrade; }
    }
  }), 15000);
});
