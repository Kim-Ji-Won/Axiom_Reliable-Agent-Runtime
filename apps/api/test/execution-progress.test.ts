import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { InvalidRunInputError } from '@axiom/contracts';
import { createRunExecutionProgressRepository } from '../src/persistence/run-execution-progress-repository.js';

const id = randomUUID(); const credentials = { ownerId: randomUUID(), leaseToken: randomUUID() };
const modes = ['initialize', 'decision', 'tool', 'confirm', 'snapshot'] as const;
type Mode = typeof modes[number];
type Repo = ReturnType<typeof createRunExecutionProgressRepository>;
function call(repo: Repo, mode: Mode, key: unknown = id, c: unknown = credentials, input?: unknown) {
  if (mode === 'snapshot') return repo.getProgressSnapshot(key as string);
  if (mode === 'initialize') return repo.initializeProgress(key as string, c as typeof credentials, (input === undefined ? { maxDecisions: 5, maxToolAttempts: 1 } : input) as never);
  if (mode === 'confirm') return repo.tryConfirmCommittedStep(key as string, c as typeof credentials, (input === undefined ? { expectedVersion: 0, stepNo: 1 } : input) as never);
  return repo[mode === 'decision' ? 'tryReserveDecision' : 'tryReserveToolAttempt'](key as string, c as typeof credentials, (input === undefined ? 0 : input) as number);
}
const row = { run_id: id, schema_version: 1, checkpoint_version: 1, last_confirmed_step_no: null,
  max_decisions: 5, decisions_reserved: 1, max_tool_attempts: 1, tool_attempts_reserved: 0,
  created_at: '2026-11-18T00:00:00.000001Z', updated_at: '2026-11-18T00:00:00.000002Z',
  run_status: 'running', lease_state: 'active', max_step_no: null, diagnostic: 'aligned' };
