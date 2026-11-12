import { Buffer } from 'node:buffer';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { parseModelDecision } from '@axiom/contracts';
import { InvalidToolArgumentsError, snapshotToolArguments, type ToolArgumentsSnapshot, type ToolJsonValue } from '../src/tools/tool-arguments-snapshot.js';

const tool = (args: unknown) => ({ kind: 'tool_request', toolName: 'inspect', arguments: args });
function reject(raw: unknown) {
  expect(() => parseModelDecision(tool(raw))).toThrow();
  try { snapshotToolArguments(raw); throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(InvalidToolArgumentsError);
    expect((error as Error).message).toBe('Invalid tool arguments');
    expect(Object.hasOwn(error as object, 'cause')).toBe(false);
    expect(JSON.stringify(error)).not.toContain('SECRET_SENTINEL');
  }
}
function nested(depth: number): Record<string, unknown> {
  let v = {};
  for (let i = 1; i < depth; i++) v = { child: v };
  return v;
}
function frozen(value: ToolJsonValue) {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(frozen);
}

describe('Tool argument snapshot', () => {
  it('copies every container, preserves JSON values, and recursively freezes without freezing the source', () => {
    const raw = { object: { text: '  한글 😀 \u0000\ud800\n"\\  ', minusZero: -0 }, list: [null, true, false, 1.5, [-1e30]], empty: {} };
    const result = snapshotToolArguments(raw);
    expect(result).toEqual(raw);
    expect(result).not.toBe(raw);
    expect(result.object).not.toBe(raw.object);
    expect(result.list).not.toBe(raw.list);
    expect((result.list as readonly ToolJsonValue[])[4]).not.toBe(raw.list[4]);
    expect(Object.is((result.object as ToolArgumentsSnapshot).minusZero, -0)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(null);
    frozen(result);
    expect(Object.isFrozen(raw)).toBe(false);
    raw.object.text = 'changed'; raw.list.push('changed' as never);
    expect((result.object as ToolArgumentsSnapshot).text).not.toBe('changed');
    expect(result.list).toHaveLength(5);
    expect(Reflect.set(result, 'extra', true)).toBe(false);
    expect(Reflect.set(result.object as object, 'text', 'changed')).toBe(false);
    expect(() => (result.list as unknown[]).push('changed')).toThrow();
    expect(() => Object.setPrototypeOf(result, {})).toThrow();
    expectTypeOf(result).toEqualTypeOf<ToolArgumentsSnapshot>();
    if (false) {
      // @ts-expect-error Snapshot keys cannot be assigned.
      result.object = null;
      // @ts-expect-error Nested snapshot keys cannot be assigned.
      (result.object as ToolArgumentsSnapshot).text = 'changed';
      // @ts-expect-error Snapshot arrays are readonly.
      (result.list as readonly ToolJsonValue[]).push(null);
    }
  });
  it('accepts null prototypes, frozen input and shared references with no source references', () => {
    const shared = Object.assign(Object.create(null), { text: 'safe' });
    const raw = Object.freeze({ a: shared, b: [shared] });
    const result = snapshotToolArguments(raw);
    expect(result).toEqual(raw);
    expect(result.a).not.toBe(shared);
    expect((result.b as readonly ToolJsonValue[])[0]).not.toBe(shared);
    shared.text = 'changed';
    expect((result.a as ToolArgumentsSnapshot).text).toBe('safe');
    frozen(result);
  });
  it('copies pollution keys as own data without invoking setters', () => {
    const raw = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"unsafe":true}},"toJSON":"data"}');
    const result = snapshotToolArguments(raw);
    expect(result).toEqual(raw);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'unsafe')).toBe(false);
    frozen(result);
  });
  it('accepts container depth 8 and rejects 9 including mixed arrays', () => {
    expect(snapshotToolArguments(nested(8))).toEqual(nested(8));
    expect(snapshotToolArguments({ array: [nested(6)] })).toEqual({ array: [nested(6)] });
    reject(nested(9)); reject({ array: [nested(7)] });
  });
  it.each(['ascii', 'unicode', 'escaped'])('keeps exactly 8192/8193 UTF-8 bytes (%s)', mode => {
    const text = mode === 'ascii' ? 'x'.repeat(8181) : mode === 'unicode' ? '😀'.repeat(2045) + 'x' : '\n'.repeat(4090) + 'x';
    const raw = { text };
    expect(Buffer.byteLength(JSON.stringify(raw))).toBe(8192);
    expect(snapshotToolArguments(raw)).toEqual(raw);
    expect(Buffer.byteLength(JSON.stringify({ text: text + 'x' }))).toBe(8193);
    reject({ text: text + 'x' });
  });
  it('counts keys, array punctuation and repeated shared values toward the budget', () => {
    expect(snapshotToolArguments({ ['x'.repeat(8186)]: 0 })).toEqual({ ['x'.repeat(8186)]: 0 });
    reject({ ['x'.repeat(8187)]: 0 });
    expect(snapshotToolArguments({ a: Array(4092).fill(0) }).a).toHaveLength(4092);
    reject({ a: Array(4093).fill(0) });
    const shared = { text: 'x'.repeat(4090) };
    reject({ a: shared, b: shared });
  });
  it.each([null, undefined, 1, 'SECRET_SENTINEL', [], true])('rejects invalid root %#', reject);
  it.each([undefined, 1n, Symbol('SECRET_SENTINEL'), () => 'SECRET_SENTINEL', NaN, Infinity, -Infinity,
    new Date(), new Map(), new Set(), /x/, new Number(1), new Uint8Array([1]), Object.create({ inherited: true }), new (class {})(),
  ])('rejects non-JSON nested value %#', value => reject({ nested: [value] }));
  it('rejects cyclic, sparse, oversized and exotic containers', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const array: unknown[] = []; array.push(array);
    for (const raw of [cycle, { array }, { a: [, 1] }, { a: Array(1_000_000) }, nested(1000),
      { a: 'x'.repeat(100_000) }, Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [i, 0])),
      Object.defineProperty({}, 'hidden', { value: 'SECRET_SENTINEL' }), { [Symbol('SECRET_SENTINEL')]: 1 },
      { a: Object.assign([], { extra: 1 }) }, { a: Object.setPrototypeOf([], null) },
    ]) reject(raw);
  });
  it('never executes Proxy traps, getters/setters, toJSON, or coercion', () => {
    const effect = vi.fn(() => { throw new Error('SECRET_SENTINEL'); });
    const proxy = new Proxy({}, { get: effect, ownKeys: effect, getPrototypeOf: effect, getOwnPropertyDescriptor: effect });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const raw of [proxy, revoked.proxy, Object.create(proxy), { proxy }, { revoked: revoked.proxy },
      Object.defineProperty({}, 'value', { enumerable: true, get: effect }),
      Object.defineProperty({}, 'value', { enumerable: true, set: effect }),
      { array: Object.defineProperty([0], '0', { enumerable: true, get: effect }) },
      { toJSON: effect }, { [Symbol.toPrimitive]: effect },
    ]) reject(raw);
    expect(effect).not.toHaveBeenCalled();
  });
});
