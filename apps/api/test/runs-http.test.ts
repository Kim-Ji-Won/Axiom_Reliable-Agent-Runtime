import { afterEach, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';

const id = '12345678-1234-4234-8234-123456789abc';
const run = { id, task: '  회의록 정리 😀  ', status: 'queued' as const, createdAt: new Date('2026-11-06T00:00:00.000Z') };
const expected = { ...run, createdAt: run.createdAt.toISOString() };
const apps: ReturnType<typeof buildApp>[] = [];
function setup() {
  const repository = { tryFinishRun: vi.fn(), tryStartRun: vi.fn(), createRun: vi.fn().mockResolvedValue(run), findRunById: vi.fn().mockResolvedValue(run) };
  const app = buildApp({ repository, logger: false });
  apps.push(app);
  return { app, repository };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

it('creates and reads the same four-field contract preserving raw task', async () => {
  const { app, repository } = setup();
  const post = await app.inject({ method: 'POST', url: '/runs', payload: { task: run.task } });
  expect(post.statusCode).toBe(201);
  expect(post.json()).toEqual(expected);
  expect(repository.createRun).toHaveBeenCalledWith(run.task);
  const get = await app.inject(`/runs/${id}`);
  expect(get.statusCode).toBe(200);
  expect(get.json()).toEqual(post.json());
});

it.each([{}, { task: '' }, { task: ' \n\t' }, { task: 1 }, { task: null },
  { task: 'ok', id }, { task: 'ok', status: 'queued' }, { task: 'ok', status: 'running' }, { task: 'ok', status: 'completed' }, { task: 'ok', status: 'failed' }, { task: 'ok', extra: true },
  { task: 'a'.repeat(4001) }, { task: '😀'.repeat(4001) }, { task: 'x\0y' },
  { task: '\ud800' }, { task: '\udc00' }, [], null])('rejects invalid body case %# before calling repository', async payload => {
  const { app, repository } = setup();
  const response = await app.inject({ method: 'POST', url: '/runs', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe('INVALID_REQUEST');
  expect(repository.createRun).not.toHaveBeenCalled();
});

it('accepts exactly 4000 emoji code points without trimming', async () => {
  const { app, repository } = setup();
  const task = '😀'.repeat(4000);
  repository.createRun.mockResolvedValue({ ...run, task });
  const response = await app.inject({ method: 'POST', url: '/runs', payload: { task } });
  expect(response.statusCode).toBe(201);
  expect(response.json().task).toBe(task);
});
it('rejects invalid UUID before calling repository', async () => {
  const { app, repository } = setup();
  const response = await app.inject('/runs/not-a-uuid');
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe('INVALID_REQUEST');
  expect(repository.findRunById).not.toHaveBeenCalled();
});
it('returns 404 for a valid missing UUID', async () => {
  const { app, repository } = setup();
  repository.findRunById.mockResolvedValue(null);
  const response = await app.inject(`/runs/${id}`);
  expect(response.statusCode).toBe(404);
  expect(response.json().error.code).toBe('RUN_NOT_FOUND');
});
it.each([
  ['{', 'application/json', 400],
  ['hello', 'application/octet-stream', 415],
  [JSON.stringify({ task: 'x'.repeat(1048576) }), 'application/json', 413],
])('preserves parser HTTP status %#', async (payload, contentType, status) => {
  const { app, repository } = setup();
  const response = await app.inject({ method: 'POST', url: '/runs', payload, headers: { 'content-type': contentType } });
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe('INVALID_REQUEST');
  expect(repository.createRun).not.toHaveBeenCalled();
});
it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '28P01', '57P01', '08006'])('maps DB outage %s to sanitized 503', async code => {
  const { app, repository } = setup();
  const error = Object.assign(new Error('postgres://user:secret@host SELECT private_task'), { code });
  repository.createRun.mockRejectedValue(error);
  repository.findRunById.mockRejectedValue(error);
  for (const response of [await app.inject({ method: 'POST', url: '/runs', payload: { task: 'ok' } }), await app.inject(`/runs/${id}`)]) {
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' } });
  }
});
it('maps pool timeout and aggregate connection errors to 503', async () => {
  const { app, repository } = setup();
  for (const error of [new Error('Connection terminated due to connection timeout'), new AggregateError([Object.assign(new Error('secret'), { code: 'ECONNREFUSED' })])]) {
    repository.findRunById.mockRejectedValue(error);
    expect((await app.inject(`/runs/${id}`)).statusCode).toBe(503);
  }
});
it('sanitizes unexpected failures and invalid response contracts in responses and logs', async () => {
  const logs: string[] = [];
  const repository = { tryFinishRun: vi.fn(), tryStartRun: vi.fn(), createRun: vi.fn().mockRejectedValue(new Error('SECRET_URL SQL private_task')), findRunById: vi.fn().mockResolvedValue({ ...run, status: 'SECRET_STATUS' }) };
  const app = buildApp({ repository, logger: { stream: { write: (line: string) => { logs.push(line); } } } });
  apps.push(app);
  const post = await app.inject({ method: 'POST', url: '/runs', payload: { task: 'private_task' } });
  const get = await app.inject(`/runs/${id}`);
  expect(post.statusCode).toBe(500);
  expect(get.statusCode).toBe(500);
  expect(post.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  await app.inject('/runs/SECRET_URL');
  expect(logs.join('')).not.toMatch(/SECRET|SQL|private_task/);
});
it('keeps liveness available without DB configuration', async () => {
  const app = buildApp({ logger: false }); apps.push(app);
  expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
  expect((await app.inject({ method: 'POST', url: '/runs', payload: { task: 'ok' } })).statusCode).toBe(503);
  expect((await app.inject(`/runs/${id}`)).statusCode).toBe(503);
});
it('owns one pool, reuses it, and ends it once on close', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ id, task: run.task, status: 'queued', created_at: run.createdAt }] });
  const end = vi.fn().mockResolvedValue(undefined);
  const databaseFactory = vi.fn().mockReturnValue({ query, end } as unknown as Pool);
  const app = buildApp({ databaseUrl: 'postgresql://localhost/test', databaseFactory, logger: false });
  await app.inject({ method: 'POST', url: '/runs', payload: { task: run.task } });
  await app.inject(`/runs/${id}`);
  expect(databaseFactory).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledTimes(2);
  expect(end).not.toHaveBeenCalled();
  await app.close(); await app.close();
  expect(end).toHaveBeenCalledTimes(1);
});
it('keeps liveness available after connection failure', async () => {
  const { app, repository } = setup();
  repository.findRunById.mockRejectedValue(Object.assign(new Error('secret'), { code: 'ECONNREFUSED' }));
  expect((await app.inject(`/runs/${id}`)).statusCode).toBe(503);
  expect((await app.inject('/health')).statusCode).toBe(200);
});

