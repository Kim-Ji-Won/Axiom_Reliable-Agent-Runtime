import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InvalidRunInputError } from '@axiom/contracts';
import { runOneShotWorker } from '../src/runtime/run-one-shot-worker.js';
import * as decisionRuntime from '../src/runtime/run-lease-bounded-decisions.js';
import * as toolRuntime from '../src/runtime/run-lease-bounded-tool-decisions.js';
import type { LeaseToolDependencies as Dependencies } from '../src/runtime/run-lease-bounded-tool-decisions.js';
import { createInMemoryToolExecutor } from '../src/tools/in-memory-tool-executor.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';

const id = randomUUID();
const ownerId = randomUUID();
const token = randomUUID();
const date = new Date();
const request = { kind: 'tool_request', toolName: 'echo', arguments: { message: 'private' } };
const success = { kind: 'tool_succeeded', output: { nested: ['private output'] } };
const budgets = { ownerId, leaseSeconds: 30, maxDecisions: 2 };
const tool = { ...budgets, mode: 'tool_enabled', maxToolAttempts: 1 } as const;
const decision = { ...budgets, mode: 'decision_only', maxToolAttempts: 0 } as const;
const run = { id, task: 'private input', status: 'running' as const, createdAt: date };
const handle = { runId: id, ownerId, leaseToken: token, leaseSeconds: 30, acquiredAt: date.toISOString().replace('Z', '000Z'),
  renewedAt: date.toISOString().replace('Z', '000Z'), expiresAt: new Date(+date + 30000).toISOString().replace('Z', '000Z') };

function fixture(max = 2, tools = 1) {
  let progress = { runId: id, schemaVersion: 1 as const, maxDecisions: max, maxToolAttempts: tools,
    checkpointVersion: 0, decisionsReserved: 0, toolAttemptsReserved: 0, lastConfirmedStepNo: null as number | null,
    createdAt: date.toISOString().replace('Z', '000Z'), updatedAt: date.toISOString().replace('Z', '000Z') };
  const deps = {
    tryClaimRunLease: vi.fn<Dependencies['tryClaimRunLease']>().mockResolvedValue(handle),
    initializeProgress: vi.fn<Dependencies['initializeProgress']>().mockImplementation(async () => progress),
    findRunById: vi.fn<Dependencies['findRunById']>().mockResolvedValue(run),
    tryReserveDecision: vi.fn<Dependencies['tryReserveDecision']>().mockImplementation(async (_, credentials, version) => {
      expect(credentials.ownerId === ownerId && credentials.leaseToken === token).toBe(true);
      expect(version).toBe(progress.checkpointVersion);
      return progress = { ...progress, checkpointVersion: version + 1, decisionsReserved: progress.decisionsReserved + 1 };
    }),
    tryReserveToolAttempt: vi.fn<Dependencies['tryReserveToolAttempt']>().mockImplementation(async (_, __, version) => {
      expect(version).toBe(progress.checkpointVersion);
      return progress = { ...progress, checkpointVersion: version + 1, toolAttemptsReserved: progress.toolAttemptsReserved + 1 };
    }),
    appendToolSucceededStepWithLease: vi.fn<Dependencies['appendToolSucceededStepWithLease']>().mockImplementation(async () => ({
      runId: id, stepNo: (progress.lastConfirmedStepNo ?? 0) + 1, resultKind: 'tool_succeeded', createdAt: date,
    })),
    executor: { execute: vi.fn<Dependencies['executor']['execute']>().mockReturnValue(success) },
    decide: vi.fn<Dependencies['decide']>().mockReturnValue({ kind: 'continue' }),
    appendContinuedStepWithLease: vi.fn<Dependencies['appendContinuedStepWithLease']>().mockImplementation(async () => ({
      runId: id, stepNo: (progress.lastConfirmedStepNo ?? 0) + 1, resultKind: 'continued', createdAt: date,
    })),
    tryConfirmCommittedStep: vi.fn<Dependencies['tryConfirmCommittedStep']>().mockImplementation(async (_, __, input) => {
      expect(input.expectedVersion).toBe(progress.checkpointVersion);
      return progress = { ...progress, checkpointVersion: input.expectedVersion + 1, lastConfirmedStepNo: input.stepNo };
    }),
    tryFinalizeWithStepWithLease: vi.fn<Dependencies['tryFinalizeWithStepWithLease']>().mockImplementation(async (_, kind) => ({
      run: { ...run, status: kind === 'completed' ? 'completed' : 'failed' },
      step: { runId: id, stepNo: (progress.lastConfirmedStepNo ?? 0) + 1, resultKind: kind, createdAt: date },
    })),
  };
  return deps;
}


