import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { parseToolExecutionOutcome, InvalidToolExecutionOutcomeError, toolExecutionFailureCodes,
  type ToolExecutionOutcome, type ToolExecutionFailureCode } from '../src/tools/tool-execution-outcome.js';
import type { ToolArgumentsSnapshot, ToolJsonValue } from '../src/tools/tool-arguments-snapshot.js';

const success = (output: unknown) => ({ kind: 'tool_succeeded', output });
function reject(raw: unknown) {
  try { parseToolExecutionOutcome(raw); throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(InvalidToolExecutionOutcomeError);
    expect((error as Error).message).toBe('Invalid tool execution outcome');
    expect(Object.hasOwn(error as object, 'cause')).toBe(false);
    expect((error as Error).stack).not.toContain('SECRET_SENTINEL');
    expect(JSON.stringify(error)).not.toMatch(/SECRET_SENTINEL|CREDENTIAL_SENTINEL|issues/);
  }
}
function nested(depth: number): object {
  let result = {};
  for (let n = 1; n < depth; n++) result = { child: result };
  return result;
}
function assertFrozen(value: ToolJsonValue) {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(assertFrozen);
}

describe('Tool execution outcome data contract', () => {
  it('accepts synthetic success data, copies every container, preserves values and deeply freezes', () => {
    const output = { message: '  한글 😀 \0\ud800\n"\\  ', nested: { items: [{ value: -0 }, [null, true, false, 1.5]] } };
    const raw = success(output);
    const result = parseToolExecutionOutcome(raw);
    expectTypeOf(result).toEqualTypeOf<ToolExecutionOutcome>();
    expect(result).toEqual(raw); expect(result).not.toBe(raw);
    if (result.kind !== 'tool_succeeded') throw new Error('Expected success data');
    const child = result.output.nested as ToolArgumentsSnapshot;
    const items = child.items as readonly ToolJsonValue[];
    expect(result.output).not.toBe(output); expect(child).not.toBe(output.nested);
    expect(items).not.toBe(output.nested.items); expect(items[0]).not.toBe(output.nested.items[0]);
    expect(items[1]).not.toBe(output.nested.items[1]);
    expect(Object.is((items[0] as ToolArgumentsSnapshot).value, -0)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true); assertFrozen(result.output);
    output.message = 'after'; output.nested.items.length = 0;
    expect(result.output.message).not.toBe('after'); expect(items).toHaveLength(2);
    expect(Reflect.set(result, 'output', {})).toBe(false);
    expect(Reflect.set(items[0] as object, 'value', 10)).toBe(false);
    expect(() => (items as unknown[]).push({})).toThrow();
    expect(() => Object.setPrototypeOf(result.output, {})).toThrow();
    if (false) {
      // @ts-expect-error The outcome envelope is readonly.
      result.output = {};
      // @ts-expect-error Output is recursively readonly.
      result.output.message = 'changed';
    }
  });
  it.each(toolExecutionFailureCodes)('accepts only fixed failure code %s with a frozen envelope', code => {
    const raw = { kind: 'tool_failed', code };
    const result = parseToolExecutionOutcome(raw);
    expect(result).toEqual(raw); expect(result).not.toBe(raw); expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === 'tool_failed') expectTypeOf(result.code).toEqualTypeOf<ToolExecutionFailureCode>();
    expect(Reflect.set(result, 'code', 'SECRET_SENTINEL')).toBe(false);
    expect(Object.isFrozen(toolExecutionFailureCodes)).toBe(true);
  });
  it.each([undefined, null, 1, true, 'SECRET_SENTINEL', [], {}, new Error('SECRET_SENTINEL', { cause: 'CREDENTIAL_SENTINEL' }),
    { kind: 'unknown', output: {} }, { kind: 'tool_succeeded' }, { kind: 'tool_failed' },
    { kind: 'tool_failed', code: 'SECRET_SENTINEL' }, { kind: 'tool_failed', code: 1 },
    { kind: 'tool_failed', code: new String('handler_error') },
    { kind: 'tool_failed', code: 'handler_error', message: 'SECRET_SENTINEL' },
    { kind: 'tool_failed', code: 'handler_error', cause: 'SECRET_SENTINEL' },
    { kind: 'tool_failed', code: 'handler_error', stack: 'SECRET_SENTINEL' },
    { kind: 'tool_failed', output: {} }, { kind: 'tool_succeeded', code: 'handler_error' },
    { kind: 'tool_succeeded', output: {}, code: 'handler_error' },
    { kind: 'tool_failed', code: 'handler_error', output: {} },
    { kind: 'tool_succeeded', output: {}, approved: true },
    { output: {}, other: 'tool_succeeded' },
    { kind: 'tool_request', toolName: 'inspect', arguments: {} },
    { kind: 'validated_tool_request', toolName: 'inspect', arguments: {} },
  ])('strictly rejects malformed envelope %#', reject);
  it.each([null, undefined, 1, true, [], 'SECRET_SENTINEL', new Error('SECRET_SENTINEL')])('rejects non-object-root output %#', output => reject(success(output)));
  it.each([undefined, 1n, Symbol('SECRET_SENTINEL'), () => 'SECRET_SENTINEL', NaN, Infinity, -Infinity,
    new Date(), new Map(), new Set(), /x/, new Number(1), new Uint8Array([1]), Object.create({ inherited: true }), new (class {})(),
  ])('rejects non-JSON nested output %#', value => reject(success({ nested: [value] })));
  it('accepts frozen/null-prototype envelopes and shared JSON references with no source identity', () => {
    const shared = Object.assign(Object.create(null), { text: 'before' });
    const output = Object.assign(Object.create(null), { a: shared, b: [shared] });
    const raw = Object.freeze(Object.assign(Object.create(null), success(output)));
    const result = parseToolExecutionOutcome(raw);
    expect(result).toEqual(raw);
    if (result.kind !== 'tool_succeeded') throw new Error('Expected success data');
    expect(result.output.a).not.toBe(shared);
    expect((result.output.b as readonly ToolJsonValue[])[0]).not.toBe(shared);
    shared.text = 'after'; expect((result.output.a as ToolArgumentsSnapshot).text).toBe('before');
    assertFrozen(result.output);
    expect(parseToolExecutionOutcome(Object.assign(Object.create(null), { kind: 'tool_failed', code: 'handler_error' })))
      .toEqual({ kind: 'tool_failed', code: 'handler_error' });
  });
  it.each(['ascii', 'unicode', 'escaped'])('counts the output root at exactly 8192/8193 UTF-8 bytes (%s)', mode => {
    const text = mode === 'ascii' ? 'x'.repeat(8181) : mode === 'unicode' ? '😀'.repeat(2045) + 'x' : '\n'.repeat(4090) + 'x';
    expect(Buffer.byteLength(JSON.stringify({ text }))).toBe(8192);
    expect(parseToolExecutionOutcome(success({ text })).kind).toBe('tool_succeeded');
    expect(Buffer.byteLength(JSON.stringify({ text: text + 'x' }))).toBe(8193);
    reject(success({ text: text + 'x' }));
  });
  it('counts output root depth as 1 independently of the envelope, allowing 8 and refusing 9', () => {
    expect(parseToolExecutionOutcome(success(nested(8))).kind).toBe('tool_succeeded');
    expect(parseToolExecutionOutcome(success({ array: [nested(6)] })).kind).toBe('tool_succeeded');
    reject(success(nested(9))); reject(success({ array: [nested(7)] }));
  });
  it('counts shared references per occurrence and rejects cycles, sparse/oversized arrays and objects', () => {
    const shared = { text: 'x'.repeat(4090) }; reject(success({ a: shared, b: shared }));
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const array: unknown[] = []; array.push(array);
    for (const output of [cycle, { array }, { a: [, 1] }, { a: Array(1_000_000) }, nested(1000),
      { a: 'x'.repeat(100_000) }, Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [i, 0])),
      { array: Object.assign([], { extra: 1 }) }, { array: Object.setPrototypeOf([], null) },
    ]) reject(success(output));
  });
  it('rejects hidden/symbol envelope and output fields', () => {
    for (const raw of [Object.defineProperty(success({}), 'hidden', { value: 1 }),
      Object.defineProperty({ kind: 'tool_succeeded' }, 'output', { value: {} }),
      { ...success({}), [Symbol('SECRET_SENTINEL')]: true },
      { kind: 'tool_succeeded', [Symbol('output')]: {} },
      success(Object.defineProperty({}, 'hidden', { value: 'SECRET_SENTINEL' })), success({ [Symbol('SECRET_SENTINEL')]: 1 }),
    ]) reject(raw);
  });
  it('never invokes envelope/output Proxy traps, accessors, toJSON, inherited members or coercion', () => {
    const effect = vi.fn(() => { throw new Error('SECRET_SENTINEL'); });
    const proxy = new Proxy({}, { get: effect, ownKeys: effect, getPrototypeOf: effect, getOwnPropertyDescriptor: effect });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const raw of [proxy, revoked.proxy, Object.create(proxy), Object.create(success({})),
      Object.defineProperty({ output: {} }, 'kind', { enumerable: true, get: effect }),
      Object.defineProperty({ kind: 'tool_succeeded' }, 'output', { enumerable: true, get: effect }),
      Object.defineProperty({ kind: 'tool_failed' }, 'code', { enumerable: true, set: effect }),
      { kind: proxy, output: {} }, { kind: 'tool_failed', code: proxy },
      success(proxy), success({ nested: revoked.proxy }),
      success(Object.defineProperty({}, 'value', { enumerable: true, get: effect })),
      success({ array: Object.defineProperty([0], '0', { enumerable: true, get: effect }) }),
      success({ toJSON: effect }), success({ [Symbol.toPrimitive]: effect }),
    ]) reject(raw);
    expect(effect).not.toHaveBeenCalled();
  });
  it('preserves safe special keys as data without prototype pollution', () => {
    const output = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"unsafe":true}},"toJSON":"data"}');
    const result = parseToolExecutionOutcome(success(output));
    expect(result).toEqual(success(output));
    if (result.kind !== 'tool_succeeded') throw new Error('Expected success data');
    expect(Object.getPrototypeOf(result.output)).toBe(null);
    expect(Object.hasOwn(result.output, '__proto__')).toBe(true);
    expect(result.output.__proto__).not.toBe(output.__proto__);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'unsafe')).toBe(false);
    assertFrozen(result.output);
  });
});
