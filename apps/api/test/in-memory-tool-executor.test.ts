import fs from 'node:fs';
import childProcess from 'node:child_process';
import { Pool } from 'pg';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { parseModelDecision } from '@axiom/contracts';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import * as preflight from '../src/tools/tool-dispatch-preflight.js';
import * as outcomes from '../src/tools/tool-execution-outcome.js';
import { createInMemoryToolExecutor, type InMemoryToolExecutorOptions, type InMemoryToolExecutionResult } from '../src/tools/in-memory-tool-executor.js';
import type { ToolArgumentsSnapshot, ToolJsonValue } from '../src/tools/tool-arguments-snapshot.js';

const id = '12345678-1234-4234-8234-123456789ABC';
const secret = 'SECRET_SENTINEL';
const request = (args: unknown = { message: '  한글 😀  ' }, toolName = 'echo') => ({ kind: 'tool_request', toolName, arguments: args });
const inputSchema = () => z.strictObject({ message: z.string().min(1), nested: z.strictObject({ items: z.array(z.strictObject({ text: z.string() })) }).optional() });
const registry = () => createToolRegistry([{ name: 'echo', inputSchema: inputSchema() }, { name: 'second', inputSchema: inputSchema() }]);
const failed = (code: string) => ({ kind: 'tool_failed', code });
const gate = (fn: () => unknown) => fn as InMemoryToolExecutorOptions['permitExecution'];
function executor(handle: (args: ToolArgumentsSnapshot) => unknown, permitExecution: InMemoryToolExecutorOptions['permitExecution'] = () => true) {
  return createInMemoryToolExecutor({ registry: registry(), handlers: [{ name: 'echo', handle }], permitExecution });
}
function nested(depth: number): object {
  let result = {}; for (let n = 1; n < depth; n++) result = { child: result }; return result;
}
function frozen(value: ToolJsonValue) {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen);
}
afterEach(() => vi.restoreAllMocks());

