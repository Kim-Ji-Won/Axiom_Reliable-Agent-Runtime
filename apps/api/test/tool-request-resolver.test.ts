import fs from 'node:fs';
import childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseModelDecision } from '@axiom/contracts';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import { resolveToolRequest } from '../src/tools/tool-request-resolver.js';
import type { ToolArgumentsSnapshot } from '../src/tools/tool-arguments-snapshot.js';

const schema = () => z.strictObject({ query: z.string().min(1).max(200), filters: z.strictObject({ tags: z.array(z.string()) }).optional() });
const request = (args: unknown = { query: '한글 😀' }, toolName = 'search_documents') => ({ kind: 'tool_request', toolName, arguments: args });
const registry = () => createToolRegistry([{ name: 'search_documents', inputSchema: schema() }]);
afterEach(() => vi.restoreAllMocks());

describe('Trusted Tool Registry', () => {
  it('registers multiple tools without exposing schemas or mutable entries', () => {
    const reg = createToolRegistry([{ name: 'one', inputSchema: z.strictObject({}) }, { name: 'two', inputSchema: schema() }]);
    expect(reg.lookup('one')).toEqual({ name: 'one' });
    expect(reg.lookup('two')).toEqual({ name: 'two' });
    expect(reg.lookup('missing')).toBeUndefined();
    expect(Object.isFrozen(reg)).toBe(true);
    expect(Object.isFrozen(reg.lookup('one'))).toBe(true);
    expect(Reflect.set(reg.lookup('one')!, 'name', 'changed')).toBe(false);
  });
  it('has no default tool in an empty registry', () => {
    const reg = createToolRegistry([]);
    expect(resolveToolRequest(reg, request())).toEqual({ kind: 'unknown_tool' });
    expect(reg.accepts('missing', {})).toBe(false);
  });
  it.each(['constructor', '__proto__', 'prototype', 'toString', 'hasOwnProperty'])('never implicitly finds %s', name => {
    expect(registry().lookup(name)).toBeUndefined();
    expect(registry().accepts(name, {})).toBe(false);
  });
  it.each(['constructor', 'prototype', 'a', 'a0_-', 'a'.repeat(64)])('allows explicit canonical name %s', name => {
    const reg = createToolRegistry([{ name, inputSchema: z.strictObject({}) }]);
    expect(resolveToolRequest(reg, request({}, name))).toEqual({ kind: 'validated_tool_request', toolName: name, arguments: {} });
  });
  it.each(['', '__proto__', 'toString', 'hasOwnProperty', 'A', '1a', '_a', '-a', 'a b', 'a.b', '한글', '😀', 'a\n', 'a'.repeat(65)])('rejects invalid registration name %#', name => {
    expect(() => createToolRegistry([{ name, inputSchema: schema() }])).toThrow('Invalid tool definition');
  });
  it('rejects duplicate names with a fixed configuration error', () => {
    expect(() => createToolRegistry([{ name: 'SECRET_SENTINEL', inputSchema: schema() }])).toThrow('Invalid tool definition');
    expect(() => createToolRegistry([{ name: 'a', inputSchema: schema() }, { name: 'a', inputSchema: schema() }])).toThrow('Invalid tool definition');
  });
  it('isolates external array, definition and nested schema shape replacement', () => {
    const inputSchema = schema();
    const definitions = [{ name: 'search_documents', inputSchema }];
    const reg = createToolRegistry(definitions);
    definitions[0]!.name = 'changed'; definitions[0]!.inputSchema = z.strictObject({}) as ReturnType<typeof schema>;
    definitions.push({ name: 'new_tool', inputSchema }); definitions.length = 0;
    inputSchema.shape.query = z.string();
    expect(reg.lookup('new_tool')).toBeUndefined(); expect(reg.lookup('changed')).toBeUndefined();
    expect(resolveToolRequest(reg, request({ query: '' }))).toEqual({ kind: 'invalid_tool_arguments' });
    expect(resolveToolRequest(reg, request()).kind).toBe('validated_tool_request');
  });
  it.each([
    z.object({ query: z.string() }), z.looseObject({}), z.strictObject({ nested: z.object({}) }),
    z.strictObject({ array: z.array(z.looseObject({})) }), z.strictObject({ n: z.coerce.number() }),
    z.strictObject({ n: z.number().default(1) }), z.strictObject({ n: z.string().catch('fallback') }),
    z.strictObject({ n: z.string().transform(v => v.length) }), z.strictObject({ n: z.string().trim() }),
    z.strictObject({ n: z.preprocess(String, z.string()) }), z.strictObject({ n: z.any() }),
    z.strictObject({ n: z.unknown() }), z.strictObject({ n: z.lazy(() => z.string()) }),
    z.strictObject({ n: z.union([z.string(), z.coerce.number()]) }), z.strictObject({ n: z.string().prefault('default') }),
  ])('rejects permissive or input-changing schema %# at registration', inputSchema => {
    expect(() => createToolRegistry([{ name: 'inspect', inputSchema }])).toThrow('Invalid tool definition');
  });
});

