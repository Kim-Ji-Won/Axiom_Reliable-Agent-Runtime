import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { InvalidRunInputError } from '@axiom/contracts';
import { createRunExecutionLeaseRepository } from '../src/persistence/run-execution-lease-repository.js';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const leaseToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function row(token = leaseToken) {
  return { run_id: runId, owner_id: ownerId, lease_token: token, lease_seconds: 1,
    acquired_at: '2026-11-15T00:00:00.000001Z', renewed_at: '2026-11-15T00:00:00.000001Z',
    expires_at: '2026-11-15T00:00:01.000001Z', time_valid: true, state: 'active' };
}
function setup(config: { status?: string | null; exists?: boolean; miss?: boolean;
  fault?: string; rollbackFault?: boolean; transform?: (r: ReturnType<typeof row>) => unknown; commit?: () => Promise<void> } = {}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (config.fault && (config.fault === 'COMMIT' ? sql === 'COMMIT' : sql.includes(config.fault))) throw new Error('private database detail');
    if (sql === 'ROLLBACK' && config.rollbackFault) throw new Error('private rollback detail');
    if (sql === 'COMMIT') await config.commit?.();
    if (sql.startsWith('SELECT status')) return { rows: config.status === null ? [] : [{ status: config.status ?? 'running' }] };
    if (sql.startsWith('SELECT run_id')) return { rows: config.exists ? [{ run_id: runId }] : [] };
    if (sql.includes('/* lease')) {
      const r = row(sql.includes('/* lease claim') ? values![2] as string : leaseToken);
      return { rows: config.miss ? [] : [config.transform ? config.transform(r) : r] };
    }
    return { rows: [] };
  });
  const release = vi.fn(); const connect = vi.fn(async () => ({ query: query as unknown as PoolClient['query'], release }));
  return { query, release, connect, repo: createRunExecutionLeaseRepository({ connect }) };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Lease unit barrier timeout')), 4000); })]); }
  finally { clearTimeout(timer); }
}
const renew = { ownerId, leaseToken }; const claim = { ownerId, leaseSeconds: 1 };

