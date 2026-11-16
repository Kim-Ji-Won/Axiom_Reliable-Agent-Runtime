import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createRunContinueRecorder } from '../src/persistence/run-continue-recorder.js';
import { createRunToolStepRecorder } from '../src/persistence/run-tool-step-recorder.js';
import { createAtomicRunFinalizer } from '../src/persistence/atomic-run-finalizer.js';
import { createRunToolResultRepository } from '../src/persistence/run-tool-result-repository.js';
import { createToolResultPolicy } from '../src/tools/tool-result-policy.js';
import type { LeaseWriteCredentials } from '../src/persistence/lease-write-guard.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const leaseToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const credentials = { ownerId, leaseToken };
const outcome = { kind: 'tool_succeeded', output: { raw: 'RAW_PRIVATE' } };
const modes = ['continue', 'tool', 'final', 'result'] as const;
type Mode = typeof modes[number];
function setup(mode: Mode, options: { denied?: boolean; fault?: string; rollbackFault?: boolean; noPolicy?: boolean; gate?: Promise<void>; commitGate?: Promise<void>; malformed?: boolean } = {}) {
  const time = new Date('2026-11-15T00:00:00Z');
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (options.fault && (options.fault === 'COMMIT' ? sql === 'COMMIT' : sql.includes(options.fault))) throw new Error('INTERNAL_ERROR_SENTINEL');
    if (sql === 'ROLLBACK' && options.rollbackFault) throw new Error('ROLLBACK_SENTINEL');
    if (sql === 'COMMIT') await options.commitGate;
    if (sql.startsWith('SELECT status')) return { rows: [{ status: 'running' }] };
    if (sql.includes('/* lease write guard */') && options.denied) return { rows: [] };
    if (sql.includes('UPDATE runs')) return { rows: [{ id, task: 'task', status: 'completed', created_at: time }] };
    if (sql.includes('INSERT INTO run_tool_results')) return { rows: [{ run_id: id, step_no: 1, result_kind: 'tool_succeeded', schema_version: 1, status: 'ok', item_count: 1, created_at: time, expires_at: new Date(time.getTime() + 1000), ttl_valid: true }] };
    if (sql.includes('INSERT INTO run_steps')) return { rows: [{ run_id: id, step_no: options.malformed ? 0 : 1, result_kind: mode === 'continue' ? 'continued' : mode === 'final' ? 'completed' : 'tool_succeeded', created_at: time }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => { await options.gate; return { query: query as unknown as PoolClient['query'], release }; });
  const db = { connect };
  const project = vi.fn(() => ({ schemaVersion: 1, status: 'ok', itemCount: 1 }));
  const policy = options.noPolicy ? undefined : createToolResultPolicy([{ name: 'fixture', retentionSeconds: 1, project }]);
  const call = (runId: string, input: LeaseWriteCredentials) => {
    if (mode === 'continue') return createRunContinueRecorder(db).appendContinuedStepWithLease(runId, input);
    if (mode === 'tool') return createRunToolStepRecorder(db).appendToolSucceededStepWithLease(runId, input);
    if (mode === 'final') return createAtomicRunFinalizer(db).tryFinalizeWithStepWithLease(runId, 'completed', input);
    return createRunToolResultRepository(db, policy).appendToolSucceededStepWithSafeResultWithLease(runId, 'fixture', outcome, input);
  };
  return { call, query, connect, release, project };
}
describe.each(modes)('%s Lease-aware input and transaction boundary', mode => {
  it.each([undefined, null, {}, [], { ownerId }, { leaseToken }, { ...credentials, now: 0 }, { ...credentials, TTL: 1 },
    { ...credentials, skipLease: true }, { ...credentials, force: true }, { ...credentials, authorized: true },
    { ...credentials, expiresAt: 'future' }, { ...credentials, ownerId: 1 }, { ...credentials, leaseToken: {} }])('rejects malformed credentials %# before DB or policy', async raw => {
    const f = setup(mode, { noPolicy: true });
    await expect(f.call(id, raw as LeaseWriteCredentials)).rejects.toThrow('Invalid lease write input');
    expect(f.connect).not.toHaveBeenCalled(); expect(f.project).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 1, {}, '', 'TOKEN_PRIVATE'])('rejects nonstring or invalid Run %#', async value => {
    const f = setup(mode); await expect(f.call(value as string, credentials)).rejects.toThrow('Invalid lease write input');
    expect(f.connect).not.toHaveBeenCalled(); expect(f.project).not.toHaveBeenCalled();
  });
  it('never invokes getters/setters/proxy traps/coercion; rejects hidden/symbol/prototype options', async () => {
    const effect = vi.fn(() => { throw new Error('PRIVATE'); });
    const raw = [
      Object.defineProperty({ leaseToken }, 'ownerId', { get: effect, enumerable: true }),
      Object.defineProperty({ leaseToken }, 'ownerId', { set: effect, enumerable: true }),
      new Proxy(credentials, { get: effect, ownKeys: effect, getPrototypeOf: effect }),
      { ownerId: { toString: effect }, leaseToken }, { ...credentials, [Symbol()]: 1 },
      Object.defineProperty({ ...credentials }, 'hidden', { value: 1 }), Object.create(credentials),
    ];
    const f = setup(mode);
    for (const input of raw) await expect(f.call(id, input)).rejects.toThrow('Invalid lease write input');
    expect(effect).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it('captures normalized primitives before await and never rereads mutated credentials', async () => {
    let unlock!: () => void; const gate = new Promise<void>(r => { unlock = r; });
    const f = setup(mode, { gate }); const input = { ownerId: ownerId.toUpperCase(), leaseToken: leaseToken.toUpperCase() };
    const pending = f.call(id.toUpperCase(), input);
    input.ownerId = randomUUID(); Object.defineProperty(input, 'leaseToken', { get() { throw new Error('late getter'); } });
    unlock(); const result = await pending;
    const guard = f.query.mock.calls.find(c => c[0].includes('/* lease write guard */'))!;
    expect(guard[1]?.slice(0, 3)).toEqual([id, ownerId, leaseToken]);
    expect(JSON.stringify(result)).not.toContain(leaseToken); expect(JSON.stringify(result)).not.toContain('RAW_PRIVATE');
    expect(f.query.mock.calls.slice(0, 3).map(c => c[0])).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT status FROM runs WHERE id = $1 FOR UPDATE',
      'SELECT run_id FROM run_execution_leases WHERE run_id = $1 FOR UPDATE']);
    expect(guard[0].match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(guard[0]).toContain('l.expires_at > t AND l.renewed_at <= t');
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    if (mode === 'result') expect(f.project.mock.invocationCallOrder[0]).toBeLessThan(f.connect.mock.invocationCallOrder[0]!);
  });
  it('malformed parent rows fail with a fixed error instead of normal refusal', async () => {
    const f = setup(mode); const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => sql.startsWith('SELECT status') ? { rows: [{ status: 'PRIVATE_BAD_STATUS' }] } : original(sql, values));
    await expect(f.call(id, credentials)).rejects.toThrow('Invalid persisted write parent');
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('guard zero rows returns null without a later write or aggregate fallback', async () => {
    const f = setup(mode, { denied: true }); expect(await f.call(id, credentials)).toBeNull();
    expect(f.query).toHaveBeenCalledTimes(5); expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    if (mode !== 'final') expect(f.query.mock.calls[3]![0]).toContain('FROM lease_write_guard g');
  });
  it.each(['BEGIN', 'SELECT status', 'SELECT run_id', '/* lease write guard */', 'COMMIT'])('propagates %s failure once, rolls back, never retries', async fault => {
    const f = setup(mode, { fault });
    await expect(f.call(id, credentials)).rejects.toThrow('INTERNAL_ERROR_SENTINEL');
    expect(f.connect).toHaveBeenCalledTimes(1); expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(f.release).toHaveBeenCalledExactlyOnceWith(fault === 'COMMIT');
  });
  it('discards rollback failure exactly once', async () => {
    const f = setup(mode, { fault: '/* lease write guard */', rollbackFault: true });
    await expect(f.call(id, credentials)).rejects.toThrow('INTERNAL_ERROR_SENTINEL');
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('rejects malformed persisted Step with fixed error and rollback', async () => {
    const f = setup(mode, { malformed: true });
    await expect(f.call(id, credentials)).rejects.toThrow(/Unexpected persisted|Invalid saved/);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('does not return success before COMMIT acknowledgement', async () => {
    let ack!: () => void; const commitGate = new Promise<void>(r => { ack = r; });
    const f = setup(mode, { commitGate }); let settled = false;
    const pending = f.call(id, credentials).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith('COMMIT'));
      expect(settled).toBe(false); expect(f.release).not.toHaveBeenCalled();
    } finally { ack(); await pending; }
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
it('valid credential does not substitute for Safe Result Policy', async () => {
  const f = setup('result', { noPolicy: true });
  expect(await f.call(id, credentials)).toEqual({ kind: 'no_store' }); expect(f.connect).not.toHaveBeenCalled();
});
it('new methods perform no logging or automatic external requests', async () => {
  const logs = (['log', 'warn', 'error', 'info'] as const).map(k => vi.spyOn(console, k).mockImplementation(() => {}));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    for (const mode of modes) {
      await setup(mode).call(id, credentials);
      await expect(setup(mode, { fault: 'COMMIT' }).call(id, credentials)).rejects.toThrow();
    }
    logs.forEach(log => expect(log).not.toHaveBeenCalled()); expect(fetch).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

it.each(['continued','finalize_conflict','failed','PRIVATE_KIND',undefined])('Lease Finalizer rejects resultKind %# before connection',async kind=>{
  const connect=vi.fn();const repo=createAtomicRunFinalizer({connect});
  await expect(repo.tryFinalizeWithStepWithLease(id,kind as never,credentials)).rejects.toThrow('Invalid Run ID or finalization result kind');
  expect(connect).not.toHaveBeenCalled();
});