describe('Trusted in-memory handler registration', () => {
  it('routes multiple explicit names and exposes only a frozen execute method', async () => {
    const one = vi.fn(() => ({ source: 'one' })); const two = vi.fn(async () => ({ source: 'two' }));
    const run = createInMemoryToolExecutor({ registry: registry(), handlers: [{ name: 'echo', handle: one }, { name: 'second', handle: two }], permitExecution: () => true });
    expect(Object.keys(run)).toEqual(['execute']); expect(Object.isFrozen(run)).toBe(true);
    expect(await run.execute(id, request())).toEqual({ kind: 'tool_succeeded', output: { source: 'one' } });
    expect(await run.execute(id, request(undefined, 'second'))).toEqual({ kind: 'tool_succeeded', output: { source: 'two' } });
    expect(one).toHaveBeenCalledTimes(1); expect(two).toHaveBeenCalledTimes(1);
  });
  it('has no default handlers, even with a valid Registry and permitting gate', async () => {
    const permit = vi.fn(() => true);
    const run = createInMemoryToolExecutor({ registry: registry(), handlers: [], permitExecution: permit });
    expect(await run.execute(id, request())).toEqual(failed('execution_unavailable'));
    expect(permit).toHaveBeenCalledTimes(1);
    const empty = createInMemoryToolExecutor({ registry: createToolRegistry([]), handlers: [], permitExecution: permit });
    expect(await empty.execute(id, request())).toEqual({ kind: 'unknown_tool' });
    expect(permit).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'Echo', '__proto__', 'toString', 'hasOwnProperty', '1echo', 'echo\n', 'echo tool', 'e'.repeat(65), 'unknown', null, 1])('rejects invalid/unregistered names %# without leaking input', name => {
    expect(() => createInMemoryToolExecutor({ registry: registry(), handlers: [{ name: name as string, handle: () => ({}) }] })).toThrow('Invalid in-memory tool handler');
  });
  it.each([null, undefined, 1, {}, 'SECRET_SENTINEL'])('rejects non-function handlers %#', handle => {
    expect(() => createInMemoryToolExecutor({ registry: registry(), handlers: [{ name: 'echo', handle: handle as never }] })).toThrow('Invalid in-memory tool handler');
  });
  it('rejects duplicate names', () => {
    const definition = { name: 'echo', handle: () => ({}) };
    expect(() => createInMemoryToolExecutor({ registry: registry(), handlers: [definition, definition] })).toThrow('Invalid in-memory tool handler');
  });
  it('never uses prototype lookup, but allows explicitly registered constructor', async () => {
    const reg = createToolRegistry([{ name: 'constructor', inputSchema: z.strictObject({}) }]);
    const missing = createInMemoryToolExecutor({ registry: reg, handlers: [], permitExecution: () => true });
    expect(await missing.execute(id, request({}, 'constructor'))).toEqual(failed('execution_unavailable'));
    const handle = vi.fn(() => ({}));
    const explicit = createInMemoryToolExecutor({ registry: reg, handlers: [{ name: 'constructor', handle }], permitExecution: () => true });
    expect((await explicit.execute(id, request({}, 'constructor'))).kind).toBe('tool_succeeded');
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it('captures definitions, array, options, gate and function references at construction', async () => {
    const original = vi.fn(() => ({ message: 'original' })); const replacement = vi.fn(() => ({ message: 'replacement' }));
    const permit = vi.fn(() => true); const definitions = [{ name: 'echo', handle: original }];
    const options = { registry: registry(), handlers: definitions, permitExecution: permit };
    const run = createInMemoryToolExecutor(options);
    definitions[0]!.name = 'second'; definitions[0]!.handle = replacement;
    definitions.push({ name: 'echo', handle: replacement }); definitions.length = 0;
    options.registry = createToolRegistry([]); options.handlers = []; options.permitExecution = vi.fn(() => false);
    expect(await run.execute(id, request())).toEqual({ kind: 'tool_succeeded', output: { message: 'original' } });
    expect(original).toHaveBeenCalledTimes(1); expect(replacement).not.toHaveBeenCalled(); expect(permit).toHaveBeenCalledTimes(1);
    expect(Reflect.set(run, 'execute', replacement)).toBe(false);
  });
});

describe('Default deny and trusted synchronous host gate', () => {
  it('denies when gate is omitted', async () => {
    const handle = vi.fn(() => ({}));
    const run = createInMemoryToolExecutor({ registry: registry(), handlers: [{ name: 'echo', handle }] });
    expect(await run.execute(id, request())).toEqual(failed('execution_unavailable')); expect(handle).not.toHaveBeenCalled();
  });
  it.each([false, undefined, null, {}, [], 1, 'true', new Boolean(true)])('requires exact boolean true, value %#', value => {
    const handle = vi.fn(() => ({})); const run = executor(handle, gate(() => value));
    return run.execute(id, request()).then(result => { expect(result).toEqual(failed('execution_unavailable')); expect(handle).not.toHaveBeenCalled(); });
  });
  it.each(['resolve', 'reject', 'delayed_reject', 'pending'])('denies native Promise gate %s without unhandled rejection or waiting', async mode => {
    const handle = vi.fn(() => ({})); const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
    try {
      const permit = gate(() => mode === 'resolve' ? Promise.resolve(true) : mode === 'reject' ? Promise.reject(new Error(secret)) :
        mode === 'delayed_reject' ? new Promise((_, reject) => setImmediate(() => reject(new Error(secret)))) : new Promise(() => {}));
      expect(await executor(handle, permit).execute(id, request())).toEqual(failed('execution_unavailable'));
      await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled(); expect(handle).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });
  it('denies throwing gate and hostile thenables without reading them', async () => {
    const effect = vi.fn(() => { throw new Error(secret); }); const handle = vi.fn(() => ({}));
    const proxy = new Proxy({}, { get: effect, getPrototypeOf: effect }); const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [proxy, revoked.proxy, { then: effect }, Object.defineProperty({}, 'then', { get: effect })]) {
      expect(await executor(handle, gate(() => value)).execute(id, request())).toEqual(failed('execution_unavailable'));
    }
    expect(effect).not.toHaveBeenCalled(); expect(handle).not.toHaveBeenCalled();
    expect(await executor(handle, () => { throw new Error(secret, { cause: secret }); }).execute(id, request())).toEqual(failed('execution_unavailable'));
    expect(handle).not.toHaveBeenCalled();
  });
  it('reevaluates the captured gate each time and never caches permission', async () => {
    let allow = true; const order: string[] = []; const permit = vi.fn(() => { order.push('gate'); return allow; });
    const handle = vi.fn(() => { order.push('handler'); return {}; }); const run = executor(handle, permit);
    expect((await run.execute(id, request())).kind).toBe('tool_succeeded'); allow = false;
    expect(await run.execute(id, request())).toEqual(failed('execution_unavailable')); allow = true;
    expect((await run.execute(id, request())).kind).toBe('tool_succeeded');
    expect(order).toEqual(['gate', 'handler', 'gate', 'gate', 'handler']); expect(permit).toHaveBeenCalledTimes(3); expect(handle).toHaveBeenCalledTimes(2);
  });
});

describe('Executor preflight and immutable inputs', () => {
  it.each<[unknown, unknown, string]>([
    ['bad', request(), 'invalid_run_id'], [null, request(), 'invalid_run_id'],
    [id, request({}, 'missing'), 'unknown_tool'], [id, request({ message: 1 }), 'invalid_tool_arguments'],
    [id, { kind: 'final', content: secret }, 'not_tool_request'], [id, { kind: 'continue' }, 'not_tool_request'],
    [id, null, 'invalid_model_decision'], [id, { kind: 'validated_tool_request', toolName: 'echo', arguments: {} }, 'invalid_model_decision'],
    [id, { kind: 'pending_authorization', runId: id, toolName: 'echo', arguments: {} }, 'invalid_model_decision'],
    ...['approved', 'authorized', 'allow', 'permission', 'handle', 'permitExecution'].flatMap(key => [true, 'allow', () => true].map(value => [id, { ...request(), [key]: value }, 'invalid_model_decision'] as [unknown, unknown, string])),
  ])('preserves preflight failure %# and calls neither gate nor handler', async (runId, raw, kind) => {
    const handle = vi.fn(() => ({})); const permit = vi.fn(() => true);
    expect(await executor(handle, permit).execute(runId, raw)).toEqual({ kind }); expect(handle).not.toHaveBeenCalled(); expect(permit).not.toHaveBeenCalled();
  });
  it('calls actual preflight on every execute, rejecting even a genuine earlier plan', async () => {
    const reg = registry(); const raw = request(); const plan = preflight.prepareToolDispatch(reg, id, raw);
    const spy = vi.spyOn(preflight, 'prepareToolDispatch'); const handle = vi.fn(() => ({}));
    const run = createInMemoryToolExecutor({ registry: reg, handlers: [{ name: 'echo', handle }], permitExecution: () => true });
    expect(await run.execute(id, plan)).toEqual({ kind: 'invalid_model_decision'});
    expect((await run.execute(id, raw)).kind).toBe('tool_succeeded');
    expect(spy).toHaveBeenCalledTimes(2); expect(spy).toHaveBeenLastCalledWith(reg, id, raw); expect(handle).toHaveBeenCalledTimes(1);
  });
  it('passes frozen independent snapshots through gate and handler despite source mutation', async () => {
    const args = { message: 'before', nested: { items: [{ text: 'before' }] } }; const raw = request(args);
    let seen: preflight.PendingToolDispatch | undefined;
    const permit = vi.fn((plan: preflight.PendingToolDispatch) => {
      seen = plan; expect(Object.isFrozen(plan)).toBe(true); frozen(plan.arguments);
      expect(plan.arguments).not.toBe(args); expect(plan.arguments.nested).not.toBe(args.nested);
      expect((plan.arguments.nested as ToolArgumentsSnapshot).items).not.toBe(args.nested.items);
      expect(((plan.arguments.nested as ToolArgumentsSnapshot).items as readonly ToolJsonValue[])[0]).not.toBe(args.nested.items[0]);
      expect(Reflect.set(plan, 'toolName', 'second')).toBe(false); expect(Reflect.set(plan.arguments, 'message', 'changed')).toBe(false);
      args.message = 'after'; args.nested.items[0]!.text = 'after'; raw.toolName = 'second'; return true;
    });
    const handle = vi.fn((snapshot: ToolArgumentsSnapshot) => {
      expect(snapshot).toBe(seen!.arguments); frozen(snapshot); return snapshot;
    });
    const result = await executor(handle, permit).execute(id, raw);
    expect(result).toEqual({ kind: 'tool_succeeded', output: { message: 'before', nested: { items: [{ text: 'before' }] } } });
    expectTypeOf(result).toEqualTypeOf<InMemoryToolExecutionResult>();
    expect(permit).toHaveBeenCalledTimes(1); expect(handle).toHaveBeenCalledTimes(1);
    if (result.kind !== 'tool_succeeded') throw new Error('Expected success');
    expect(result.output).not.toBe(seen!.arguments); frozen(result.output);
  });
  it('revalidates post-parse mutation and rejects malicious decisions without effects', async () => {
    const args = { message: 'before' }; const parsed = parseModelDecision(request(args)); const handle = vi.fn((v: ToolArgumentsSnapshot) => v); const permit = vi.fn(() => true);
    const run = executor(handle, permit); args.message = 'latest';
    expect(await run.execute(id, parsed)).toEqual({ kind: 'tool_succeeded', output: { message: 'latest' } });
    args.message = ''; expect(await run.execute(id, parsed)).toEqual({ kind: 'invalid_tool_arguments' });
    const effect = vi.fn(); const proxy = new Proxy({}, { get: effect, getPrototypeOf: effect, ownKeys: effect });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const raw of [proxy, Object.defineProperty({}, 'kind', { get: effect }), request({ toJSON: effect }), request(cycle),
      { ...request(), [Symbol('secret')]: true }, request(JSON.parse('{"message":"safe","__proto__":{"polluted":true}}'))]) {
      expect((await run.execute(id, raw)).kind).not.toBe('tool_succeeded');
    }
    expect(effect).not.toHaveBeenCalled(); expect(handle).toHaveBeenCalledTimes(1); expect(permit).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});

describe('Handler execution and bounded outcomes', () => {
  it.each(['sync', 'async'])('invokes %s handler once and uses actual P2-B output parser', async mode => {
    const output = { message: '  한글 😀  ', nested: { array: [1, true, null, { value: -0 }] } };
    const handle = vi.fn(() => mode === 'sync' ? output : Promise.resolve(output)); const spy = vi.spyOn(outcomes, 'parseToolExecutionOutcome');
    const result = await executor(handle).execute(id, request());
    expect(spy).toHaveBeenCalledWith({ kind: 'tool_succeeded', output }); expect(handle).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: 'tool_succeeded', output }); expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== 'tool_succeeded') throw new Error('Expected success');
    frozen(result.output); expect(result.output).not.toBe(output); expect(result.output.nested).not.toBe(output.nested);
    expect((result.output.nested as ToolArgumentsSnapshot).array).not.toBe(output.nested.array);
    output.message = 'changed'; output.nested.array.length = 0;
    expect(result.output.message).toBe('  한글 😀  '); expect((result.output.nested as ToolArgumentsSnapshot).array).toHaveLength(4);
  });
  it.each(['throw', 'reject', 'delayed_reject'])('maps %s to handler_error without retry or unhandled rejection', async mode => {
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
    try {
      const handle = vi.fn(() => { const error = new Error(secret, { cause: secret });
        if (mode === 'throw') throw error;
        return mode === 'reject' ? Promise.reject(error) : new Promise((_, reject) => setImmediate(() => reject(error)));
      });
      const result = await executor(handle).execute(id, request());
      expect(result).toEqual(failed('handler_error')); expect(JSON.stringify(result)).not.toMatch(/SENTINEL|cause|stack|issues/);
      expect(Object.isFrozen(result)).toBe(true); await new Promise<void>(resolve => setImmediate(resolve));
      expect(handle).toHaveBeenCalledTimes(1); expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });
  it('does not retry or deduplicate two concurrent independent executions', async () => {
    const handle = vi.fn(async () => ({ message: 'ok' })); const permit = vi.fn(() => true); const run = executor(handle, permit);
    const results = await Promise.all([run.execute(id, request()), run.execute(id, request())]);
    expect(results.map(r => r.kind)).toEqual(['tool_succeeded', 'tool_succeeded']); expect(handle).toHaveBeenCalledTimes(2); expect(permit).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, null, [], 'SECRET_SENTINEL', 1, true, new Error(secret), new Date(), new Map(), new Set(), 1n,
    { value: undefined }, { value: NaN }, { value: Infinity }, { value: Symbol(secret) }, { value: () => true },
    Object.create({ inherited: true }), { value: new Uint8Array([1]) }])('rejects invalid raw output %# with exactly one invocation', async output => {
    const handle = vi.fn(() => output); const result = await executor(handle).execute(id, request());
    expect(result).toEqual(failed('invalid_tool_output')); expect(handle).toHaveBeenCalledTimes(1);
  });
  it.each(['ascii', 'unicode', 'escaped'])('retains 8192/8193-byte output boundary: %s', async mode => {
    const text = mode === 'ascii' ? 'x'.repeat(8181) : mode === 'unicode' ? '😀'.repeat(2045) + 'x' : '\n'.repeat(4090) + 'x';
    expect(Buffer.byteLength(JSON.stringify({ text }))).toBe(8192);
    expect((await executor(() => ({ text })).execute(id, request())).kind).toBe('tool_succeeded');
    expect(await executor(() => ({ text: text + 'x' })).execute(id, request())).toEqual(failed('invalid_tool_output'));
  });
  it('retains depth 8/9 including arrays, and copies shared references', async () => {
    expect((await executor(() => nested(8)).execute(id, request())).kind).toBe('tool_succeeded');
    expect(await executor(() => nested(9)).execute(id, request())).toEqual(failed('invalid_tool_output'));
    expect((await executor(() => ({ array: [nested(6)] })).execute(id, request())).kind).toBe('tool_succeeded');
    expect(await executor(() => ({ array: [nested(7)] })).execute(id, request())).toEqual(failed('invalid_tool_output'));
    const shared = { text: 'before' }; const output = Object.assign(Object.create(null), { a: shared, b: [shared] });
    const result = await executor(() => output).execute(id, request());
    expect(result).toEqual({ kind: 'tool_succeeded', output });
    if (result.kind !== 'tool_succeeded') throw new Error('Expected success');
    expect(result.output.a).not.toBe(shared); expect((result.output.b as readonly ToolJsonValue[])[0]).not.toBe(shared);
    shared.text = 'after'; expect((result.output.a as ToolArgumentsSnapshot).text).toBe('before'); frozen(result.output);
  });
  it('rejects hostile outputs without reading then/getters or invoking Proxy/toJSON', async () => {
    const effect = vi.fn(() => { throw new Error(secret); });
    const proxy = new Proxy({}, { get: effect, ownKeys: effect, getPrototypeOf: effect, getOwnPropertyDescriptor: effect });
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const array: unknown[] = []; array.push(array);
    for (const output of [proxy, revoked.proxy, { nested: proxy }, Object.create(proxy), cycle, { array },
      Object.defineProperty({}, 'then', { enumerable: true, get: effect }), { then: effect },
      Object.defineProperty({}, 'value', { enumerable: true, get: effect }), Object.defineProperty({}, 'value', { enumerable: true, set: effect }),
      { array: Object.defineProperty([0], '0', { enumerable: true, get: effect }) }, { toJSON: effect },
      Object.defineProperty({}, 'hidden', { value: secret }), { [Symbol(secret)]: true }, { a: [, 1] }, { a: Array(1_000_000) }, nested(1000),
      { a: Object.assign([], { extra: true }) }, { a: 'x'.repeat(100_000) }]) {
      expect(await executor(() => output).execute(id, request())).toEqual(failed('invalid_tool_output'));
    }
    expect(effect).not.toHaveBeenCalled();
  });
  it('does not read an overridden then on native gate/handler Promises', async () => {
    const effect = vi.fn(() => { throw new Error(secret); });
    // vi.fn inspects Promise.then for settled-result tracking; use a plain
    // trusted function here so only the Executor's property reads are tested.
    let calls = 0;
    const handle = () => { calls++; return Object.defineProperty(Promise.resolve({ message: 'ok' }), 'then', { get: effect }); };
    expect((await executor(handle).execute(id, request())).kind).toBe('tool_succeeded');
    const permit = gate(() => Object.defineProperty(Promise.reject(new Error(secret)), 'then', { get: effect }));
    expect(await executor(handle, permit).execute(id, request())).toEqual(failed('execution_unavailable'));
    await new Promise<void>(resolve => setImmediate(resolve)); expect(effect).not.toHaveBeenCalled(); expect(calls).toBe(1);
  });
  it('preserves safe special output keys as frozen data without pollution', async () => {
    const output = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"unsafe":true}},"then":"data","toJSON":"data"}');
    const result = await executor(() => output).execute(id, request());
    expect(result).toEqual({ kind: 'tool_succeeded', output });
    if (result.kind !== 'tool_succeeded') throw new Error('Expected success');
    expect(Object.getPrototypeOf(result.output)).toBe(null); expect(Object.hasOwn(result.output, '__proto__')).toBe(true); frozen(result.output);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false); expect(Object.hasOwn(Object.prototype, 'unsafe')).toBe(false);
  });
  it('performs no external I/O or raw input logging with pure sync/async fixture handlers', async () => {
    const spies = [vi.spyOn(globalThis, 'fetch'), vi.spyOn(Pool.prototype, 'query'), vi.spyOn(Pool.prototype, 'connect'),
      vi.spyOn(fs, 'readFile'), vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs.promises, 'readFile'), vi.spyOn(fs.promises, 'writeFile'),
      vi.spyOn(childProcess, 'exec'), vi.spyOn(childProcess, 'execSync'), vi.spyOn(childProcess, 'spawn'), vi.spyOn(childProcess, 'spawnSync'),
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(method => vi.spyOn(console, method))];
    const approvalUI = vi.fn();
    const options = { registry: registry(), handlers: [{ name: 'echo', handle: (args: ToolArgumentsSnapshot) => ({ message: args.message }) }], permitExecution: () => true, approvalUI };
    expect((await createInMemoryToolExecutor(options).execute(id, request())).kind).toBe('tool_succeeded');
    expect((await executor(async () => ({ safe: true })).execute(id, request())).kind).toBe('tool_succeeded');
    expect(await executor(() => { throw new Error(secret); }).execute(id, request())).toEqual(failed('handler_error'));
    expect(await executor(() => ({ value: undefined })).execute(id, request())).toEqual(failed('invalid_tool_output'));
    expect(await executor(() => ({}), () => false).execute(id, request())).toEqual(failed('execution_unavailable'));
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled()); expect(approvalUI).not.toHaveBeenCalled();
  });
});
