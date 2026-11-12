import { buildApp } from '../../src/app.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runOneDecision } from '../../src/runtime/run-one-decision.js';
import type { Pool, PoolClient } from 'pg';
import { createDatabase, withDatabase } from '../../src/persistence/database.js';
import { createRunRepository } from '../../src/persistence/run-repository.js';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';
import { migrate } from '../../../../db/migrate.js';

const exec = promisify(execFile);
const schema = `axiom_test_${randomUUID().replaceAll('-', '')}`;
let pool: Pool;
let client: PoolClient;
let createdSchema = false;

beforeAll(async () => {
  pool = createDatabase(readDatabaseUrl('test'));
  client = await pool.connect();
  await assertDatabaseIdentity(client, 'test');
  await client.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await client.query(`SET search_path TO "${schema}"`);
}, 15000);

afterAll(async () => {
  try {
    if (createdSchema) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    client?.release();
    await pool?.end();
  }
});

describe('real PostgreSQL persistence', () => {
  it('migrates an empty schema, preserves old rows, restores prior constraints, and reapplies', async () => {
    expect(await migrate('test', 'up', schema)).toHaveLength(3);
    expect(await migrate('test', 'up', schema)).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(await migrate('test', 'down', schema)).toHaveLength(1);
    expect((await client.query("SELECT to_regclass('runs') AS name")).rows[0].name).toBeNull();
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(0);
    expect(await migrate('test', 'up', schema)).toHaveLength(3);
    expect(await migrate('test', 'down', schema)).toHaveLength(1);
    const repo = createRunRepository(client);
    const queued = await repo.createRun('old queued');
    const running = await repo.createRun('old running');
    await repo.tryStartRun(running.id);
    const before = (await client.query('SELECT * FROM runs ORDER BY id')).rows;
    expect(await migrate('test', 'up', schema)).toHaveLength(1);
    expect((await client.query('SELECT * FROM runs ORDER BY id')).rows).toEqual(before);
    expect(await migrate('test', 'down', schema)).toHaveLength(1);
    expect((await client.query('SELECT * FROM runs ORDER BY id')).rows).toEqual(before);
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(2);
    for (const status of ['completed', 'failed']) {
      await expect(client.query('UPDATE runs SET status=$1 WHERE id=$2', [status, running.id]))
        .rejects.toMatchObject({ code: '23514' });
    }
    expect(await repo.findRunById(queued.id)).toEqual(queued);
    expect(await migrate('test', 'up', schema)).toHaveLength(1);
  });

  it('creates and reads a Run with DB time, preserving original text', async () => {
    const repo = createRunRepository(client);
    const before = (await client.query('SELECT NOW() AS time')).rows[0].time as Date;
    const run = await repo.createRun("  Analyze 'issues'; -- 한글 😀  ");
    const after = (await client.query('SELECT NOW() AS time')).rows[0].time as Date;
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.status).toBe('queued');
    expect(run.task).toBe("  Analyze 'issues'; -- 한글 😀  ");
    expect(run.createdAt).toBeInstanceOf(Date);
    expect(run.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(run.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(await repo.findRunById(run.id)).toEqual(run);
    expect(await repo.findRunById(randomUUID())).toBeNull();
    await expect(repo.findRunById('invalid')).rejects.toThrow('UUID');
  });

  it('POST then GET returns identical four fields backed by PostgreSQL', async () => {
    const app = buildApp({ repository: createRunRepository(client), logger: false });
    try {
      const task = '  회의록 정리 😀  ';
      const post = await app.inject({ method: 'POST', url: '/runs', payload: { task } });
      expect(post.statusCode).toBe(201);
      const run = post.json();
      expect(Object.keys(run).sort()).toEqual(['createdAt', 'id', 'status', 'task']);
      expect(run.task).toBe(task);
      expect(run.status).toBe('queued');
      const get = await app.inject(`/runs/${run.id}`);
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual(run);
      const stored = await createRunRepository(client).findRunById(run.id);
      expect(run.createdAt).toBe(stored!.createdAt.toISOString());
    } finally { await app.close(); }
  });

  it('enforces repository validation before storing a run', async () => {
    const before = (await client.query('SELECT count(*) FROM runs')).rows[0].count;
    await expect(createRunRepository(client).createRun(' \n')).rejects.toThrow();
    expect((await client.query('SELECT count(*) FROM runs')).rows[0].count).toBe(before);
  });

  it('persists between separate Node processes and closed pools', async () => {
    const fixture = fileURLToPath(new URL('./process-fixture.ts', import.meta.url));
    const options = { env: { ...process.env, TEST_SCHEMA: schema }, timeout: 15000 };
    const created = JSON.parse((await exec(process.execPath, ['--import', 'tsx', fixture, 'create'], options)).stdout);
    const loaded = JSON.parse((await exec(process.execPath, ['--import', 'tsx', fixture, 'read', created.id], options)).stdout);
    expect(loaded).toEqual(created);
    expect(loaded.task).toBe('persist across separate processes');
  }, 30000);

  it('preserves all four HTTP fields across a graceful API process restart', async () => {
    const fixture = fileURLToPath(new URL('./process-fixture.ts', import.meta.url));
    const options = { env: { ...process.env, TEST_SCHEMA: schema }, timeout: 15000 };
    // exec resolves only after A closes its listener/client/pool and exits with code 0.
    // A failed/timed-out child rejects; suite teardown still removes only our schema.
    const before = JSON.parse((await exec(process.execPath, ['--import', 'tsx', fixture, 'http-create'], options)).stdout);
    expect(before.status).toBe(201);
    expect(Object.keys(before.run).sort()).toEqual(['createdAt', 'id', 'status', 'task']);
    expect(before.run.task).toBe('  HTTP restart 회의록 😀  ');
    expect(before.run.status).toBe('queued');
    const after = JSON.parse((await exec(process.execPath, ['--import', 'tsx', fixture, 'http-read', before.run.id], options)).stdout);
    expect(after.pid).not.toBe(before.pid);
    expect(after.status).toBe(200);
    expect(after.run).toEqual(before.run);
    console.info('HTTP restart verified: POST 201 → process A exit 0 → process B GET 200; four fields equal');
  }, 35000);

  it('starts once across two independent concurrent connections and exposes running via GET', async () => {
    const created = await createRunRepository(client).createRun('  concurrent start 😀  ');
    const connections: PoolClient[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const connection = await pool.connect();
        connections.push(connection);
        await assertDatabaseIdentity(connection, 'test');
        await connection.query(`SET search_path TO "${schema}"`);
      }
      const [a, b] = connections as [PoolClient, PoolClient];
      const pids = await Promise.all(connections.map(c => c.query('SELECT pg_backend_pid() AS pid')));
      expect(pids[0]!.rows[0].pid).not.toBe(pids[1]!.rows[0].pid);
      const results = await Promise.all([
        createRunRepository(a).tryStartRun(created.id),
        createRunRepository(b).tryStartRun(created.id),
      ]);
      expect(results.filter(run => run === null)).toHaveLength(1);
      expect(results.filter(run => run !== null)).toEqual([{ ...created, status: 'running' }]);
      expect(await createRunRepository(a).tryStartRun(created.id)).toBeNull();
      expect(await createRunRepository(b).tryStartRun(randomUUID())).toBeNull();
      const app = buildApp({ repository: createRunRepository(client), logger: false });
      try {
        const response = await app.inject(`/runs/${created.id}`);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ...created, status: 'running', createdAt: created.createdAt.toISOString() });
      } finally { await app.close(); }
    } finally { connections.forEach(connection => connection.release()); }
  });

  it('refuses rollback with running rows without changing data, constraints, or migration history', async () => {
    const repo = createRunRepository(client);
    const run = await repo.createRun('rollback safety');
    expect((await repo.tryStartRun(run.id))!.status).toBe('running');
    expect(await migrate('test', 'down', schema)).toHaveLength(1);
    const before = (await client.query('SELECT * FROM runs ORDER BY id')).rows;
    const history = (await client.query('SELECT * FROM pgmigrations ORDER BY id')).rows;
    await expect(migrate('test', 'down', schema)).rejects.toThrow();
    expect((await client.query('SELECT * FROM runs ORDER BY id')).rows).toEqual(before);
    expect((await client.query('SELECT * FROM pgmigrations ORDER BY id')).rows).toEqual(history);
    expect(await migrate('test', 'up', schema)).toHaveLength(1);
    const next = await repo.createRun('still queued by default');
    expect(next.status).toBe('queued');
    expect((await repo.tryStartRun(next.id))!.status).toBe('running');
  });

  it.each(['completed', 'failed'] as const)('finishes %s once and preserves the HTTP fields', async outcome => {
    const repo = createRunRepository(client);
    const app = buildApp({ repository: repo, logger: false });
    try {
      const post = await app.inject({ method: 'POST', url: '/runs', payload: { task: '  finish 😀  ' } });
      expect(post.statusCode).toBe(201);
      const created = post.json();
      expect(created.status).toBe('queued');
      expect(await repo.tryFinishRun(created.id, outcome)).toBeNull();
      expect((await app.inject(`/runs/${created.id}`)).json()).toEqual(created);
      expect(await repo.tryFinishRun(randomUUID(), outcome)).toBeNull();
      await repo.tryStartRun(created.id);
      const finished = await repo.tryFinishRun(created.id, outcome);
      expect(finished).toEqual({ ...created, status: outcome, createdAt: new Date(created.createdAt) });
      expect(await repo.tryStartRun(created.id)).toBeNull();
      for (const repeated of ['completed', 'failed'] as const) {
        expect(await repo.tryFinishRun(created.id, repeated)).toBeNull();
      }
      const get = await app.inject(`/runs/${created.id}`);
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ ...created, status: outcome });
    } finally { await app.close(); }
  });

  it('resolves competing completion and failure on independent backends exactly once', async () => {
    const repo = createRunRepository(client);
    const created = await repo.createRun('  competing finish 😀  ');
    await repo.tryStartRun(created.id);
    const connections: PoolClient[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const connection = await pool.connect();
        connections.push(connection);
        await assertDatabaseIdentity(connection, 'test');
        await connection.query(`SET search_path TO "${schema}"`);
      }
      const [a, b] = connections as [PoolClient, PoolClient];
      const pids = await Promise.all(connections.map(c => c.query('SELECT pg_backend_pid() AS pid')));
      expect(pids[0]!.rows[0].pid).not.toBe(pids[1]!.rows[0].pid);
      const results = await Promise.all([
        createRunRepository(a).tryFinishRun(created.id, 'completed'),
        createRunRepository(b).tryFinishRun(created.id, 'failed'),
      ]);
      expect(results.filter(run => run === null)).toHaveLength(1);
      const winner = results.find(run => run !== null)!;
      expect(winner.status).toBe(results[0] ? 'completed' : 'failed');
      expect(winner).toEqual({ ...created, status: winner.status });
      const app = buildApp({ repository: repo, logger: false });
      try {
        const get = await app.inject(`/runs/${created.id}`);
        expect(get.statusCode).toBe(200);
        expect(get.json()).toEqual({ ...created, status: winner.status, createdAt: created.createdAt.toISOString() });
        console.info(JSON.stringify({ backendPids: pids.map(p => p.rows[0].pid), finishResults: results, getStatus: get.statusCode, get: get.json() }));
      } finally { await app.close(); }
    } finally { connections.forEach(c => c.release()); }
  });

  it.each(['completed', 'failed'] as const)('refuses rollback with only %s terminal rows and preserves constraints/history/data', async outcome => {
    const isolated = `axiom_test_${randomUUID().replaceAll('-', '')}`;
    const connection = await pool.connect();
    let created = false;
    try {
      await assertDatabaseIdentity(connection, 'test');
      await connection.query(`CREATE SCHEMA "${isolated}"`);
      created = true;
      await connection.query(`SET search_path TO "${isolated}"`);
      await migrate('test', 'up', isolated);
      const repo = createRunRepository(connection);
      const run = await repo.createRun('rollback terminal safety');
      await repo.tryStartRun(run.id);
      await repo.tryFinishRun(run.id, outcome);
      const rows = (await connection.query('SELECT * FROM runs ORDER BY id')).rows;
      const history = (await connection.query('SELECT * FROM pgmigrations ORDER BY id')).rows;
      const constraints = () => connection.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'runs'::regclass ORDER BY conname");
      const beforeConstraints = (await constraints()).rows;
      await expect(migrate('test', 'down', isolated)).rejects.toThrow();
      expect((await connection.query('SELECT * FROM runs ORDER BY id')).rows).toEqual(rows);
      expect((await connection.query('SELECT * FROM pgmigrations ORDER BY id')).rows).toEqual(history);
      expect((await constraints()).rows).toEqual(beforeConstraints);
      expect(await migrate('test', 'up', isolated)).toHaveLength(0);
    } finally {
      try { if (created) await connection.query(`DROP SCHEMA "${isolated}" CASCADE`); }
      finally { connection.release(); }
    }
  });

  it('orchestrates one decision across independent backends and exposes completed via GET', async () => {
    const created = await createRunRepository(client).createRun('  one-shot runtime 😀  ');
    const connections: PoolClient[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const connection = await pool.connect();
        connections.push(connection);
        await assertDatabaseIdentity(connection, 'test');
        await connection.query(`SET search_path TO "${schema}"`);
        await connection.query("SET statement_timeout TO '5s'");
      }
      const pids = await Promise.all(connections.map(c => c.query('SELECT pg_backend_pid() AS pid')));
      expect(pids[0]!.rows[0].pid).not.toBe(pids[1]!.rows[0].pid);
      const content = '  temporary final 😀  ';
      const deps = connections.map(connection => ({
        repository: createRunRepository(connection),
        decide: vi.fn(async () => ({ kind: 'final', content })),
      }));
      // Settle both requests before releasing either connection, even on failure.
      const settled = await Promise.allSettled(deps.map(d => runOneDecision(created.id, d)));
      expect(settled.every(result => result.status === 'fulfilled')).toBe(true);
      const results = settled.map(result => result.status === 'fulfilled' ? result.value : null);
      expect(results.filter(result => result?.kind === 'not_started')).toHaveLength(1);
      expect(results.filter(result => result?.kind === 'completed')).toEqual([{ kind: 'completed', content }]);
      expect(deps.reduce((count, d) => count + d.decide.mock.calls.length, 0)).toBe(1);
      deps.forEach((d, index) => {
        if (results[index]?.kind === 'completed') {
          expect(d.decide).toHaveBeenCalledExactlyOnceWith({ ...created, status: 'running' });
        } else expect(d.decide).not.toHaveBeenCalled();
      });
      const stored = { ...created, status: 'completed' };
      expect(await createRunRepository(client).findRunById(created.id)).toEqual(stored);
      const app = buildApp({ repository: createRunRepository(client), logger: false });
      try {
        const get = await app.inject(`/runs/${created.id}`);
        expect(get.statusCode).toBe(200);
        expect(get.json()).toEqual({ ...stored, createdAt: created.createdAt.toISOString() });
        console.info(JSON.stringify({ runtimeBackendPids: pids.map(p => p.rows[0].pid), resultKinds: results.map(r => r?.kind), decisionCalls: 1, getStatus: get.statusCode, runStatus: get.json().status, fieldsPreserved: true }));
      } finally { await app.close(); }
    } finally { connections.forEach(connection => connection.release()); }
  }, 15000);

  it.each(['completed', 'failed'] as const)('reports finalize_conflict and preserves an external %s winner', async outcome => {
    const repository = createRunRepository(client);
    const created = await repository.createRun('finalization conflict');
    const other = await pool.connect();
    try {
      await assertDatabaseIdentity(other, 'test');
      await other.query(`SET search_path TO "${schema}"`);
      await other.query("SET statement_timeout TO '5s'");
      const pidA = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pidB = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      expect(pidA).not.toBe(pidB);
      let externalWinner: Awaited<ReturnType<typeof repository.tryFinishRun>> | undefined;
      const decide = vi.fn(async () => {
        // Another connection wins after claim, before this Runtime can finalize.
        externalWinner = await createRunRepository(other).tryFinishRun(created.id, outcome);
        return outcome === 'failed'
          ? { kind: 'final', content: 'MUST_NOT_RETURN' }
          : { kind: 'tool_request', toolName: 'must_not_execute', arguments: { secret: 'MUST_NOT_RETURN' } };
      });
      expect(await runOneDecision(created.id, { repository, decide })).toEqual({ kind: 'finalize_conflict' });
      // Assert outside decide so Runtime cannot turn an assertion failure into a source error.
      expect(externalWinner).toEqual({ ...created, status: outcome });
      expect(decide).toHaveBeenCalledTimes(1);
      expect(await repository.findRunById(created.id)).toEqual({ ...created, status: outcome });
      const app = buildApp({ repository, logger: false });
      try {
        const get = await app.inject(`/runs/${created.id}`);
        expect(get.statusCode).toBe(200);
        expect(get.json()).toEqual({ ...created, status: outcome, createdAt: created.createdAt.toISOString() });
        console.info(JSON.stringify({ runtimeConflict: 'finalize_conflict', preservedWinner: outcome, getStatus: get.statusCode }));
      } finally { await app.close(); }
    } finally { other.release(); }
  });

  it.each(['missing', 'running', 'completed', 'failed'] as const)('does not decide or change a %s Run', async state => {
    const repository = createRunRepository(client);
    let id: string = randomUUID();
    if (state !== 'missing') {
      id = (await repository.createRun('not claimable')).id;
      await repository.tryStartRun(id);
      if (state !== 'running') await repository.tryFinishRun(id, state);
    }
    const before = await repository.findRunById(id);
    const decide = vi.fn(async () => ({ kind: 'final', content: 'not called' }));
    expect(await runOneDecision(id, { repository, decide })).toEqual({ kind: 'not_started' });
    expect(decide).not.toHaveBeenCalled();
    expect(await repository.findRunById(id)).toEqual(before);
  });

  // Deliberately bypass repository validation to exercise PostgreSQL constraints.
  it.each([
    ['valid', 'cancelled', '23514'],
    ['valid', null, '23502'],
    [null, 'queued', '23502'],
    ['', 'queued', '23514'],
    [' \t\n\r\u00a0\ufeff', 'queued', '23514'],
    ['a'.repeat(4001), 'queued', '23514'],
    ['😀'.repeat(4001), 'queued', '23514'],
  ])('DB rejects invalid task/status case %#', async (task, status, code) => {
    await expect(client.query('INSERT INTO runs (id, task, status) VALUES ($1,$2,$3)', [randomUUID(), task, status]))
      .rejects.toMatchObject({ code });
  });

  it('accepts exactly 4000 Unicode code points in both layers', async () => {
    const run = await createRunRepository(client).createRun('😀'.repeat(4000));
    expect((await client.query('SELECT char_length(task) AS size FROM runs WHERE id=$1', [run.id])).rows[0].size).toBe(4000);
  });

  it('enforces UUID primary key and rejects duplicates', async () => {
    const run = await createRunRepository(client).createRun('unique');
    await expect(client.query('INSERT INTO runs (id, task) VALUES ($1,$2)', [run.id, 'duplicate'])).rejects.toMatchObject({ code: '23505' });
    await expect(client.query("INSERT INTO runs (id, task) VALUES ('bad', 'task')")).rejects.toMatchObject({ code: '22P02' });
  });

  it('closes scoped pools on success and failure', async () => {
    let captured: Pool | undefined;
    const url = readDatabaseUrl('test');
    expect(await withDatabase(url, async (db) => {
      captured = db;
      return (await db.query('SELECT 42 AS value')).rows[0].value;
    })).toBe(42);
    await expect(captured!.query('SELECT 1')).rejects.toThrow();
    await expect(withDatabase(url, async (db) => {
      captured = db;
      await db.query('SELECT 1');
      throw new Error('intentional callback failure');
    })).rejects.toThrow('intentional callback failure');
    await expect(captured!.query('SELECT 1')).rejects.toThrow();
  });

  it('app.close ends its real owned PostgreSQL pool', async () => {
    const owned = createDatabase(readDatabaseUrl('test'));
    const app = buildApp({ databaseUrl: readDatabaseUrl('test'), databaseFactory: () => owned, logger: false });
    try {
      await owned.query('SELECT 1');
      expect(owned.totalCount).toBe(1);
      await app.close();
      await expect(owned.query('SELECT 1')).rejects.toThrow();
      expect(owned.totalCount).toBe(0);
    } finally { await app.close(); }
  });

  it('fails closed when the actual database identity is wrong', async () => {
    await expect(assertDatabaseIdentity(client, 'dev')).rejects.toThrow('identity mismatch');
    await expect(migrate('dev', 'down')).rejects.toThrow('Rollback');
  });
});
