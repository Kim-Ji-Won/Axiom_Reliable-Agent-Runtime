import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { InvalidRunInputError } from '@axiom/contracts';
import { createRunStepRepository, runStepResultKinds, type RunStep } from '../src/persistence/run-step-repository.js';

const id = '12345678-1234-4234-8234-123456789abc';
const timestamp = new Date('2026-11-12T00:00:00Z');
function setup() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: query as PoolClient['query'], release }));
  return { query, release, connect, repo: createRunStepRepository({ connect }) };
}
afterEach(() => vi.restoreAllMocks());

describe('Run Step repository boundaries', () => {
  it.each(['SECRET_SENTINEL', '', null, 1, {}, undefined])('rejects invalid UUID %# before acquiring a connection', async id => {
    const { repo, connect } = setup();
    await expect(repo.appendRunStep(id as string, 'completed')).rejects.toThrow(InvalidRunInputError);
    await expect(repo.listRunSteps(id as string)).rejects.toThrow('Invalid Run ID');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(['not_started', 'running', '', 'SECRET_SENTINEL', null, {}, 1, undefined])('rejects result kind %# before DB calls', async kind => {
    const { repo, connect } = setup();
    const logs = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = logs.map(method => vi.spyOn(console, method));
    await expect(repo.appendRunStep(id, kind as 'completed')).rejects.toThrow('Invalid Run Step result kind');
    expect(connect).not.toHaveBeenCalled();
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });
  it.each(runStepResultKinds)('returns only the four metadata fields for %s', async kind => {
    const { repo, query, release, connect } = setup();
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id }] })
      .mockResolvedValueOnce({ rows: [{ run_id: id, step_no: 1, result_kind: kind, created_at: timestamp, secret: 'SECRET_SENTINEL' }] });
    const result = await repo.appendRunStep(id, kind);
    expectTypeOf(result).toEqualTypeOf<RunStep | null>();
    expect(result).toEqual({ runId: id, stepNo: 1, resultKind: kind, createdAt: timestamp });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[2]?.[1]).toEqual([id, kind]);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('exposes only append and list and performs no model or tool calls', async () => {
    const { repo } = setup();
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(Object.keys(repo).sort()).toEqual(['appendRunStep', 'listRunSteps']);
    expect(await repo.appendRunStep(id, 'completed')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['missing', 'empty', 'populated'])('lists %s history with the four-field contract', async mode => {
    const { repo, query, release } = setup();
    query.mockResolvedValue({ rows: mode === 'missing' ? [] : [{ run_id: id, step_no: mode === 'empty' ? null : 1, result_kind: 'completed', created_at: timestamp }] });
    expect(await repo.listRunSteps(id)).toEqual(mode === 'missing' ? null : mode === 'empty' ? [] : [{ runId: id, stepNo: 1, resultKind: 'completed', createdAt: timestamp }]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(['append', 'list'])('propagates %s acquisition failures', async operation => {
    const { repo, connect, release } = setup();
    const error = new Error('connection failed');
    connect.mockRejectedValue(error);
    await expect(operation === 'append' ? repo.appendRunStep(id, 'completed') : repo.listRunSteps(id)).rejects.toBe(error);
    expect(release).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3])('rolls back and releases on failure at append operation %#', async failure => {
    const { repo, query, release } = setup();
    const error = new Error('DB failure');
    const replies = [{ rows: [] }, { rowCount: 1 }, { rows: [{ run_id: id, step_no: 1, result_kind: 'completed', created_at: timestamp }] }];
    for (let i = 0; i < failure; i++) query.mockResolvedValueOnce(replies[i]);
    query.mockRejectedValueOnce(error);
    await expect(repo.appendRunStep(id, 'completed')).rejects.toBe(error);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    expect(query).toHaveBeenCalledTimes(failure + 2);
  });
  it('discards a connection when rollback fails, retaining the original DB error', async () => {
    const { repo, query, release } = setup();
    const error = new Error('original DB failure');
    query.mockRejectedValueOnce(error).mockRejectedValueOnce(new Error('rollback failed'));
    await expect(repo.appendRunStep(id, 'completed')).rejects.toBe(error);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('propagates read failures and releases the connection', async () => {
    const { repo, query, release } = setup();
    const error = new Error('read failed');
    query.mockRejectedValue(error);
    await expect(repo.listRunSteps(id)).rejects.toBe(error);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