describe('execution Lease input and private snapshots', () => {
  it.each([undefined, null, 1, {}, [], '', 'TOKEN_SENTINEL', { toString() { throw new Error('must not coerce'); } }].map(value => ({ value })))('rejects non-UUID run input %# before connect', async ({ value }) => {
    const f = setup();
    await expect(f.repo.tryClaimRunLease(value as string, claim)).rejects.toBeInstanceOf(InvalidRunInputError);
    await expect(f.repo.tryRenewRunLease(value as string, renew)).rejects.toBeInstanceOf(InvalidRunInputError);
    await expect(f.repo.getRunLeaseSnapshot(value as string)).rejects.toBeInstanceOf(InvalidRunInputError);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 0, -1, 301, 1.5, NaN, Infinity, '1', true])('rejects invalid lease seconds %# before connect', async leaseSeconds => {
    const f = setup();
    await expect(f.repo.tryClaimRunLease(runId, { ownerId, leaseSeconds } as never)).rejects.toThrow('Invalid execution lease input');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, [], { ownerId }, { ...claim, now: 0 }, { ...claim, leaseToken }, { ...claim, expiresAt: 'future' }])('rejects incomplete or wider claim options %#', async options => {
    const f = setup(); await expect(f.repo.tryClaimRunLease(runId, options as never)).rejects.toThrow('Invalid execution lease input'); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, { ownerId }, { ...renew, leaseSeconds: 300 }, { ...renew, now: 0 }, { ...renew, expiresAt: 'future' }])('rejects incomplete or wider renew options %#', async options => {
    const f = setup(); await expect(f.repo.tryRenewRunLease(runId, options as never)).rejects.toThrow('Invalid execution lease input'); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['ownerId', 'leaseToken'])('rejects nonstring %s without coercion or connection', async key => {
    const f = setup(); const toString = vi.fn();
    await expect(f.repo.tryRenewRunLease(runId, { ...renew, [key]: { toString } })).rejects.toThrow('Invalid execution lease input');
    if (key === 'ownerId') await expect(f.repo.tryClaimRunLease(runId, { ...claim, ownerId: { toString } } as never)).rejects.toThrow('Invalid execution lease input');
    expect(toString).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it('does not invoke getters or proxy traps; rejects symbols and hidden extra options', async () => {
    const f = setup(); const trap = vi.fn(() => { throw new Error(); });
    for (const input of [Object.defineProperty({ leaseSeconds: 1 }, 'ownerId', { get: trap, enumerable: true }), new Proxy(claim, { get: trap, ownKeys: trap }), { ...claim, [Symbol()]: true }, Object.defineProperty({ ...claim }, 'extra', { value: true })]) {
      await expect(f.repo.tryClaimRunLease(runId, input as never)).rejects.toThrow('Invalid execution lease input');
    }
    expect(trap).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([1, 300])('accepts explicit %i seconds, normalizes uppercase UUIDs and returns immutable values', async leaseSeconds => {
    const f = setup({ status: 'queued', transform: r => ({ ...r, lease_seconds: leaseSeconds, expires_at: leaseSeconds === 1 ? r.expires_at : '2026-11-15T00:05:00.000001Z' }) });
    const result = await f.repo.tryClaimRunLease(runId.toUpperCase(), { ownerId: ownerId.toUpperCase(), leaseSeconds });
    expect(result?.runId).toBe(runId); expect(result?.ownerId).toBe(ownerId); expect(result?.leaseSeconds).toBe(leaseSeconds);
    expect(Object.isFrozen(result)).toBe(true); expect(typeof result?.acquiredAt).toBe('string');
    expect(result?.leaseToken).toMatch(/^[a-f\d-]{36}$/); expect(f.connect).toHaveBeenCalledTimes(1);
    const sql = f.query.mock.calls.map(c => c[0]); expect(sql[0]).toContain('READ COMMITTED');
    expect(sql[1]).toContain('FROM runs'); expect(sql[2]).toContain('FROM run_execution_leases');
    expect(sql[3]!.match(/clock_timestamp\(\)/g)).toHaveLength(1); expect(sql.at(-1)).toBe('COMMIT'); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('normalizes renewal ids and uses one post-lock DB sample without time parameters', async () => {
    const f = setup(); await f.repo.tryRenewRunLease(runId.toUpperCase(), { ownerId: ownerId.toUpperCase(), leaseToken: leaseToken.toUpperCase() });
    const calls = f.query.mock.calls; expect(calls[1]![0]).toContain('FROM runs'); expect(calls[2]![0]).toContain('FROM run_execution_leases');
    expect(calls[3]![1]).toEqual([runId, ownerId, leaseToken]); expect(calls[3]![0].match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(calls[3]![0]).toContain('expires_at > tick.t AND renewed_at <= tick.t'); expect(calls[3]![0]).not.toMatch(/CURRENT_TIMESTAMP|\bnow\(/);
  });
  it.each(['active', 'expired', 'run_not_running'])('snapshot %s never selects or returns Token; copies row', async state => {
    const original = { ...row(), state }; const f = setup({ transform: () => original });
    const snapshot = await f.repo.getRunLeaseSnapshot(runId);
    expect(snapshot?.state).toBe(state); expect(f.query.mock.calls[0]![0]).not.toContain('lease_token');
    expect(snapshot).not.toHaveProperty('leaseToken'); expect(JSON.stringify(snapshot)).not.toContain(leaseToken);
    original.owner_id = randomUUID(); expect(snapshot?.ownerId).toBe(ownerId); expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe('Lease transaction failure, visibility and no retry', () => {
  it.each([null, 'running', 'completed', 'failed'])('claim parent %s returns null without writes', async status => {
    const f = setup({ status }); expect(await f.repo.tryClaimRunLease(runId, claim)).toBeNull();
    expect(f.query.mock.calls.map(c => c[0])).toHaveLength(3); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('existing lease rejects claim even on a queued parent', async () => {
    const f = setup({ status: 'queued', exists: true }); expect(await f.repo.tryClaimRunLease(runId, claim)).toBeNull(); expect(f.query.mock.calls.some(c => c[0].includes('/* lease claim'))).toBe(false);
  });
  it.each([null, 'queued', 'completed', 'failed'])('renew parent %s refuses without writes', async status => {
    const f = setup({ status }); expect(await f.repo.tryRenewRunLease(runId, renew)).toBeNull(); expect(f.query).toHaveBeenCalledTimes(3);
  });
  it('missing/mismatched/expired renewal and missing snapshot return null, not DB error', async () => {
    const f = setup({ miss: true }); expect(await f.repo.tryRenewRunLease(runId, renew)).toBeNull(); expect(await f.repo.getRunLeaseSnapshot(runId)).toBeNull();
    const broken = setup({ fault: '/* lease renewal' }); await expect(broken.repo.tryRenewRunLease(runId, renew)).rejects.toThrow('private database detail');
  });
  it.each(['BEGIN', 'SELECT status', 'SELECT run_id', '/* lease claim', 'COMMIT'])('claim failure at %s rolls back and releases once without retry', async fault => {
    const f = setup({ status: 'queued', fault }); await expect(f.repo.tryClaimRunLease(runId, claim)).rejects.toThrow();
    expect(f.connect).toHaveBeenCalledTimes(1); expect(f.query.mock.calls.filter(c => c[0] === 'ROLLBACK')).toHaveLength(1);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(fault === 'COMMIT');
  });
  it.each(['/* lease renewal', 'COMMIT'])('renew failure at %s and rollback failure discard exactly once', async fault => {
    const f = setup({ fault, rollbackFault: true }); await expect(f.repo.tryRenewRunLease(runId, renew)).rejects.toThrow('private database detail'); expect(f.release).toHaveBeenCalledExactlyOnceWith(true); expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it('connect failure never attempts release or retries', async () => {
    const connect = vi.fn(async () => { throw new Error('unavailable'); }); const repo = createRunExecutionLeaseRepository({ connect });
    await expect(repo.tryClaimRunLease(runId, claim)).rejects.toThrow('unavailable'); expect(connect).toHaveBeenCalledTimes(1);
  });
  it.each(['claim', 'renew'])('%s returns no handle before COMMIT acknowledgement', async mode => {
    let finish!: () => void; let reached!: () => void; const barrier = new Promise<void>(r => { reached = r; }); const wait = new Promise<void>(r => { finish = r; });
    const f = setup({ status: mode === 'claim' ? 'queued' : 'running', commit: async () => { reached(); await bounded(wait); } });
    let settled = false; const pending = (mode === 'claim' ? f.repo.tryClaimRunLease(runId, claim) : f.repo.tryRenewRunLease(runId, renew)).finally(() => { settled = true; });
    void pending.catch(() => {});
    try { await bounded(barrier); expect(settled).toBe(false); expect(f.release).not.toHaveBeenCalled(); } finally { finish(); await pending; }
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(['run_id', 'owner_id', 'lease_token', 'lease_seconds', 'acquired_at', 'renewed_at', 'expires_at', 'time_valid'])('invalid returned %s fails closed and rolls back with sanitized error', async key => {
    const f = setup({ status: 'queued', transform: r => ({ ...r, [key]: 'TOKEN_SENTINEL' }) });
    await expect(f.repo.tryClaimRunLease(runId, claim)).rejects.toThrow('Invalid persisted execution lease');
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(['state', 'time_valid', 'acquired_at'])('invalid snapshot %s fails closed without leaking row content', async key => {
    const f = setup({ transform: r => ({ ...r, [key]: 'PRIVATE_ROW_SENTINEL' }) });
    await expect(f.repo.getRunLeaseSnapshot(runId)).rejects.toThrow('Invalid persisted execution lease');
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('rejects an impossible calendar date and a malformed renewal row before COMMIT', async () => {
    const f = setup({ transform: r => ({ ...r, renewed_at: '2026-02-31T00:00:00.000001Z' }) });
    await expect(f.repo.tryRenewRunLease(runId, renew)).rejects.toThrow('Invalid persisted execution lease');
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('invalid parent and getter row fail closed without getter execution', async () => {
    const f = setup({ status: 'unexpected' }); await expect(f.repo.tryRenewRunLease(runId, renew)).rejects.toThrow('Invalid persisted lease parent');
    const getter = vi.fn(); const g = setup({ transform: r => Object.defineProperty(r, 'state', { get: getter }) });
    await expect(g.repo.getRunLeaseSnapshot(runId)).rejects.toThrow('Invalid persisted execution lease'); expect(getter).not.toHaveBeenCalled(); expect(g.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('no automatic logging, model/tool execution or background work on success and failure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); const info = vi.spyOn(console, 'info').mockImplementation(() => {}); const error = vi.spyOn(console, 'error').mockImplementation(() => {}); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(() => { throw new Error('external call'); }); vi.stubGlobal('fetch', fetch);
    try {
      const f = setup(); await f.repo.tryRenewRunLease(runId, renew); await f.repo.getRunLeaseSnapshot(runId);
      const bad = setup({ fault: '/* lease renewal' }); await expect(bad.repo.tryRenewRunLease(runId, renew)).rejects.toThrow();
      expect(log).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
});
