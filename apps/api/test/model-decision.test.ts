import { Buffer } from 'node:buffer';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  modelDecisionSchema, parseModelDecision, InvalidModelDecisionError, InvalidRunInputError,
  type ModelDecision, type JsonObject,
} from '@axiom/contracts';

const tool = (args: unknown) => ({ kind: 'tool_request', toolName: 'search_documents', arguments: args });
const final = (content: unknown) => ({ kind: 'final', content });

function accept(raw: unknown) {
  const parsed = modelDecisionSchema.parse(raw);
  expect(parsed).toEqual(raw);
  expect(parseModelDecision(raw)).toEqual(raw);
  return parsed;
}
function reject(raw: unknown) {
  const result = modelDecisionSchema.safeParse(raw, { reportInput: true });
  expect(result.success).toBe(false);
  expect(() => modelDecisionSchema.parse(raw)).toThrow();
  expect(() => parseModelDecision(raw)).toThrow(InvalidModelDecisionError);
  if (!result.success) {
    expect(JSON.stringify(result.error)).not.toContain('SECRET_SENTINEL');
    expect(result.error.message).not.toContain('SECRET_SENTINEL');
    expect(result.error.issues.every(issue => !('input' in issue) || issue.input === undefined)).toBe(true);
  }
}
function nested(depth: number, arrays = false): JsonObject {
  let value: JsonObject = {};
  for (let i = 1; i < depth; i++) value = arrays ? { child: [value] } : { child: value };
  return value;
}

