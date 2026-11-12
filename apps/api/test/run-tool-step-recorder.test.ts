import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createRunToolStepRecorder } from '../src/persistence/run-tool-step-recorder.js';
const id = '12345678-1234-4234-8234-123456789abc';
const time = new Date();
function setup() {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT')) return { rows: [{ status: 'running' }] };
    if (sql.startsWith('INSERT')) return { rows: [{ run_id: id, step_no: 2, result_kind: 'tool_succeeded', created_at: time }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: query as unknown as PoolClient['query'], release }));
  return { query, release, connect, recorder: createRunToolStepRecorder({ connect }) };
}
afterEach(() => vi.restoreAllMocks());
describe('tool success Step recorder', () => {
  it.each(['ID_SENTINEL', '', null, undefined, 1, {}])('rejects UUID %# before acquiring a connection', async value => {
    const { recorder, connect } = setup();
    await expect(recorder.appendToolSucceededStepIfRunning(value as string)).rejects.toThrow('Invalid Run ID');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(['missing', 'queued', 'completed', 'failed'])('does not append to %s', async status => {
    const { recorder, query, release } = setup();
    query.mockResolvedValue({ rows: status === 'missing' ? [] : [{ status }] });
    expect(await recorder.appendToolSucceededStepIfRunning(id)).toBeNull();
    expect(query.mock.calls.map(c => c[0].split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'COMMIT']);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('commits metadata only after locking and reading the parent status', async () => {
    const { recorder, query, release, connect } = setup();
    expect(await recorder.appendToolSucceededStepIfRunning(id)).toEqual({ runId: id, stepNo: 2, resultKind: 'tool_succeeded', createdAt: time });
    expect(query.mock.calls.map(c => c[0].split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'INSERT', 'COMMIT']);
    expect(query).toHaveBeenCalledWith('SELECT status FROM runs WHERE id = $1 FOR UPDATE', [id]);
    expect(connect).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(['BEGIN', 'SELECT', 'INSERT', 'COMMIT'])('propagates %s failure and releases exactly once', async stage => {
    const { recorder, query, release } = setup();
    const original = query.getMockImplementation()!; const error = new Error('DB_SENTINEL');
    query.mockImplementation(async sql => { if (sql.startsWith(stage)) throw error; return original(sql); });
    await expect(recorder.appendToolSucceededStepIfRunning(id)).rejects.toBe(error);
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
    expect(query.mock.calls.filter(c => c[0].startsWith(stage))).toHaveLength(1);
    expect(release).toHaveBeenCalledExactlyOnceWith(stage === 'COMMIT');
  });
  it('discards rollback failure without replacing the original error', async () => {
    const { recorder, query, release } = setup(); const error = new Error('DB_SENTINEL');
    query.mockRejectedValueOnce(error).mockRejectedValueOnce(new Error('rollback failed'));
    await expect(recorder.appendToolSucceededStepIfRunning(id)).rejects.toBe(error);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('propagates connection acquisition failure', async () => {
    const { recorder, connect, query, release } = setup(); const error = new Error('DB_SENTINEL');
    connect.mockRejectedValue(error);
    await expect(recorder.appendToolSucceededStepIfRunning(id)).rejects.toBe(error);
    expect(query).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  });
  it('does not resolve or release before COMMIT acknowledgement', async () => {
    const { recorder, query, release } = setup(); const original = query.getMockImplementation()!;
    let acknowledge!: () => void;
    const gate = new Promise<void>(resolve => { acknowledge = resolve; });
    query.mockImplementation(async sql => { if (sql === 'COMMIT') await gate; return original(sql); });
    let resolved = false;
    const pending = recorder.appendToolSucceededStepIfRunning(id).then(value => { resolved = true; return value; });
    try {
      await vi.waitFor(() => expect(query).toHaveBeenCalledWith('COMMIT'));
      expect(resolved).toBe(false); expect(release).not.toHaveBeenCalled();
    } finally { acknowledge(); await pending; }
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
