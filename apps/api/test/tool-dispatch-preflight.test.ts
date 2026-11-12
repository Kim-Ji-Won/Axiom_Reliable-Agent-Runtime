import fs from 'node:fs';
import childProcess from 'node:child_process';
import { Pool } from 'pg';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { parseModelDecision } from '@axiom/contracts';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import * as resolver from '../src/tools/tool-request-resolver.js';
import { prepareToolDispatch, type PendingToolDispatch } from '../src/tools/tool-dispatch-preflight.js';
import { parseToolExecutionOutcome } from '../src/tools/tool-execution-outcome.js';
import type { ToolArgumentsSnapshot } from '../src/tools/tool-arguments-snapshot.js';

const id = '12345678-1234-4234-8234-123456789ABC';
const request = (args: unknown = { query: 'hello' }, toolName = 'inspect') => ({ kind: 'tool_request', toolName, arguments: args });
const registry = () => createToolRegistry([{ name: 'inspect', inputSchema: z.strictObject({
  query: z.string().min(1), nested: z.strictObject({ items: z.array(z.strictObject({ text: z.string() })) }).optional(),
}) }]);
afterEach(() => vi.restoreAllMocks());

describe('Tool dispatch preflight', () => {
  it('calls the real Resolver and returns an immutable pending plan with independent arguments', () => {
    const reg = registry(); const spy = vi.spyOn(resolver, 'resolveToolRequest');
    const args = { query: '  한글 😀  ', nested: { items: [{ text: 'before' }] } };
    const raw = request(args);
    const result = prepareToolDispatch(reg, id, raw);
    expect(spy).toHaveBeenCalledExactlyOnceWith(reg, raw);
    expect(result).toEqual({ kind: 'pending_authorization', runId: id, toolName: 'inspect', arguments: args });
    if (result.kind !== 'pending_authorization') throw new Error('Expected pending plan');
    expectTypeOf(result).toEqualTypeOf<PendingToolDispatch>();
    const nested = result.arguments.nested as ToolArgumentsSnapshot;
    const items = nested.items as readonly ToolArgumentsSnapshot[];
    expect(result.arguments).not.toBe(args); expect(nested).not.toBe(args.nested);
    expect(items).not.toBe(args.nested.items); expect(items[0]).not.toBe(args.nested.items[0]);
    [result, result.arguments, nested, items, items[0]].forEach(value => expect(Object.isFrozen(value)).toBe(true));
    args.query = 'after'; args.nested.items[0]!.text = 'after'; raw.toolName = 'changed';
    expect(result.arguments.query).toBe('  한글 😀  '); expect(items[0]!.text).toBe('before');
    expect(result.toolName).toBe('inspect');
    expect(Reflect.set(result, 'kind', 'authorized')).toBe(false);
    expect(Reflect.set(items[0]!, 'text', 'changed')).toBe(false);
    expect(() => (items as unknown[]).push({})).toThrow();
    if (false) {
      // @ts-expect-error Plan is readonly.
      result.runId = id;
      // @ts-expect-error Snapshot is recursively readonly.
      items[0]!.text = 'changed';
    }
  });
  it.each(['invalid-id', '', null, undefined, 123, {}, [], true, new String(id), id + '\n'])('rejects invalid ID %# before Resolver or schema work', runId => {
    const spy = vi.spyOn(resolver, 'resolveToolRequest');
    expect(prepareToolDispatch(registry(), runId, request())).toEqual({ kind: 'invalid_run_id' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('rejects hostile IDs without reading/coercing them or the decision', () => {
    const effect = vi.fn(() => { throw new Error('SECRET_SENTINEL'); });
    const proxy = new Proxy({}, { get: effect, getPrototypeOf: effect, ownKeys: effect });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const raw = Object.defineProperty({}, 'kind', { get: effect });
    for (const runId of [proxy, revoked.proxy, { toString: effect, [Symbol.toPrimitive]: effect }]) {
      expect(prepareToolDispatch(registry(), runId, raw)).toEqual({ kind: 'invalid_run_id' });
    }
    expect(effect).not.toHaveBeenCalled();
  });
  it.each([
    [{ kind: 'final', content: 'SECRET_SENTINEL' }, 'not_tool_request'],
    [{ kind: 'continue' }, 'not_tool_request'],
    [request({}, 'missing'), 'unknown_tool'],
    [request({}, 'constructor'), 'unknown_tool'],
    [request({ query: 1 }), 'invalid_tool_arguments'],
    [request({ query: 'safe', extra: 'SECRET_SENTINEL' }), 'invalid_tool_arguments'],
    [request({ query: 'safe', nested: { items: [], extra: true } }), 'invalid_tool_arguments'],
    [{ kind: 'SECRET_SENTINEL' }, 'invalid_model_decision'],
    [null, 'invalid_model_decision'],
    [{ kind: 'validated_tool_request', toolName: 'inspect', arguments: {} }, 'invalid_model_decision'],
    [{ kind: 'authorized', toolName: 'inspect', arguments: {} }, 'invalid_model_decision'],
  ])('returns only the fixed failure kind %#', (raw, kind) => {
    expect(prepareToolDispatch(registry(), id, raw)).toEqual({ kind });
  });
  it.each(['approved', 'authorized', 'allow', 'permission'])('rejects model-originated %s flags', flag => {
    expect(prepareToolDispatch(registry(), id, { ...request(), [flag]: true })).toEqual({ kind: 'invalid_model_decision' });
  });
  it('does not accept even a genuine Resolver result or previous plan as a raw decision', () => {
    const reg = registry();
    expect(prepareToolDispatch(reg, id, resolver.resolveToolRequest(reg, request()))).toEqual({ kind: 'invalid_model_decision' });
    expect(prepareToolDispatch(reg, id, prepareToolDispatch(reg, id, request()))).toEqual({ kind: 'invalid_model_decision' });
  });
  it('revalidates post-parse changes and preserves the latest safe snapshot', () => {
    const args = { query: 'before', nested: { items: [{ text: 'before' }] } };
    const parsed = parseModelDecision(request(args));
    args.query = 'latest'; args.nested.items[0]!.text = 'latest';
    const plan = prepareToolDispatch(registry(), id, parsed);
    expect(plan).toEqual({ kind: 'pending_authorization', runId: id, toolName: 'inspect', arguments: args });
    args.query = ''; args.nested.items[0]!.text = 'after';
    expect(prepareToolDispatch(registry(), id, parsed)).toEqual({ kind: 'invalid_tool_arguments' });
    if (plan.kind !== 'pending_authorization') throw new Error('Expected pending plan');
    expect(plan.arguments.query).toBe('latest');
    expect(((plan.arguments.nested as ToolArgumentsSnapshot).items as readonly ToolArgumentsSnapshot[])[0]!.text).toBe('latest');
  });
  it.each(['getter', 'cycle', 'proxy'])('rejects unsafe post-parse mutation %s without effects', mode => {
    const args: Record<string, unknown> = { query: 'before' };
    const parsed = parseModelDecision(request(args)); const effect = vi.fn();
    if (mode === 'getter') Object.defineProperty(args, 'query', { get: effect });
    if (mode === 'cycle') args.self = args;
    if (mode === 'proxy') args.query = new Proxy({}, { get: effect });
    expect(prepareToolDispatch(registry(), id, parsed)).toEqual({ kind: 'invalid_model_decision' });
    expect(effect).not.toHaveBeenCalled();
  });
  it.each(['ascii', 'unicode', 'escaped'])('preserves the 8192/8193-byte boundary: %s', mode => {
    const reg = createToolRegistry([{ name: 'inspect', inputSchema: z.strictObject({ text: z.string() }) }]);
    const text = mode === 'ascii' ? 'x'.repeat(8181) : mode === 'unicode' ? '😀'.repeat(2045) + 'x' : '\n'.repeat(4090) + 'x';
    expect(Buffer.byteLength(JSON.stringify({ text }))).toBe(8192);
    expect(prepareToolDispatch(reg, id, request({ text })).kind).toBe('pending_authorization');
    expect(prepareToolDispatch(reg, id, request({ text: text + 'x' }))).toEqual({ kind: 'invalid_model_decision' });
  });
  it('preserves depth 8/9 and shared references without source identity', () => {
    let schema: z.ZodType = z.strictObject({}); let args: object = {};
    for (let n = 1; n < 8; n++) { schema = z.strictObject({ child: schema }); args = { child: args }; }
    const reg = createToolRegistry([{ name: 'inspect', inputSchema: schema }]);
    expect(prepareToolDispatch(reg, id, request(args)).kind).toBe('pending_authorization');
    expect(prepareToolDispatch(reg, id, request({ child: args }))).toEqual({ kind: 'invalid_model_decision' });
    const shared = { text: 'safe' };
    const plan = prepareToolDispatch(registry(), id, request({ query: 'safe', nested: { items: [shared, shared] } }));
    if (plan.kind !== 'pending_authorization') throw new Error('Expected pending plan');
    const items = (plan.arguments.nested as ToolArgumentsSnapshot).items as readonly ToolArgumentsSnapshot[];
    expect(items[0]).not.toBe(shared); expect(items[1]).not.toBe(shared);
  });
  it('rejects hostile envelopes and JSON without invoking traps, getters/setters or toJSON', () => {
    const effect = vi.fn(() => { throw new Error('SECRET_SENTINEL'); });
    const proxy = new Proxy({}, { get: effect, ownKeys: effect, getPrototypeOf: effect, getOwnPropertyDescriptor: effect });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const args = [proxy, revoked.proxy, cycle, { query: undefined }, { query: NaN }, { query: new Date() },
      { query: { toJSON: effect } }, { query: [, 1] }, { query: Object.create({ inherited: true }) },
      Object.defineProperty({}, 'query', { enumerable: true, get: effect }),
      Object.defineProperty({}, 'query', { enumerable: true, set: effect }),
      Object.defineProperty({}, 'query', { value: 'hidden' }), { [Symbol('secret')]: 1 },
    ];
    for (const raw of [proxy, revoked.proxy, Object.defineProperty({}, 'kind', { enumerable: true, get: effect }),
      Object.defineProperty(request(), 'hidden', { value: 1 }), { ...request(), [Symbol('secret')]: 1 }, ...args.map(v => request(v)),
    ]) expect(prepareToolDispatch(registry(), id, raw)).toEqual({ kind: 'invalid_model_decision' });
    expect(effect).not.toHaveBeenCalled();
  });
  it('rejects pollution fields without altering prototypes', () => {
    const args = JSON.parse('{"query":"safe","__proto__":{"polluted":true},"constructor":{"prototype":{"unsafe":true}}}');
    expect(prepareToolDispatch(registry(), id, request(args))).toEqual({ kind: 'invalid_tool_arguments' });
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'unsafe')).toBe(false);
  });
  it('performs neither DB lookups nor handler, approval, network, filesystem, process or logging effects', () => {
    const effects = [vi.spyOn(Pool.prototype, 'query'), vi.spyOn(Pool.prototype, 'connect'), vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'writeFile'), vi.spyOn(childProcess, 'exec'),
      vi.spyOn(childProcess, 'execSync'), vi.spyOn(childProcess, 'spawn'),
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(method => vi.spyOn(console, method))];
    const handler = vi.fn(); const authorize = vi.fn();
    const reg = createToolRegistry([{ name: 'inspect', inputSchema: z.strictObject({ query: z.string() }), ...{ handler, authorize } }]);
    expect(prepareToolDispatch(reg, id, request()).kind).toBe('pending_authorization');
    for (const raw of [request({}, 'unknown'), { ...request(), approved: true }, request({ query: 1 })]) {
      expect(JSON.stringify(prepareToolDispatch(reg, id, raw))).not.toMatch(/SECRET|issues|cause|stack/);
    }
    expect(parseToolExecutionOutcome({ kind: 'tool_succeeded', output: { message: 'synthetic only' } }).kind).toBe('tool_succeeded');
    expect(parseToolExecutionOutcome({ kind: 'tool_failed', code: 'handler_error' })).toEqual({ kind: 'tool_failed', code: 'handler_error' });
    expect(() => parseToolExecutionOutcome({ kind: 'tool_failed', code: 'SECRET_SENTINEL' })).toThrow('Invalid tool execution outcome');
    effects.forEach(effect => expect(effect).not.toHaveBeenCalled());
    expect(handler).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
  });
});