describe('Model Decision contract', () => {
  it.each(['a', '  분석 결과 😀  ', '한'.repeat(4000), '😀'.repeat(4000)])('accepts final boundary %# unchanged', content => {
    expect(accept(final(content))).toEqual(final(content));
  });
  it('accepts every JSON value, nested arrays, null-prototype objects, and shared references', () => {
    const shared = { text: '  한글 😀  ', number: -0 };
    const args = { values: [null, true, false, 1.5, -1e30, [shared]], shared, empty: {}, list: [] };
    const result = accept(tool(args));
    if (result.kind === 'tool_request') {
      expectTypeOf(result.arguments).toEqualTypeOf<JsonObject>();
      expect(result.arguments).toBe(args);
      expect(Object.is((result.arguments.shared as JsonObject).number, -0)).toBe(true);
    }
    accept(tool(Object.assign(Object.create(null), { query: 'hello' })));
    accept(Object.freeze(final('final')));
  });
  it('narrows the discriminated union', () => {
    const result: ModelDecision = parseModelDecision(final('ok'));
    if (result.kind === 'final') expectTypeOf(result.content).toEqualTypeOf<string>();
    else if (result.kind === 'tool_request') expectTypeOf(result.arguments).toEqualTypeOf<JsonObject>();
    else expectTypeOf(result).toEqualTypeOf<{ kind: 'continue' }>();
    expectTypeOf<typeof modelDecisionSchema.parse>().returns.toEqualTypeOf<ModelDecision>();
  });
  it.each(['a', 'a0_-', 'a'.repeat(64)])('accepts toolName boundary %#', toolName => {
    accept({ ...tool({}), toolName });
  });
  it.each([
    undefined, null, true, 1, 'SECRET_SENTINEL', [], {},
    { kind: 'SECRET_SENTINEL', content: 'SECRET_SENTINEL' },
    { kind: 'final' }, { kind: 'tool_request', toolName: 'test' },
    { ...final('SECRET_SENTINEL'), SECRET_SENTINEL: 'SECRET_SENTINEL' },
    { ...tool({}), extra: 1 }, { ...tool({}), toolName: 1 },
    final(null), final(1), final(''), final(' \t\n\u00a0\ufeff'),
    final('a\0b'), final('\ud800'), final('\udc00'),
    final('a'.repeat(4001)), final('😀'.repeat(4001)),
    tool(null), tool([]), tool(1), tool('SECRET_SENTINEL'),
  ])('rejects invalid decision %# through both entry points', raw => reject(raw));
  it.each(['', 'A', '1a', '_a', '-a', 'a b', 'a.b', '한글', '😀', 'a\n', 'a'.repeat(65)])('rejects toolName %#', toolName => {
    reject({ ...tool({}), toolName });
  });
  it.each([undefined, 1n, Symbol('SECRET_SENTINEL'), () => 'SECRET_SENTINEL', NaN, Infinity, -Infinity,
    new Date(), new Map(), new Set(), /x/, new Number(1), new Uint8Array([1]),
    Object.create({ inherited: true }), new (class {})(),
  ])('rejects non-JSON value %#', value => {
    reject(tool({ nested: [value] }));
  });
  it('accepts JSON strings and keys including escapes without normalization or prototype writes', () => {
    const args = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"toJSON":"data"}');
    args.text = '\0\ud800\n"\\';
    expect(accept(tool(args))).toEqual(tool(args));
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
  it('rejects cycles but permits repeated references with size counted per occurrence', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    reject(tool(cycle));
    const array: unknown[] = [];
    array.push(array);
    reject(tool({ array }));
    const shared = { value: 'x'.repeat(4090) };
    reject(tool({ a: shared, b: shared }));
  });
  it('counts root depth as 1 and accepts 8 but rejects 9', () => {
    accept(tool(nested(8)));
    reject(tool(nested(9)));
    // Four object/array pairs under the root produce depth 9.
    accept(tool({ data: [nested(6)] }));
    reject(tool(nested(5, true)));
    accept(tool({ data: [nested(6), 42] }));
    reject(tool({ data: [nested(7)] }));
  });
  it.each(['ascii', 'unicode', 'escaped'] as const)('enforces 8192 and 8193 exact UTF-8 JSON bytes (%s)', mode => {
    const overhead = Buffer.byteLength(JSON.stringify({ text: '' }));
    const text = mode === 'ascii' ? 'x'.repeat(8192 - overhead) :
      mode === 'unicode' ? '😀'.repeat(2045) + 'x' : '\n'.repeat(4090) + 'x';
    const args = { text };
    expect(Buffer.byteLength(JSON.stringify(args))).toBe(8192);
    accept(tool(args));
    const tooLarge = { text: text + 'x' };
    expect(Buffer.byteLength(JSON.stringify(tooLarge))).toBe(8193);
    reject(tool(tooLarge));
  });
  it('accounts for keys, punctuation, and array elements in the size limit', () => {
    accept(tool({ ['x'.repeat(8185)]: 0 })); // 8191 bytes
    accept(tool({ ['x'.repeat(8186)]: 0 })); // 8192 bytes
    reject(tool({ ['x'.repeat(8187)]: 0 }));
    accept(tool({ a: Array(4092).fill(0) })); // 8191 bytes
    reject(tool({ a: Array(4093).fill(0) })); // 8193 bytes
  });
  it('rejects oversized and sparse structures before visiting values', () => {
    reject(tool({ a: 'x'.repeat(100_000) }));
    reject(tool({ a: Array(1_000_000) }));
    reject(tool({ a: [, 1] }));
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [String(i), 0]));
    reject(tool(wide));
    reject(tool(nested(1000)));
  });
  it('never invokes accessors, toJSON, coercion, or Proxy traps', () => {
    const sideEffect = vi.fn(() => { throw new Error('SECRET_SENTINEL'); });
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get: sideEffect });
    const wrapper = Object.defineProperty({ kind: 'final' }, 'content', { enumerable: true, get: sideEffect });
    const array = Object.defineProperty([0], '0', { enumerable: true, get: sideEffect });
    const proxy = new Proxy({}, { get: sideEffect, ownKeys: sideEffect, getPrototypeOf: sideEffect, getOwnPropertyDescriptor: sideEffect });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const raw of [wrapper, proxy, revoked.proxy, tool(getter), tool({ array }), tool({ proxy }),
      tool({ toJSON: sideEffect }), tool({ [Symbol.toPrimitive]: sideEffect }),
      tool(Object.create(proxy)), tool({ nested: revoked.proxy }),
      Object.defineProperty(final('ok'), Symbol.toStringTag, { get: sideEffect }),
    ]) reject(raw);
    expect(sideEffect).not.toHaveBeenCalled();
  });
  it('rejects hidden properties, symbols, array extensions, and exotic array prototypes', () => {
    reject(tool(Object.defineProperty({}, 'hidden', { value: 1 })));
    reject(tool({ [Symbol('SECRET_SENTINEL')]: 1 }));
    reject(tool({ array: Object.assign([], { extra: 1 }) }));
    reject(tool({ array: Object.setPrototypeOf([], null) }));
    reject(Object.create(final('inherited')));
  });
  it('applies the same guards through asynchronous schema parsing', async () => {
    const getter = vi.fn(() => { throw new Error('SECRET_SENTINEL'); });
    const hostile = Object.defineProperty({}, 'kind', { enumerable: true, get: getter });
    const result = await modelDecisionSchema.safeParseAsync(hostile, { reportInput: true });
    expect(result.success).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL');
    await expect(modelDecisionSchema.parseAsync(tool({ query: '한글' }))).resolves.toEqual(tool({ query: '한글' }));
  });
  it('returns a separate fixed contract error with no raw cause and emits no logs', () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    try {
      reject({ ...tool({ secret: 'SECRET_SENTINEL' }), SECRET_SENTINEL: 'SECRET_SENTINEL' });
      try { parseModelDecision(final('')); } catch (error) {
        expect(error).toBeInstanceOf(InvalidModelDecisionError);
        expect(error).not.toBeInstanceOf(InvalidRunInputError);
        expect((error as Error).message).toBe('Invalid model decision');
        expect(Object.hasOwn(error as object, 'cause')).toBe(false);
      }
      logs.forEach(log => expect(log).not.toHaveBeenCalled());
    } finally { logs.forEach(log => log.mockRestore()); }
  });
  it('only returns proposals while application effects remain untouched', async () => {
    const { Pool } = await import('pg');
    const repositoryModule = await import('../src/persistence/run-repository.js');
    const query = vi.spyOn(Pool.prototype, 'query');
    const repository = vi.spyOn(repositoryModule, 'createRunRepository');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const execute = vi.fn();
    try {
      const registry = { finish_run: execute };
      accept({ kind: 'tool_request', toolName: 'finish_run', arguments: { id: 'run-id' } });
      accept(final('completed'));
      expect(registry.finish_run).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(repository).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { query.mockRestore(); repository.mockRestore(); fetch.mockRestore(); }
  });
});


