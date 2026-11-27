import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as clock from '../src/tools/tool-approval-clock.js';
import { createToolApprovalGrant as issue, createToolApprovalPermit as permit, inspectToolApprovalGrant as inspect,
  revokeToolApprovalGrant as revoke, InvalidToolApprovalGrantError } from '../src/tools/tool-approval-grant.js';
import { createToolAuthorizationPolicy, createToolAuthorizationPermit, evaluateToolAuthorization,
  type ToolAuthorizationEffect } from '../src/tools/tool-authorization-policy.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import { createInMemoryToolExecutor } from '../src/tools/in-memory-tool-executor.js';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope = { runId, toolName: 'echo', arguments: { message: 'SENSITIVE_FIXTURE' } };
const plan = { ...scope, kind: 'pending_authorization' } as const;
const decision = { kind: 'tool_request', toolName: scope.toolName, arguments: scope.arguments };
const unavailable = { kind: 'tool_failed', code: 'execution_unavailable' };
const ok = { kind: 'tool_succeeded', output: { ok: true } };
function policyFor(effect: ToolAuthorizationEffect = 'approval_required') {
  return createToolAuthorizationPolicy([{ ...scope, effect }]);
}
const policy = policyFor();
const fresh = () => issue(policy, plan, 300);
const start = 2n ** 80n;
const mockClock = () => vi.spyOn(clock, 'readApprovalTime').mockReturnValue(start);
afterEach(() => { vi.restoreAllMocks(); });

function fixedFailure(fn: () => unknown) {
  const error = (() => { try { fn(); } catch (e) { return e; } })();
  expect(error).toBeInstanceOf(InvalidToolApprovalGrantError);
  expect(error).toMatchObject({ name: 'InvalidToolApprovalGrantError', message: 'Invalid tool approval grant' });
  expect(error).not.toHaveProperty('cause');
  expect(Object.keys(error as Error)).toEqual(['name']);
  expect(String(error)).not.toContain('SENSITIVE_FIXTURE');
}

it('uses the native monotonic clock and only exposes frozen kind fields', () => {
  const grant = fresh();
  const status = inspect(grant);
  for (const object of [grant, status]) {
    expect(Reflect.ownKeys(object)).toEqual(['kind']);
    expect(Object.isFrozen(object)).toBe(true);
  }
  expect(grant.kind).toBe('host_tool_approval_grant');
  expect(status.kind).toBe('active');
  expect(permit(policy, grant)(plan)).toBe(true);
  expect(inspect(grant)).toEqual({ kind: 'consumed' });
});

it('rejects malformed TTLs without coercion or clock samples', () => {
  const time = mockClock();
  const hook = vi.fn(() => { throw Error('SENSITIVE_FIXTURE'); });
  for (const ttl of [0, -1, 301, 1.5, NaN, Infinity, undefined, null, '1', 2n, { valueOf: hook }]) {
    fixedFailure(() => issue(policy, plan, ttl as number));
  }
  expect(time).not.toHaveBeenCalled();
  expect(hook).not.toHaveBeenCalled();
});

it('requires a genuine approval-required decision and plan without invoking input code', () => {
  const hook = vi.fn((): never => { throw Error('SENSITIVE_FIXTURE'); });
  const traps = { get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook };
  const grant = fresh();
  const time = mockClock();
  for (const p of [policyFor('allow'), policyFor('deny'), createToolAuthorizationPolicy(), null, { ...policy },
    new Proxy(policy, traps)]) fixedFailure(() => issue(p, plan, 1));
  for (const input of [new Proxy(plan, traps), { ...plan, get runId() { return hook(); } },
    { ...plan, arguments: new Proxy({}, traps) }, { ...plan, arguments: { get then() { return hook(); } } },
    { ...plan, arguments: { toJSON: hook } }, { ...plan, arguments: { valueOf: hook } },
    { ...plan, toolName: 'other' }, { ...plan, kind: 'allow' }, { ...plan, [Symbol()]: true }]) {
    fixedFailure(() => issue(policy, input, 1));
    expect(permit(policy, grant)(input as typeof plan)).toBe(false);
  }
  expect(time).not.toHaveBeenCalled();
  expect(hook).not.toHaveBeenCalled();
  time.mockRestore();
  expect(permit(policy, grant)(plan)).toBe(true);
});

