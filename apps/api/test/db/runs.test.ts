import { buildApp } from '../../src/app.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  it('migrates an empty schema, records history, is repeatable, and supports rollback', async () => {
    expect(await migrate('test', 'up', schema)).toHaveLength(1);
    expect(await migrate('test', 'up', schema)).toHaveLength(0);
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(1);
    expect(await migrate('test', 'down', schema)).toHaveLength(1);
    expect((await client.query("SELECT to_regclass('runs') AS name")).rows[0].name).toBeNull();
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(0);
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

  // Deliberately bypass repository validation to exercise PostgreSQL constraints.
  it.each([
    ['valid', 'running', '23514'],
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