describe('continue decision contract', () => {
  it('accepts only the kind field including frozen and null-prototype objects', () => {
    accept({ kind: 'continue' });
    accept(Object.freeze({ kind: 'continue' }));
    accept(Object.assign(Object.create(null), { kind: 'continue' }));
  });
  it.each(['content', 'toolName', 'arguments', 'reason', 'extra'])('rejects extra %s without input disclosure', key => {
    reject({ kind: 'continue', [key]: 'SECRET_SENTINEL' });
  });
  it('rejects accessors, hidden/symbol fields, prototypes, proxies and toJSON without execution', () => {
    const effect = vi.fn(() => { throw new Error('SECRET_SENTINEL'); });
    reject(Object.defineProperty({}, 'kind', { enumerable: true, get: effect }));
    reject(Object.defineProperty({ kind: 'continue' }, 'secret', { value: 'SECRET_SENTINEL' }));
    reject({ kind: 'continue', [Symbol('SECRET_SENTINEL')]: 1 });
    reject(Object.assign(Object.create({ inherited: true }), { kind: 'continue' }));
    reject(new Proxy({ kind: 'continue' }, { get: effect, ownKeys: effect, getPrototypeOf: effect }));
    reject({ kind: 'continue', toJSON: effect });
    expect(effect).not.toHaveBeenCalled();
  });
});