it('rejects forged identities and snapshots without observing time or consuming the genuine grant', () => {
  const time = mockClock();
  const grant = fresh();
  const spy = vi.fn((): never => { throw Error('SENSITIVE_FIXTURE'); });
  const impostors = [null, {}, { ...grant }, JSON.parse(JSON.stringify(grant)), new Proxy(grant, { get: spy, ownKeys: spy }),
    inspect(grant), plan, evaluateToolAuthorization(policy, plan), evaluateToolAuthorization(policyFor('allow'), plan)];
  time.mockClear();
  for (const other of impostors) {
    expect(inspect(other)).toEqual({ kind: 'invalid_grant' });
    expect(revoke(other)).toBe(false);
    expect(permit(policy, other)(plan)).toBe(false);
  }
  expect(permit(policyFor(), grant)(plan)).toBe(false);
  expect(permit(policyFor('allow'), grant)(plan)).toBe(false);
  expect(time).not.toHaveBeenCalled();
  expect(spy).not.toHaveBeenCalled();
  expect(permit(policy, grant)(plan)).toBe(true);
});

it('binds to an independent canonical snapshot even among other approval-required scopes', () => {
  const args = { ['__proto__']: 'json', constructor: 'data', then: false, toJSON: 1, valueOf: null,
    items: [' é ', 'z'], zero: -0 };
  const original = { ...plan, arguments: args };
  const equal = { ...original, runId: runId.toUpperCase(), arguments: { zero: -0, items: [' é ', 'z'],
    then: false, constructor: 'data', valueOf: null, toJSON: 1, ['__proto__']: 'json' } };
  const alternatives = [{ ...original, runId: runId.replace('aaaa-', 'bbbb-') }, { ...original, toolName: 'other' },
    { ...original, arguments: { ...args, zero: 0 } }, { ...original, arguments: { ...args, items: ['z', ' é '] } },
    { ...original, arguments: { ...args, items: ['e\u0301', 'z'] } }, { ...original, arguments: { ...args, more: null } }];
  const p = createToolAuthorizationPolicy([original, ...alternatives].map(
    ({ runId, toolName, arguments: values }) => ({ runId, toolName, arguments: values, effect: 'approval_required' })));
  const time = mockClock();
  const grant = issue(p, original, 17);
  time.mockClear();
  for (const other of alternatives) {
    expect(evaluateToolAuthorization(p, other).kind).toBe('approval_required');
    expect(permit(p, grant)(other)).toBe(false);
  }
  args.items[0] = 'replacement';
  expect(permit(p, grant)(original)).toBe(false);
  expect(time).not.toHaveBeenCalled();
  expect(permit(p, grant)(Object.assign(Object.create(null), equal))).toBe(true);
  expect(time).toHaveBeenCalledTimes(1);
});

for (const ttl of [1, 17, 300]) {
  it.each([-1n, 0n, 1n])('observes the nanosecond boundary at TTL ' + ttl + ' with offset %s', offset => {
    const time = mockClock();
    const grant = issue(policy, plan, ttl);
    expect(time).toHaveBeenCalledTimes(1);
    time.mockReturnValue(start + BigInt(ttl) * 1_000_000_000n + offset);
    expect(permit(policy, grant)(plan)).toBe(offset < 0n);
    expect(time).toHaveBeenCalledTimes(2);
    time.mockClear();
    expect(inspect(grant).kind).toBe(offset < 0n ? 'consumed' : 'expired');
    expect(revoke(grant)).toBe(false);
    expect(permit(policy, grant)(plan)).toBe(false);
    expect(time).not.toHaveBeenCalled();
  });
}

it.each(['throw', 'negative', 'number', 'regression'] as const)('invalidates on %s and never reactivates', fault => {
  const time = mockClock();
  const operations = [inspect, revoke, (grant: unknown) => permit(policy, grant)(plan)];
  const grants = operations.map(fresh);
  time.mockReturnValue(start + 2n);
  for (const grant of grants) expect(inspect(grant).kind).toBe('active');
  time.mockClear();
  time.mockImplementation(() => {
    if (fault === 'throw') throw Error('SENSITIVE_FIXTURE');
    if (fault === 'negative') return -1n;
    if (fault === 'number') return 123 as unknown as bigint;
    return start + 1n;
  });
  if (fault !== 'regression') fixedFailure(fresh);
  for (const [index, operation] of operations.entries()) {
    const grant = grants[index]!;
    time.mockClear();
    expect(operation(grant)).toEqual(index === 0 ? { kind: 'invalidated' } : false);
    expect(time).toHaveBeenCalledTimes(1);
    expect(inspect(grant).kind).toBe('invalidated');
    expect(revoke(grant)).toBe(false);
    expect(permit(policy, grant)(plan)).toBe(false);
    expect(time).toHaveBeenCalledTimes(1);
  }
});

it.each([false, true])('samples once on revoke, observing expiration first (expired=%s)', expired => {
  const time = mockClock();
  const grant = issue(policy, plan, 1);
  time.mockClear().mockReturnValue(start + (expired ? 1_000_000_000n : 0n));
  expect(revoke(grant)).toBe(!expired);
  expect(revoke(grant)).toBe(false);
  expect(inspect(grant).kind).toBe(expired ? 'expired' : 'revoked');
  expect(permit(policy, grant)(plan)).toBe(false);
  expect(time).toHaveBeenCalledTimes(1);
});