describe('Tool request resolver', () => {
  it('returns the canonical name and independent deeply frozen arguments', () => {
    const args = { query: '  hello 😀  ', filters: { tags: ['one'] } };
    const result = resolveToolRequest(registry(), request(args));
    expect(result).toEqual({ kind: 'validated_tool_request', toolName: 'search_documents', arguments: args });
    if (result.kind !== 'validated_tool_request') throw new Error('Expected snapshot');
    expect(result.arguments).not.toBe(args);
    expect(result.arguments.filters).not.toBe(args.filters);
    expect((result.arguments.filters as ToolArgumentsSnapshot).tags).not.toBe(args.filters.tags);
    expect(Object.isFrozen(result)).toBe(true);
    args.query = 'changed'; args.filters.tags.push('changed');
    expect(result.arguments.query).toBe('  hello 😀  ');
    expect((result.arguments.filters as ToolArgumentsSnapshot).tags).toEqual(['one']);
    expect(Reflect.set(result.arguments.filters as object, 'tags', [])).toBe(false);
  });
  it.each([{}, { query: '' }, { query: 42 }, { query: 'x', extra: true }, { query: 'x', filters: { tags: [], extra: true } },
    { query: 'x', filters: { tags: [1] } }, { query: 'x', filters: { tags: 'one' } }, { query: 'x'.repeat(201) },
  ])('rejects tool-specific invalid arguments %#', args => {
    expect(resolveToolRequest(registry(), request(args))).toEqual({ kind: 'invalid_tool_arguments' });
  });
  it.each([{ kind: 'final', content: 'SECRET_SENTINEL' }, { kind: 'continue' }])('distinguishes $kind', raw => {
    expect(resolveToolRequest(registry(), raw)).toEqual({ kind: 'not_tool_request' });
  });
  it.each([undefined, null, 'SECRET_SENTINEL', {}, { kind: 'final' }, { kind: 'continue', secret: 'SECRET_SENTINEL' },
    request({ value: undefined }), request([], 'inspect'), request({}, '__proto__'),
  ])('rejects malformed decision %# with only a fixed code', raw => {
    expect(resolveToolRequest(registry(), raw)).toEqual({ kind: 'invalid_model_decision' });
  });
  it('checks the contract and registry before any tool-specific schema work', () => {
    const check = vi.fn(() => true);
    const reg = createToolRegistry([{ name: 'search_documents', inputSchema: schema().refine(check) }]);
    expect(resolveToolRequest(reg, request({ secret: 'SECRET_SENTINEL' }, 'unknown'))).toEqual({ kind: 'unknown_tool' });
    expect(resolveToolRequest(reg, { kind: 'continue' })).toEqual({ kind: 'not_tool_request' });
    expect(resolveToolRequest(reg, request({ value: undefined }))).toEqual({ kind: 'invalid_model_decision' });
    expect(check).not.toHaveBeenCalled();
  });
  it('revalidates mutation after ModelDecision parsing and snapshots the latest safe value', () => {
    const args = { query: 'first', filters: { tags: ['first'] } };
    const parsed = parseModelDecision(request(args));
    args.query = 'latest'; args.filters.tags[0] = 'latest';
    const result = resolveToolRequest(registry(), parsed);
    expect(result).toEqual({ kind: 'validated_tool_request', toolName: 'search_documents', arguments: args });
    args.filters.tags[0] = 'later';
    if (result.kind !== 'validated_tool_request') throw new Error('Expected snapshot');
    expect((result.arguments.filters as ToolArgumentsSnapshot).tags).toEqual(['latest']);
  });
  it.each(['type', 'extra', 'getter', 'cycle', 'oversize', 'proxy'])('rejects post-parse unsafe mutation: %s', mode => {
    const args: Record<string, unknown> = { query: 'first' };
    const parsed = parseModelDecision(request(args));
    const effect = vi.fn();
    if (mode === 'type') args.query = 123;
    if (mode === 'extra') args.extra = 'SECRET_SENTINEL';
    if (mode === 'getter') Object.defineProperty(args, 'query', { get: effect });
    if (mode === 'cycle') args.self = args;
    if (mode === 'oversize') args.query = 'x'.repeat(8193);
    if (mode === 'proxy') args.query = new Proxy({}, { get: effect });
    expect(resolveToolRequest(registry(), parsed)).toEqual({ kind: ['type', 'extra'].includes(mode) ? 'invalid_tool_arguments' : 'invalid_model_decision' });
    expect(effect).not.toHaveBeenCalled();
  });
  it('does not read kind getters or invoke traps or toJSON', () => {
    const effect = vi.fn(() => { throw new Error('SECRET_SENTINEL'); });
    for (const raw of [Object.defineProperty({}, 'kind', { enumerable: true, get: effect }),
      new Proxy(request(), { get: effect, ownKeys: effect, getPrototypeOf: effect }), request({ toJSON: effect }),
      Object.create({ kind: 'tool_request' }),
    ]) expect(resolveToolRequest(registry(), raw)).toEqual({ kind: 'invalid_model_decision' });
    expect(effect).not.toHaveBeenCalled();
  });
  it('applies trusted schema only to a frozen copy and discards schema errors and mutated output', () => {
    const raw = { query: 'safe' };
    const check = vi.fn((value: { query: string }) => { raw.query = 'changed'; value.query = 'changed'; return true; });
    const reg = createToolRegistry([{ name: 'search_documents', inputSchema: schema().refine(check) }]);
    expect(resolveToolRequest(reg, request(raw))).toEqual({ kind: 'invalid_tool_arguments' });
    expect(check).toHaveBeenCalledTimes(1);
    const throwing = createToolRegistry([{ name: 'search_documents', inputSchema: schema().refine(() => { throw new Error('SECRET_SENTINEL'); }) }]);
    expect(resolveToolRequest(throwing, request())).toEqual({ kind: 'invalid_tool_arguments' });
  });
  it('validates optional, nullable, union, enum, number, boolean, literal and strict nested array schemas without coercion', () => {
    const inputSchema = z.strictObject({ n: z.number().int(), b: z.boolean(), tag: z.enum(['a', 'b']),
      optional: z.string().optional(), union: z.union([z.string(), z.null()]),
      items: z.array(z.strictObject({ kind: z.literal('x'), value: z.string().nullable() })) });
    const reg = createToolRegistry([{ name: 'inspect', inputSchema }]);
    const args = { n: 2, b: false, tag: 'a', union: null, items: [{ kind: 'x', value: null }] };
    expect(resolveToolRequest(reg, request(args, 'inspect')).kind).toBe('validated_tool_request');
    expect(resolveToolRequest(reg, request({ ...args, n: '2' }, 'inspect'))).toEqual({ kind: 'invalid_tool_arguments' });
  });
  it('preserves the snapshot when a trusted schema mutates only the original source', () => {
    const args = { query: 'before' };
    const inputSchema = schema().refine(() => { args.query = 'after'; return true; });
    const reg = createToolRegistry([{ name: 'search_documents', inputSchema }]);
    expect(resolveToolRequest(reg, request(args))).toEqual({ kind: 'validated_tool_request', toolName: 'search_documents', arguments: { query: 'before' } });
    expect(args.query).toBe('after');
  });
  it('does not expose a retained schema output as the returned snapshot', () => {
    let retained: { query: string } | undefined;
    const inputSchema = schema().refine(value => { retained = value; return true; });
    const reg = createToolRegistry([{ name: 'search_documents', inputSchema }]);
    const result = resolveToolRequest(reg, request({ query: 'before' }));
    retained!.query = 'after';
    expect(result).toEqual({ kind: 'validated_tool_request', toolName: 'search_documents', arguments: { query: 'before' } });
  });
  it('enforces the exact byte boundary through the resolver too', () => {
    const reg = createToolRegistry([{ name: 'inspect', inputSchema: z.strictObject({ text: z.string() }) }]);
    expect(resolveToolRequest(reg, request({ text: 'x'.repeat(8181) }, 'inspect')).kind).toBe('validated_tool_request');
    expect(resolveToolRequest(reg, request({ text: 'x'.repeat(8182) }, 'inspect'))).toEqual({ kind: 'invalid_model_decision' });
  });
  it('enforces depth 8/9 through the resolver with strict nested schemas', () => {
    let inputSchema: z.ZodType = z.strictObject({});
    let args: object = {};
    for (let i = 1; i < 8; i++) { inputSchema = z.strictObject({ child: inputSchema }); args = { child: args }; }
    const reg = createToolRegistry([{ name: 'inspect', inputSchema }]);
    expect(resolveToolRequest(reg, request(args, 'inspect')).kind).toBe('validated_tool_request');
    expect(resolveToolRequest(reg, request({ child: args }, 'inspect'))).toEqual({ kind: 'invalid_model_decision' });
  });
  it('allows declared constructor and toJSON data without method invocation', () => {
    const inputSchema = z.strictObject({ constructor: z.strictObject({ prototype: z.string() }), toJSON: z.string() });
    const args = { constructor: { prototype: 'data' }, toJSON: 'data' };
    const reg = createToolRegistry([{ name: 'inspect', inputSchema }]);
    expect(resolveToolRequest(reg, request(args, 'inspect'))).toEqual({ kind: 'validated_tool_request', toolName: 'inspect', arguments: args });
  });
  it('defensively validates arguments even when accepts is called directly', () => {
    const effect = vi.fn();
    const args = Object.defineProperty({}, 'query', { enumerable: true, get: effect });
    expect(registry().accepts('search_documents', args)).toBe(false);
    expect(effect).not.toHaveBeenCalled();
  });
  it('rejects pollution keys as extra input without altering prototypes', () => {
    const args = JSON.parse('{"query":"safe","__proto__":{"polluted":true},"constructor":{"prototype":{"unsafe":true}}}');
    expect(resolveToolRequest(registry(), request(args))).toEqual({ kind: 'invalid_tool_arguments' });
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'unsafe')).toBe(false);
  });
  it('performs validation with no tool, approval, network, filesystem, process or logging effects', () => {
    const effects = [vi.spyOn(globalThis, 'fetch'), vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'writeFile'),
      vi.spyOn(childProcess, 'exec'), vi.spyOn(childProcess, 'execSync'), vi.spyOn(childProcess, 'spawn'),
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(m => vi.spyOn(console, m))];
    const handler = vi.fn(); const authorize = vi.fn();
    const definition = { name: 'search_documents', inputSchema: schema(), handler, authorize };
    const reg = createToolRegistry([definition]);
    expect(resolveToolRequest(reg, request()).kind).toBe('validated_tool_request');
    for (const raw of [request({ query: 'SECRET_SENTINEL', extra: 'CREDENTIAL_SENTINEL' }), request({}, 'unknown'), { kind: 'SECRET_SENTINEL' }]) {
      expect(JSON.stringify(resolveToolRequest(reg, raw))).not.toMatch(/SENTINEL|issues|cause/);
    }
    effects.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(handler).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
  });
});
