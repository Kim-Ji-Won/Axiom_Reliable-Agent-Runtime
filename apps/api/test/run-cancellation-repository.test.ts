import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { InvalidRunInputError, runOutcomeSchema, runStatusSchema } from '@axiom/contracts';
import { createRunCancellationRepository } from '../src/persistence/run-cancellation-repository.js';
import { createRunRepository } from '../src/persistence/run-repository.js';
import { createAtomicRunFinalizer } from '../src/persistence/atomic-run-finalizer.js';

const id = 'abcdabcd-1234-4123-8123-0123456789ab';
const reply = (command: string, rows: unknown[]) => ({ command, rows, rowCount: rows.length });
const history = { count: 0, maximum: null, terminals: 0, leased: false, progressed: false };
const step = { run_id: id, step_no: 1, result_kind: 'cancelled', created_at: new Date() };

function fixture() {
  const results: Record<string, unknown> = {
    parent: reply('SELECT', [{ status: 'queued' }]), history: reply('SELECT', [history]),
    UPDATE: reply('UPDATE', [{ id, status: 'cancelled' }]), INSERT: reply('INSERT', [step]),
  };
  const order: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const word = sql.trim().split(/\s+/)[0]!;
    const operation = word === 'SELECT' ? (sql.includes('FOR UPDATE') ? 'parent' : 'history') : word;
    order.push(operation);
    if (operation === 'BEGIN') expect(sql).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    if (['parent', 'history', 'UPDATE', 'INSERT'].includes(operation)) expect(values?.[0]).toBe(id);
    if (operation === 'INSERT') expect(sql).toContain('clock_timestamp()');
    const result = results[operation];
    if (result instanceof Error) throw result;
    return result;
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: query as unknown as PoolClient['query'], release }));
  return { repo: createRunCancellationRepository({ connect }), results, connect, release, query, order };
}

it('captures primitive UUIDs before checkout and exposes only the Host method', async () => {
  const { repo, connect } = fixture();
  expect(Object.keys(repo)).toEqual(['tryCancelRun']);
  const trap = vi.fn((): never => { throw Error('PRIVATE_INPUT'); });
  for (const raw of [null, 42, 'PRIVATE_INPUT', id + '\n', ' ' + id, { get id() { return trap(); }, toString: trap },
    new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap })]) {
    const job = repo.tryCancelRun(raw as string);
    await expect(job).rejects.toBeInstanceOf(InvalidRunInputError);
    await expect(job).rejects.toThrow(/^Invalid cancellation Run ID$/);
  }
  expect(connect).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});