function decisionOnly(all: ReturnType<typeof fixture>) {
  const { executor, tryReserveToolAttempt, appendToolSucceededStepWithLease, decide: source, ...common } = all;
  return { ...common, decide: vi.fn<decisionRuntime.LeaseDecisionDependencies['decide']>().mockReturnValue({ kind: 'final', content: 'done' }) };
}
afterEach(() => vi.restoreAllMocks());

it('passes precisely the decision-only contract and leaves the terminal result intact', async () => {
  const d = vi.spyOn(decisionRuntime, 'runLeaseBoundedDecisions');
  const t = vi.spyOn(toolRuntime, 'runLeaseBoundedToolDecisions');
  const deps = decisionOnly(fixture(2, 0));
  expect(await runOneShotWorker(id.toUpperCase(), deps, decision)).toEqual({ kind: 'completed', content: 'done' });
  expect(d).toHaveBeenCalledExactlyOnceWith(id, deps, budgets);
  expect(t).not.toHaveBeenCalled();
  expect(deps.tryClaimRunLease).toHaveBeenCalledTimes(1);
  expect(deps.decide).toHaveBeenCalledTimes(1);
});

it.each(['allow', 'deny'] as const)('preserves executor receiver, pre-await references and %s permit', async mode => {
  const d = vi.spyOn(decisionRuntime, 'runLeaseBoundedDecisions');
  const t = vi.spyOn(toolRuntime, 'runLeaseBoundedToolDecisions');
  const deps = fixture();
  const opts = { ...tool };
  const handle = vi.fn(() => ({ value: 'private output' }));
  const real = createInMemoryToolExecutor({ registry: createToolRegistry([{ name: 'echo', inputSchema: z.strictObject({ message: z.string() }) }]),
    handlers: [{ name: 'echo', handle }], ...(mode === 'allow' && { permitExecution: () => true }) });
  const receiver = deps.executor;
  const method = vi.fn(function(this: unknown, runId: string, proposal: unknown) {
    if (this !== receiver) throw new Error('Wrong receiver');
    return real.execute(runId, proposal);
  });
  receiver.execute = method;
  const source = deps.decide.mockReturnValueOnce(request).mockReturnValueOnce({ kind: 'final', content: 'done' });
  const pending = runOneShotWorker(id, deps, opts);
  expect(t).toHaveBeenCalledExactlyOnceWith(id, deps, { ...budgets, maxToolAttempts: 1 });
  Object.assign(opts, { mode: 'decision_only', maxDecisions: 1, maxToolAttempts: 0 });
  deps.decide = vi.fn(); receiver.execute = vi.fn();
  expect(await pending).toEqual(mode === 'allow' ? { kind: 'completed', content: 'done' } : { kind: 'tool_failed', code: 'execution_unavailable' });
  expect(source).toHaveBeenCalledTimes(mode === 'allow' ? 2 : 1);
  expect(deps.tryClaimRunLease).toHaveBeenCalledTimes(1);
  expect(method).toHaveBeenCalledTimes(1);
  expect(handle).toHaveBeenCalledTimes(mode === 'allow' ? 1 : 0);
  expect(deps.decide).not.toHaveBeenCalled();
  expect(receiver.execute).not.toHaveBeenCalled();
  expect(d).not.toHaveBeenCalled();
});

