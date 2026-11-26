import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createToolAuthorizationPermit as permit, createToolAuthorizationPolicy as create,
  evaluateToolAuthorization as evaluate, InvalidToolAuthorizationPolicyError,
  type ToolAuthorizationEffect, type ToolAuthorizationRule,
} from '../src/tools/tool-authorization-policy.js';
import { createInMemoryToolExecutor } from '../src/tools/in-memory-tool-executor.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import type { ToolArgumentsSnapshot } from '../src/tools/tool-arguments-snapshot.js';

const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const echo = { kind: 'tool_request', toolName: 'echo', arguments: { text: 'hello' } } as const;
const plan = { ...echo, kind: 'pending_authorization', runId: id } as const;
function rule(effect: ToolAuthorizationEffect = 'allow', args: ToolArgumentsSnapshot = echo.arguments): ToolAuthorizationRule {
  return { runId: id, toolName: 'echo', arguments: args, effect };
}
const noMatch = { kind: 'deny', code: 'no_matching_rule' };
const invalid = { kind: 'deny', code: 'invalid_request' };

it('bounds dense rule lists and publishes a handle only after all rules validate', () => {
  const rules = Array.from({ length: 32 }, (_, n) => rule('allow', { n }));
  expect(evaluate(create(), plan)).toEqual(noMatch);
  expect(evaluate(create(rules), { ...plan, arguments: { n: 31 } })).toEqual({ kind: 'allow' });
  const read = vi.fn();
  const oversized = Object.defineProperty([...rules, rule()], '0', { get: read });
  const prior = create([rule('deny')]);
  for (const raw of [oversized, null, {}, Array(1), Object.assign([rule()], { extra: true }),
    Object.assign([rule()], { [Symbol()]: 1 }), new (class extends Array<ToolAuthorizationRule> {})(),
    Object.defineProperty([rule()], '0', { enumerable: false }), Object.defineProperty([rule()], '0', { get: read }),
    [...rules, {}].slice(1), [rule(), { ...rule(), effect: 'unknown' }]]) {
    expect(() => create(raw as never)).toThrow(InvalidToolAuthorizationPolicyError);
  }
  expect(evaluate(prior, plan)).toEqual({ kind: 'deny', code: 'rule_denied' });
  expect(read).not.toHaveBeenCalled();
});

it('matches exact captured values across mutation, UUID case and object key order', () => {
  const args = { a: [1, ' é '], b: { value: -0 }, constructor: { x: 1 } };
  const config = { ...rule('allow', args), runId: id.toUpperCase() };
  const list = [config];
  const policy = create(list);
  const gate = permit(policy);
  config.effect = 'deny';
  args.a.reverse();
  args.b.value = 0;
  list.length = 0;
  const original = { constructor: { x: 1 }, b: { value: -0 }, a: [1, ' é '] };
  const current = { ...plan, arguments: original };
  expect(gate(current)).toBe(true);
  for (const other of [{ ...current, runId: id.replace('a','1') }, { ...current, toolName: 'echo2' },
    { ...current, arguments: { ...original, a: [' é ',1] } }, { ...current, arguments: { ...original, a: [1,'é'] } },
    { ...current, arguments: { ...original, extra: null } }]) expect(evaluate(policy, other)).toEqual(noMatch);
  current.arguments.b.value = 0;
  expect(gate(current)).toBe(false);
  for (const effect of ['allow','deny','approval_required'] as const) {
    expect(() => create([rule('allow', original), { ...rule(effect, { a: original.a, b: { value: 0 }, constructor: { x: 1 } }),
      runId: id.toUpperCase() }])).toThrow(InvalidToolAuthorizationPolicyError);
  }
  const emptyValues = [null, {}, []] as const;
  for (const [index, value] of emptyValues.entries()) {
    const gate = permit(create([rule('allow', { value })]));
    for (const [otherIndex, other] of emptyValues.entries()) {
      expect(gate({ ...plan, arguments: { value: other } })).toBe(index === otherIndex);
    }
  }
});