it('keeps cancellation out of the ordinary termination APIs', async () => {
  expect(runOutcomeSchema.safeParse('cancelled').success).toBe(false);
  expect(runStatusSchema.safeParse('cancelled').success).toBe(true);
  const { query, connect } = fixture();
  await expect(createRunRepository({ query: query as unknown as PoolClient['query'] }).tryFinishRun(id, 'cancelled' as never)).rejects.toThrow(InvalidRunInputError);
  const f = createAtomicRunFinalizer({ connect });
  await expect(f.tryFinalizeWithStep(id, 'cancelled' as never)).rejects.toThrow(InvalidRunInputError);
  await expect(f.tryFinalizeWithStepWithLease(id, 'cancelled' as never, { ownerId: id, leaseToken: id })).rejects.toThrow(InvalidRunInputError);
  expect(connect).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

it.each([['queued', false], ['running', false], ['running', true]] as const)(
  'commits %s cancellation with lease=%s before returning three frozen fields', async (status, leased) => {
    const f = fixture();
    f.results.parent = reply('SELECT', [{ status }]);
    f.results.history = reply('SELECT', [{ ...history, leased }]);
    const result = await f.repo.tryCancelRun(id.toUpperCase());
    expect(result).toEqual({ kind: 'cancelled', runId: id, stepNo: 1 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.order).toEqual(['BEGIN', 'parent', 'history', 'UPDATE', 'INSERT', 'COMMIT']);
    expect(f.query.mock.calls.flatMap(([sql]) => sql)).not.toEqual(expect.arrayContaining([expect.stringMatching(/owner_id|lease_token|task|arguments|output/i)]));
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

it.each(['missing', 'completed', 'failed', 'cancelled'])('acknowledges %s without DML', async status => {
  const f = fixture();
  f.results.parent = reply('SELECT', status === 'missing' ? [] : [{ status }]);
  expect(await f.repo.tryCancelRun(id)).toBeNull();
  expect(f.order).toEqual(['BEGIN', 'parent', 'COMMIT']);
});

it.each([
  ['running', { count: 1, maximum: 2 }], ['running', { count: 1, maximum: 1, terminals: 1 }],
  ['queued', { count: 1, maximum: 1 }], ['queued', { leased: true }], ['queued', { progressed: true }],
])('declines unsupported %s history %#', async (status, patch) => {
  const f = fixture();
  f.results.parent = reply('SELECT', [{ status }]);
  f.results.history = reply('SELECT', [{ ...history, ...patch as object }]);
  expect(await f.repo.tryCancelRun(id)).toBeNull();
  expect(f.order).toEqual(['BEGIN', 'parent', 'history', 'COMMIT']);
});

it.each([
  ['parent', { rows: [], rowCount: 1, command: 'SELECT' }], ['parent', reply('SELECT', [null])],
  ['parent', reply('SELECT', [{ status: 'queued', extra: 'PRIVATE_ROW' }])],
  ['parent', reply('SELECT', [{ get status() { throw Error('PRIVATE_ROW'); } }])],
  ['parent', reply('SELECT', [{ status: 'PRIVATE_ROW' }])], ['history', reply('SELECT', [])],
  ['history', reply('SELECT', [{ ...history, maximum: 0 }])], ['history', reply('SELECT', [{ ...history, count: -1 }])],
  ['history', reply('SELECT', [{ ...history, terminals: 1 }])], ['history', reply('SELECT', [{ ...history, leased: null }])],
  ['history', reply('SELECT', [{ ...history, count: 2147483647, maximum: 2147483647 }])],
  ['UPDATE', reply('UPDATE', [])], ['UPDATE', reply('UPDATE', [{ id: 'PRIVATE_ROW', status: 'cancelled' }])],
  ['UPDATE', reply('UPDATE', [{ id, status: 'running' }])], ['INSERT', reply('INSERT', [])],
  ...[{ step_no: 2 }, { run_id: 'PRIVATE_ROW' }, { result_kind: 'completed' }, { created_at: new Date(NaN) }]
    .map(patch => ['INSERT', reply('INSERT', [{ ...step, ...patch }])] as const),
] as const)('rolls back malformed %s response %# with a fixed error', async (stage, result) => {
  const f = fixture();
  f.results.parent = reply('SELECT', [{ status: 'running' }]);
  f.results[stage] = result;
  await expect(f.repo.tryCancelRun(id)).rejects.toThrow(/^Unexpected persisted cancellation$/);
  expect(f.order.at(-1)).toBe('ROLLBACK');
  expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
});

it.each(['BEGIN', 'parent', 'history', 'UPDATE', 'INSERT', 'COMMIT'])('propagates %s rejection and never retries', async stage => {
  const f = fixture();
  const error = new Error('Database fault');
  f.results[stage] = error;
  await expect(f.repo.tryCancelRun(id)).rejects.toBe(error);
  expect(f.order.slice(-2)).toEqual([stage, 'ROLLBACK']);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledExactlyOnceWith(stage === 'COMMIT');
});

it('discards on rollback failure and preserves the original failure', async () => {
  const f = fixture();
  const original = new Error('Write failed');
  f.results.INSERT = original;
  f.results.ROLLBACK = Error('Rollback failed');
  await expect(f.repo.tryCancelRun(id)).rejects.toBe(original);
  expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
});