it.each(['not_started', 'checkpoint_conflict', 'decision_admission_conflict', 'finalize_conflict', 'invalid_decision'] as const)(
  'passes %s through one dispatch', async kind => {
    const result = { kind };
    const t = vi.spyOn(toolRuntime, 'runLeaseBoundedToolDecisions').mockResolvedValue(result);
    const d = vi.spyOn(decisionRuntime, 'runLeaseBoundedDecisions');
    expect(await runOneShotWorker(id, fixture(), tool)).toBe(result);
    expect(t).toHaveBeenCalledTimes(1);
    expect(d).not.toHaveBeenCalled();
  });

it('preserves an internal rejection without a fallback, public result or log', async () => {
  const deps = fixture();
  const error = new Error('private persistence rejection');
  deps.tryClaimRunLease.mockRejectedValueOnce(error);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(runOneShotWorker(id, deps, tool)).rejects.toBe(error);
  expect(deps.tryClaimRunLease).toHaveBeenCalledTimes(1);
  expect(deps.decide).not.toHaveBeenCalled();
  expect(deps.executor.execute).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

it('rejects unsafe inputs before either dispatch or any callback', async () => {
  const d = vi.spyOn(decisionRuntime, 'runLeaseBoundedDecisions');
  const t = vi.spyOn(toolRuntime, 'runLeaseBoundedToolDecisions');
  const deps = fixture();
  const trap = vi.fn((): never => { throw new Error('Unsafe access'); });
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  const invalidOptions = [proxy, Object.create(tool), { ...tool, mode: 'other' }, { ...tool, ownerId: 'invalid' },
    { ...tool, [Symbol()]: 1 }, { ...tool, extra: true }, { ...tool, get mode() { return trap(); } },
    { ...tool, get then() { return trap(); } }, { ...tool, maxToolAttempts: { valueOf: trap } },
    ...[0, 301, 1.5].map(leaseSeconds => ({ ...tool, leaseSeconds })),
    ...[0, 6, '2'].map(maxDecisions => ({ ...tool, maxDecisions })),
    ...[-1, 2, '0'].map(maxToolAttempts => ({ ...tool, maxToolAttempts })),
    { ...decision, maxToolAttempts: 1 }, { ...budgets, mode: 'decision_only' }];
  for (const options of invalidOptions) await expect(runOneShotWorker(id, deps, options as never)).rejects.toThrow('Invalid one-shot worker input');
  for (const raw of [proxy, Object.create(deps), { ...deps, extra: 1 }, { ...deps, get decide() { return trap(); } },
    { ...deps, findRunById: null }, { ...deps, decide: new Proxy(trap, { apply: trap }) },
    { ...deps, executor: proxy }, { ...deps, executor: { get execute() { return trap(); } } }, decisionOnly(deps)]) {
    await expect(runOneShotWorker(id, raw as never, tool)).rejects.toThrow('Invalid one-shot worker input');
  }
  await expect(runOneShotWorker(id, deps as never, decision)).rejects.toThrow('Invalid one-shot worker input');
  await expect(runOneShotWorker('bad', deps, tool)).rejects.toThrow('Invalid one-shot worker input');
  for (const fn of [d, t, trap, ...Object.values({ ...deps, executor: deps.executor.execute })]) expect(fn).not.toHaveBeenCalled();
});

it.each(['decision_only', 'tool_enabled'] as const)('rejects a class callback before the %s claim', async mode => {
  const d = vi.spyOn(decisionRuntime, 'runLeaseBoundedDecisions');
  const t = vi.spyOn(toolRuntime, 'runLeaseBoundedToolDecisions');
  const handler = vi.fn();
  class Unsupported { constructor() { handler(); } }
  const deps = fixture();
  deps.tryClaimRunLease.mockResolvedValue(null);
  deps.executor.execute.mockImplementation(handler);
  const result = mode === 'decision_only'
    ? runOneShotWorker(id, { ...decisionOnly(deps), decide: Unsupported as never }, decision)
    : runOneShotWorker(id, { ...deps, executor: { execute: Unsupported as never } }, tool);
  await expect.soft(result).rejects.toBeInstanceOf(InvalidRunInputError);
  expect.soft(d).not.toHaveBeenCalled();
  expect.soft(t).not.toHaveBeenCalled();
  expect.soft(deps.tryClaimRunLease).not.toHaveBeenCalled();
  expect(deps.decide).not.toHaveBeenCalled();
  expect(deps.executor.execute).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});

it('checks every callback slot in both modes before dispatch', async () => {
  const d = vi.spyOn(decisionRuntime, 'runLeaseBoundedDecisions');
  const t = vi.spyOn(toolRuntime, 'runLeaseBoundedToolDecisions');
  const all = fixture();
  const common = decisionOnly(all);
  const touched = vi.fn((): never => { throw new Error('Unexpected candidate access'); });
  const candidate = class /* anonymous */ { constructor() { touched(); } };
  Object.defineProperty(candidate, 'toString', { get: touched });
  for (const key of Object.keys(common)) {
    await expect(runOneShotWorker(id, { ...common, [key]: candidate }, decision)).rejects.toBeInstanceOf(InvalidRunInputError);
  }
  for (const key of Object.keys(all)) {
    const value = key === 'executor' ? { execute: candidate } : candidate;
    await expect(runOneShotWorker(id, { ...all, [key]: value }, tool)).rejects.toBeInstanceOf(InvalidRunInputError);
  }
  for (const spy of [d, t, touched, ...Object.values(common), ...Object.values({ ...all, executor: all.executor.execute })]) {
    expect(spy).not.toHaveBeenCalled();
  }
});

it('rejects opaque functions, generators and proxies without observing candidate properties', async () => {
  const d = vi.spyOn(decisionRuntime, 'runLeaseBoundedDecisions');
  const deps = decisionOnly(fixture());
  const touched = vi.fn((): never => { throw new Error('Unexpected candidate access'); });
  const bound = (function ordinary() { touched(); }).bind(null);
  Object.defineProperties(bound, { name: { value: 'decide' }, toString: { get: touched } });
  const boundClass = (class Named { constructor() { touched(); } }).bind(null);
  Object.defineProperty(boundClass, 'toString', { value: () => 'function decide() {}' });
  const traps = { get: touched, getPrototypeOf: touched, apply: touched, construct: touched };
  const revoked = Proxy.revocable(() => touched(), traps);
  revoked.revoke();
  for (const candidate of [bound, boundClass, Math.abs, function* () { touched(); }, async function* () { touched(); },
    new Proxy(() => touched(), traps), revoked.proxy]) {
    await expect(runOneShotWorker(id, { ...deps, decide: candidate as never }, decision)).rejects.toBeInstanceOf(InvalidRunInputError);
  }
  for (const spy of [d, touched, ...Object.values(deps)]) expect(spy).not.toHaveBeenCalled();
});

it('executes inspectable callbacks including keyword and computed methods', async () => {
  const done = { kind: 'final', content: 'class [native code]' } as const;
  const methods = {
    class /* trivia before parameters */ () { return done; },
    async ['computed' + 'Name']() { return done; },
  };
  const destructured = ({ task }: { task: string }) => ({ ...done, content: task ? done.content : '' });
  const callbacks = [function ordinary() { return { kind: 'final', content: 'class [native code]' } as const; },
    async function asyncDecision() { return done; }, () => done, methods.class, methods.computedName!, destructured];
  const touched = vi.fn((): never => { throw new Error('Unexpected candidate access'); });
  for (const decide of callbacks) {
    Object.defineProperty(decide, 'toString', { get: touched });
    const deps = decisionOnly(fixture(2, 0));
    expect(await runOneShotWorker(id, { ...deps, decide }, decision)).toEqual({ kind: 'completed', content: done.content });
    expect(deps.tryClaimRunLease).toHaveBeenCalledTimes(1);
  }
  expect(touched).not.toHaveBeenCalled();
});
