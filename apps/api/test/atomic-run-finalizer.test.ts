import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { InvalidRunInputError } from '@axiom/contracts';
import { createAtomicRunFinalizer, finalizationResultKinds, type FinalizationResultKind } from '../src/persistence/atomic-run-finalizer.js';

const id = '12345678-1234-4234-8234-123456789abc';
const time = new Date('2026-11-12T00:00:00Z');
function setup(kind: FinalizationResultKind = 'completed') {
  const status = kind === 'completed' ? 'completed' : 'failed';
  const run = { id, task: 'TASK_SENTINEL', status, createdAt: time };
  const step = { runId: id, stepNo: 3, resultKind: kind, createdAt: time };
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE')) return { rows: [{ id, task: run.task, status, created_at: time, extra: 'HIDDEN' }] };
    if (sql.startsWith('INSERT')) return { rows: [{ run_id: id, step_no: 3, result_kind: kind, created_at: time, extra: 'HIDDEN' }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: query as PoolClient['query'], release }));
  return { query, release, connect, run, step, finalizer: createAtomicRunFinalizer({ connect }) };
}
afterEach(() => vi.restoreAllMocks());

describe('atomic Run finalizer', () => {
  it.each(['SECRET_SENTINEL', '', null, 1, {}, undefined])('rejects invalid ID %# before connection acquisition', async invalid => {
    const { finalizer, connect } = setup();
    await expect(finalizer.tryFinalizeWithStep(invalid as string, 'completed')).rejects.toThrow(InvalidRunInputError);
    await expect(finalizer.tryFinalizeWithStep(invalid as string, 'completed')).rejects.toThrow('Invalid Run ID or finalization result kind');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(['not_started', 'finalize_conflict', 'failed', '', 'SECRET_SENTINEL', null, {}, 1, undefined])('rejects result kind %# without input exposure or DB access', async kind => {
    const { finalizer, connect } = setup();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method));
    await expect(finalizer.tryFinalizeWithStep(id, kind as FinalizationResultKind)).rejects.toThrow('Invalid Run ID or finalization result kind');
    expect(connect).not.toHaveBeenCalled();
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });
  it.each(finalizationResultKinds)('commits the matching Run and Step for %s on one lease', async kind => {
    const { finalizer, query, release, connect, run, step } = setup(kind);
    expect(await finalizer.tryFinalizeWithStep(id, kind)).toEqual({ run, step });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.map(c => c[0].split(' ')[0])).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);
    expect(query.mock.calls[0]![0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(query.mock.calls[1]![0]).toContain("WHERE id = $1 AND status = 'running'");
    expect(query.mock.calls[1]![1]).toEqual([id, run.status]);
    expect(query.mock.calls[2]![1]).toEqual([id, kind]);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('commits a zero-row UPDATE without inserting a Step', async () => {
    const { finalizer, query, release } = setup();
    query.mockResolvedValue({ rows: [] });
    expect(await finalizer.tryFinalizeWithStep(id, 'completed')).toBeNull();
    expect(query.mock.calls.map(c => c[0].split(' ')[0])).toEqual(['BEGIN', 'UPDATE', 'COMMIT']);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('does not resolve or release until COMMIT acknowledges success', async () => {
    const { finalizer, query, release } = setup();
    const original = query.getMockImplementation()!;
    let acknowledge!: () => void;
    const commit = new Promise<void>(resolve => { acknowledge = resolve; });
    query.mockImplementation(async sql => sql === 'COMMIT' ? commit : original(sql));
    let resolved = false;
    const pending = finalizer.tryFinalizeWithStep(id, 'completed').then(r => { resolved = true; return r; });
    try {
      await vi.waitFor(() => expect(query).toHaveBeenCalledWith('COMMIT'));
      expect(resolved).toBe(false);
      expect(release).not.toHaveBeenCalled();
    } finally { acknowledge(); await pending; }
    expect(resolved).toBe(true);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(['BEGIN', 'UPDATE', 'INSERT', 'COMMIT'])('propagates %s failure, rolls back, and never retries', async stage => {
    const { finalizer, query, release } = setup();
    const original = query.getMockImplementation()!;
    const error = new Error('DB_SENTINEL');
    query.mockImplementation(async sql => { if (sql.startsWith(stage)) throw error; return original(sql); });
    await expect(finalizer.tryFinalizeWithStep(id, 'completed')).rejects.toBe(error);
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
    expect(query.mock.calls.filter(c => c[0].startsWith(stage))).toHaveLength(1);
    if (stage === 'UPDATE') expect(query.mock.calls.some(c => c[0].startsWith('INSERT'))).toBe(false);
    // Includes a lost COMMIT response even when a subsequent rollback succeeds.
    expect(release).toHaveBeenCalledExactlyOnceWith(stage === 'COMMIT');
  });
  it('discards rollback failures and preserves the original error', async () => {
    const { finalizer, query, release } = setup();
    const original = new Error('original failure');
    query.mockRejectedValueOnce(original).mockRejectedValueOnce(new Error('rollback failure'));
    await expect(finalizer.tryFinalizeWithStep(id, 'completed')).rejects.toBe(original);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('propagates acquisition errors without releasing an unacquired client', async () => {
    const { finalizer, connect, query, release } = setup();
    const error = new Error('acquisition failure');
    connect.mockRejectedValue(error);
    await expect(finalizer.tryFinalizeWithStep(id, 'completed')).rejects.toBe(error);
    expect(query).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