const registry = createToolRegistry([{ name: 'echo', inputSchema: z.strictObject({ message: z.string() }) }]);
function executor(grant: unknown, handle?: () => unknown) {
  return createInMemoryToolExecutor({ registry, permitExecution: permit(policy, grant),
    handlers: handle ? [{ name: 'echo', handle }] : [] });
}
it.each(['absent', 'revoked', 'consumed', 'expired', 'invalidated'])('blocks a real executor for %s', state => {
  const time = mockClock();
  const grant = state === 'absent' ? undefined : fresh();
  if (state === 'revoked') expect(revoke(grant)).toBe(true);
  if (state === 'consumed') expect(permit(policy, grant)(plan)).toBe(true);
  if (state === 'expired') time.mockReturnValue(start + 300_000_000_000n);
  if (state === 'invalidated') time.mockReturnValue(start - 1n);
  const handler = vi.fn(() => ({ ok: true }));
  return executor(grant, handler).execute(runId, decision).then(result => {
    expect(result).toEqual(unavailable);
    expect(handler).not.toHaveBeenCalled();
    expect(inspect(grant).kind).toBe(state === 'absent' ? 'invalid_grant' : state);
  });
});

it('consumes before handler reentry and excludes a concurrent caller while the handler promise is pending', async () => {
  const grant = fresh();
  const secondHandler = vi.fn(() => ({ ok: true }));
  const second = executor(grant, secondHandler);
  let reentry: ReturnType<typeof second.execute> | undefined;
  let finish!: (value: object) => void;
  const output = new Promise<object>(resolve => { finish = resolve; });
  const firstHandler = vi.fn(() => {
    expect(inspect(grant).kind).toBe('consumed');
    reentry = second.execute(runId, decision);
    return output;
  });
  const first = executor(grant, firstHandler).execute(runId, decision);
  try {
    expect(await second.execute(runId, decision)).toEqual(unavailable);
    expect(await reentry).toEqual(unavailable);
  } finally { finish({ ok: true }); }
  expect(await first).toEqual(ok);
  expect(firstHandler).toHaveBeenCalledTimes(1);
  expect(secondHandler).not.toHaveBeenCalled();
});

it('retains grants past preflight refusal and admits each explicitly issued grant once', async () => {
  const handle = vi.fn(() => ({ ok: true }));
  for (const grant of [fresh(), fresh()]) {
    const real = executor(grant, handle);
    for (const raw of [{ ...decision, toolName: 'missing' }, { ...decision, arguments: { message: false } }]) {
      expect((await real.execute(runId, raw)).kind).not.toBe('tool_succeeded');
      expect(inspect(grant).kind).toBe('active');
    }
    expect(await real.execute(runId, decision)).toEqual(ok);
    expect(await real.execute(runId, decision)).toEqual(unavailable);
  }
  expect(handle).toHaveBeenCalledTimes(2);
});

it.each(['missing', 'throw', 'reject', 'invalid'])('keeps grant consumed after %s handler/output', async failure => {
  const grant = fresh();
  const handle = vi.fn(() => {
    if (failure === 'throw') throw Error('SENSITIVE_FIXTURE');
    if (failure === 'reject') return Promise.reject(Error('SENSITIVE_FIXTURE'));
    return 42;
  });
  const real = executor(grant, failure === 'missing' ? undefined : handle);
  const code = failure === 'missing' ? 'execution_unavailable' : failure === 'invalid' ? 'invalid_tool_output' : 'handler_error';
  expect(await real.execute(runId, decision)).toEqual({ kind: 'tool_failed', code });
  expect(inspect(grant).kind).toBe('consumed');
  expect(await real.execute(runId, decision)).toEqual(unavailable);
  expect(handle).toHaveBeenCalledTimes(failure === 'missing' ? 0 : 1);
});

it('keeps static allow repeatable and separate from approval-only admission', async () => {
  const p = createToolAuthorizationPolicy([{ ...scope, effect: 'approval_required' },
    { ...scope, arguments: { message: 'other' }, effect: 'allow' }]);
  const grant = issue(p, plan, 300);
  const raw = { ...decision, arguments: { message: 'other' } };
  const handlers = [{ name: 'echo', handle: vi.fn(() => ({ ok: true })) }];
  const approval = createInMemoryToolExecutor({ registry, handlers, permitExecution: permit(p, grant) });
  expect(await approval.execute(runId, raw)).toEqual(unavailable);
  const allow = createInMemoryToolExecutor({ registry, handlers, permitExecution: createToolAuthorizationPermit(p) });
  for (let i = 0; i < 2; i++) expect(await allow.execute(runId, raw)).toEqual(ok);
  expect(inspect(grant).kind).toBe('active');
});