it('authenticates the policy before inspecting the request and returns frozen fixed decisions', () => {
  const policy = create([rule()]);
  const trap = vi.fn((): never => { throw Error('private-marker'); });
  const wrapped = new Proxy(policy, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  const hostile = new Proxy(plan, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  expect(Object.isFrozen(policy)).toBe(true);
  expect(Reflect.ownKeys(policy)).toEqual(['kind']);
  for (const fake of [undefined, { ...policy }, JSON.parse(JSON.stringify(policy)), wrapped, evaluate(policy, plan)]) {
    expect(evaluate(fake, hostile)).toEqual({ kind: 'deny', code: 'invalid_policy' });
    expect(permit(fake)(plan)).toBe(false);
  }
  expect(evaluate(policy, hostile)).toEqual(invalid);
  expect(trap).not.toHaveBeenCalled();
  for (const effect of ['allow', 'approval_required', 'deny'] as const) {
    const p = create([rule(effect)]);
    const decision = evaluate(p, plan);
    expect(decision).toEqual(effect === 'deny' ? { kind: 'deny', code: 'rule_denied' } : { kind: effect });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(permit(p)(plan)).toBe(effect === 'allow');
  }
});

it('rejects malformed envelopes and non-JSON behavior without touching input hooks', () => {
  const marker = 'P4A_TEST_PRIVATE';
  const trap = vi.fn((): never => { throw new Error(marker); });
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const policy = create([rule()]);
  const badPatches: object[] = [{ approved: true }, { [Symbol()]: true }, { runId: id + '\n' }, { runId: { valueOf: trap } },
    { toolName: 'Echo' }, { toolName: proxy }, { arguments: [] }, { arguments: { hidden: proxy } },
    { arguments: { get secret() { return trap(); } } }, { arguments: { then: trap } }, { arguments: { toJSON: trap } },
    { arguments: { valueOf: trap } }, { arguments: { marker, gap: Array(1) } }];
  const malformed = (record: object) => [proxy, Object.create(record), Object.defineProperty({ ...record }, 'runId', { get: trap }),
    Object.defineProperty({ ...record }, 'secret', { value: marker }), ...badPatches.map(p => ({ ...record, ...p }))];
  for (const raw of [proxy, ...malformed(rule()).map(entry => [entry])]) {
    let error: unknown;
    try { create(raw as never); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(InvalidToolAuthorizationPolicyError);
    expect((error as Error).message).toBe('Invalid tool authorization policy');
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain(marker);
  }
  for (const raw of [...malformed(plan), { ...plan, kind: 'allow' }]) expect(evaluate(policy, raw)).toEqual(invalid);
  expect(trap).not.toHaveBeenCalled();
  const args = { approved: true, then: null, toJSON: 'text', valueOf: 3 };
  const dataPlan = Object.assign(Object.create(null), plan, { arguments: args });
  expect(evaluate(policy, dataPlan)).toEqual(noMatch);
  expect(permit(create([Object.assign(Object.create(null), rule('allow', args))]))(dataPlan)).toBe(true);
});

it('shares the exact argument depth and UTF-8 byte limits of dispatch', () => {
  const nested = (depth: number) => {
    let obj: ToolArgumentsSnapshot = {};
    for (let i = 1; i < depth; i++) obj = { child: obj };
    return obj;
  };
  const atLimit = { x: 'é'.repeat(4092) }; // 8 bytes of JSON syntax + 8184 bytes of text.
  const policy = create([rule('allow', nested(8)), rule('allow', atLimit)]);
  for (const args of [nested(8), atLimit]) expect(permit(policy)({ ...plan, arguments: args })).toBe(true);
  for (const args of [nested(9), { x: atLimit.x + 'a' }]) {
    expect(() => create([rule('allow', args)])).toThrow(InvalidToolAuthorizationPolicyError);
    expect(evaluate(policy, { ...plan, arguments: args })).toEqual(invalid);
  }
});

it('composes the current plan with real preflight, synchronous permit and an in-memory handler', async () => {
  const registry = createToolRegistry([{ name: 'echo', inputSchema: z.strictObject({ text: z.string() }) }]);
  const handler = vi.fn(() => ({ ok: true }));
  const make = (policy: unknown) => createInMemoryToolExecutor({
    registry, handlers: [{ name: 'echo', handle: handler }], permitExecution: permit(policy),
  });
  for (const p of [create([rule('deny')]), create([rule('approval_required')]), { ...create([rule()]) }]) {
    expect(await make(p).execute(id, echo)).toEqual({ kind: 'tool_failed', code: 'execution_unavailable' });
  }
  const policy = create([rule(), rule('allow', { text: 17 }), { ...rule(), toolName: 'absent' }]);
  const executor = make(policy);
  for (const raw of [evaluate(policy, plan), plan]) expect(await executor.execute(id, raw)).toEqual({ kind: 'invalid_model_decision' });
  expect(await executor.execute(id, { ...echo, toolName: 'absent' })).toEqual({ kind: 'unknown_tool' });
  expect(await executor.execute(id, { ...echo, arguments: { text: 17 } })).toEqual({ kind: 'invalid_tool_arguments' });
  expect(handler).not.toHaveBeenCalled();
  for (const calls of [1, 2]) {
    expect(await executor.execute(id, echo)).toEqual({ kind: 'tool_succeeded', output: { ok: true } });
    expect(handler).toHaveBeenCalledTimes(calls);
  }
});