function fixture(intercept?: (sql: string) => Promise<void>, data: unknown = row) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    await intercept?.(sql);
    if (sql.startsWith('SELECT status')) return { rows: [{ status: 'running' }] };
    if (sql.includes('/* lease write guard */') || sql.includes('/* progress snapshot */')) return { rows: data === null ? [] : [data] };
    return { rows: [] };
  });
  const release = vi.fn(); const connect = vi.fn(async () => ({ query: query as unknown as PoolClient['query'], release }));
  return { repo: createRunExecutionProgressRepository({ connect }), connect, query, release };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function hostile(valid: object) {
  const invoked = vi.fn(() => { throw new Error('PRIVATE'); });
  const key = Object.keys(valid)[0]!;
  const accessor = { ...valid }; Object.defineProperty(accessor, key, { enumerable: true, get: invoked, set: invoked });
  const hidden = { ...valid }; Object.defineProperty(hidden, key, { enumerable: false, value: 1 });
  const proxy = new Proxy(valid, { get: invoked, ownKeys: invoked, getPrototypeOf: invoked, getOwnPropertyDescriptor: invoked });
  const revocable = Proxy.revocable(valid, {}); revocable.revoke();
  return { invoked, cases: [null, false, [], 'PRIVATE', Object.create(valid), {}, { ...valid, override: true },
    { ...valid, [Symbol('override')]: true }, accessor, hidden, proxy, revocable.proxy] };
}
describe('Progress validation before connection', () => {
  it.each(modes.flatMap(mode => [null, 1, '', 'bad', {}, new String(id)].map(key => ({ mode, key }))))('$mode rejects invalid ID $key', async ({ mode, key }) => {
    const f = fixture(); await expect(call(f.repo, mode, key)).rejects.toBeInstanceOf(InvalidRunInputError); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(modes.filter(m => m !== 'snapshot'))('%s rejects hostile credentials without executing accessors/traps', async mode => {
    const h = hostile(credentials); const f = fixture();
    for (const c of [...h.cases, { ...credentials, ownerId: 'bad' }, { ...credentials, leaseToken: new String(id) }]) await expect(call(f.repo, mode, id, c)).rejects.toBeInstanceOf(InvalidRunInputError);
    expect(h.invoked).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['initialize', 'confirm'] as const)('%s rejects hostile option envelopes without execution', async mode => {
    const h = hostile(mode === 'initialize' ? { maxDecisions: 5, maxToolAttempts: 1 } : { expectedVersion: 0, stepNo: 1 }); const f = fixture();
    for (const input of h.cases) await expect(call(f.repo, mode, id, credentials, input)).rejects.toThrow('Invalid execution progress input');
    expect(h.invoked).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1, 1.1, 2147483648, '1', null, {}, new Number(1)])('rejects invalid version %s on every versioned API', async value => {
    const f = fixture();
    for (const m of ['decision', 'tool', 'confirm'] as const) await expect(call(f.repo, m, id, credentials, m === 'confirm' ? { expectedVersion: value, stepNo: 1 } : value)).rejects.toBeInstanceOf(InvalidRunInputError);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.1, Infinity, 2147483648, '1', null, {}])('rejects invalid step %s', async stepNo => {
    const f = fixture(); await expect(call(f.repo, 'confirm', id, credentials, { expectedVersion: 0, stepNo })).rejects.toBeInstanceOf(InvalidRunInputError); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([{ maxDecisions: 0, maxToolAttempts: 0 }, { maxDecisions: 6, maxToolAttempts: 1 }, { maxDecisions: 1.5, maxToolAttempts: 0 }, { maxDecisions: 1, maxToolAttempts: -1 }, { maxDecisions: 1, maxToolAttempts: 2 }, { maxDecisions: '1', maxToolAttempts: 0 }])('rejects invalid budget $maxDecisions/$maxToolAttempts', async input => {
    const f = fixture(); await expect(call(f.repo, 'initialize', id, credentials, input)).rejects.toBeInstanceOf(InvalidRunInputError); expect(f.connect).not.toHaveBeenCalled();
  });
});
describe('Progress transaction and privacy', () => {
  it.each(modes)('%s is frozen, contains only metadata and never logs', async mode => {
    const log = vi.spyOn(console, 'log'); const warn = vi.spyOn(console, 'warn'); const error = vi.spyOn(console, 'error');
    try {
      const f = fixture(); const result = await call(f.repo, mode);
      expect(Object.isFrozen(result)).toBe(true); expect(JSON.stringify(result)).not.toMatch(/leaseToken|ownerId|PRIVATE|resumable|canReplay/);
      expect(Object.values(result!)).not.toContainEqual(expect.any(Date));
      expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
      if (mode === 'snapshot') { expect(f.query).toHaveBeenCalledTimes(1); expect(f.query.mock.calls[0]![0]).not.toMatch(/lease_token|task|FOR UPDATE|INSERT|DELETE/); }
    } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });
  it.each(modes.filter(m => m !== 'snapshot'))('%s captures input, completes locks before DML and waits for COMMIT ack', async mode => {
    const begin = gate(); const commit = gate(); const arrived = gate();
    const f = fixture(async sql => { if (sql.startsWith('BEGIN')) await begin.promise; if (sql === 'COMMIT') { arrived.resolve(); await commit.promise; } });
    const c = { ...credentials }; const input = mode === 'initialize' ? { maxDecisions: 5, maxToolAttempts: 1 } : mode === 'confirm' ? { expectedVersion: 0, stepNo: 1 } : 0;
    let done = false; const pending = call(f.repo, mode, id.toUpperCase(), c, input).then(r => { done = true; return r; });
    c.ownerId = randomUUID(); c.leaseToken = randomUUID(); if (typeof input === 'object') Object.assign(input, { maxDecisions: 1, maxToolAttempts: 0, expectedVersion: 99, stepNo: 9 });
    try {
      begin.resolve(); await arrived.promise; expect(done).toBe(false); expect(f.release).not.toHaveBeenCalled();
      const calls = f.query.mock.calls; expect(calls.slice(0, 4).map(c => c[0])).toEqual([
        'BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT status FROM runs WHERE id = $1 FOR UPDATE',
        'SELECT run_id FROM run_execution_leases WHERE run_id = $1 FOR UPDATE', 'SELECT run_id FROM run_execution_progress WHERE run_id = $1 FOR UPDATE']);
      expect(calls[4]![1]).toEqual([id, credentials.ownerId, credentials.leaseToken, ...(mode === 'initialize' ? [5, 1] : mode === 'confirm' ? [0, 1] : [0])]);
      expect(calls[4]![0].match(/clock_timestamp\(\)/g)).toHaveLength(1);
    } finally { begin.resolve(); commit.resolve(); await pending; }
    expect(done).toBe(true); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(modes)('%s returns null for absence/guard denial', async mode => { const f = fixture(undefined, null); expect(await call(f.repo, mode)).toBeNull(); expect(f.release).toHaveBeenCalledExactlyOnceWith(false); });
  it.each(['BEGIN', 'SELECT status', 'SELECT run_id FROM run_execution_leases', 'SELECT run_id FROM run_execution_progress', '/* lease write guard */', 'COMMIT'])('rolls back %s error without retry', async stage => {
    const failure = new Error('internal failure'); const f = fixture(async sql => { if (sql.startsWith(stage)) throw failure; });
    await expect(call(f.repo, 'decision')).rejects.toBe(failure); expect(f.query.mock.calls.filter(c => c[0] === 'ROLLBACK')).toHaveLength(1);
    expect(f.connect).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledExactlyOnceWith(stage === 'COMMIT');
  });
  it('discards exactly once if rollback fails and preserves original error', async () => {
    const error = new Error('original'); const f = fixture(async s => { if (s.includes('/* lease write guard */')) throw error; if (s === 'ROLLBACK') throw new Error('rollback'); });
    await expect(call(f.repo, 'tool')).rejects.toBe(error); expect(f.release).toHaveBeenCalledExactlyOnceWith(true); expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...row, checkpoint_version: -1 }, { ...row, schema_version: 2 }, { ...row, decisions_reserved: 6 }, { ...row, tool_attempts_reserved: 2 }, { ...row, updated_at: 'infinity' }, { ...row, run_id: randomUUID() }, new Proxy(row, { get: () => { throw new Error('PRIVATE'); } })])('rejects invalid persisted metadata without exposing it', async data => {
    const f = fixture(undefined, data); await expect(call(f.repo, 'decision')).rejects.toThrow('Invalid persisted execution progress'); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('snapshot query errors discard without logging/retry', async () => { const f = fixture(async () => { throw new Error('DB'); }); await expect(call(f.repo, 'snapshot')).rejects.toThrow('DB'); expect(f.release).toHaveBeenCalledExactlyOnceWith(true); expect(f.query).toHaveBeenCalledTimes(1); });
});

it.each(['initialize','decision','tool','confirm'] as const)('%s accepts exact null-prototype input and normalizes credential UUIDs',async mode=>{
  const f=fixture();const c=Object.assign(Object.create(null),{ownerId:credentials.ownerId.toUpperCase(),leaseToken:credentials.leaseToken.toUpperCase()});
  const input=mode==='initialize'?Object.assign(Object.create(null),{maxDecisions:5,maxToolAttempts:1}):mode==='confirm'?Object.assign(Object.create(null),{expectedVersion:0,stepNo:1}):0;
  await call(f.repo,mode,id.toUpperCase(),c,input);
  expect(f.query.mock.calls.find(c=>c[0].includes('/* lease write guard */'))![1]!.slice(0,3)).toEqual([id,credentials.ownerId,credentials.leaseToken]);
});
it('never invokes coercion hooks for scalar inputs or missing required values',async()=>{
  const hook=vi.fn(()=>{throw new Error('PRIVATE');});const value={valueOf:hook,toString:hook,[Symbol.toPrimitive]:hook};const f=fixture();
  await expect(f.repo.tryReserveDecision(id,credentials,value as never)).rejects.toBeInstanceOf(InvalidRunInputError);
  await expect(f.repo.initializeProgress(id,credentials,{maxDecisions:value as never,maxToolAttempts:0})).rejects.toBeInstanceOf(InvalidRunInputError);
  await expect(f.repo.tryReserveDecision(id,{...credentials,ownerId:value as never},0)).rejects.toBeInstanceOf(InvalidRunInputError);
  await expect(f.repo.tryReserveDecision(id,credentials,undefined as never)).rejects.toBeInstanceOf(InvalidRunInputError);
  await expect(f.repo.tryConfirmCommittedStep(id,credentials,{stepNo:1} as never)).rejects.toBeInstanceOf(InvalidRunInputError);
  expect(hook).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();
});
it('connection acquisition failure rejects once without a retry or a release of an unowned connection',async()=>{
  const failure=new Error('connect failed');const connect=vi.fn(async()=>{throw failure;});
  await expect(createRunExecutionProgressRepository({connect}).tryReserveDecision(id,credentials,0)).rejects.toBe(failure);expect(connect).toHaveBeenCalledTimes(1);
});