it('invalid DB configuration does not prevent startup or expose its value', async () => {
  const app = buildApp({ databaseUrl: 'invalid-secret', logger: false }); apps.push(app);
  expect((await app.inject('/health')).statusCode).toBe(200);
  const response = await app.inject(`/runs/${id}`);
  expect(response.statusCode).toBe(503);
  expect(response.body).not.toContain('invalid-secret');
});

it.each([
  ['/runs/A3_SENTINEL%ZZ', 400],
  [`/runs/${'A3_SENTINEL'.padEnd(101, 'x')}`, 414],
])('sanitizes router-level error %s', async (url, status) => {
  const logs: string[] = [];
  const repository = { tryFinishRun: vi.fn(), tryStartRun: vi.fn(), createRun: vi.fn(), findRunById: vi.fn() };
  const app = buildApp({ repository, logger: { stream: { write: (line: string) => { logs.push(line); } } } });
  apps.push(app);
  const response = await app.inject({ method: 'GET', url });
  expect.soft(response.statusCode).toBe(status);
  expect.soft(response.json()).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } });
  expect.soft(logs.join('')).not.toContain('A3_SENTINEL');
  expect.soft(repository.createRun).not.toHaveBeenCalled();
  expect.soft(repository.findRunById).not.toHaveBeenCalled();
});

it.each(['running', 'completed', 'failed'])('returns %s through the existing GET contract', async status => {
  const { app, repository } = setup();
  repository.findRunById.mockResolvedValue({ ...run, status });
  const response = await app.inject(`/runs/${id}`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ...expected, status });
});
