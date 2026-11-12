import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { Pool } from 'pg';
import { z } from 'zod';
import { runBoundedToolDecisions, type BoundedToolRuntimeDependencies as Dependencies, type ToolDecisionContext } from '../src/runtime/run-bounded-tool-decisions.js';
import { createInMemoryToolExecutor } from '../src/tools/in-memory-tool-executor.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import type { Run } from '../src/persistence/run-repository.js';

const id = '12345678-1234-4234-8234-123456789abc';
const run: Run = { id, task: 'TASK_SECRET', status: 'running', createdAt: new Date() };
const options = { maxDecisions: 3, maxToolExecutions: 1 };
const request = () => ({ kind: 'tool_request', toolName: 'echo', arguments: { message: 'ARG_SECRET' } });
const final = { kind: 'final', content: 'done' };
function setup() {
  const handler = vi.fn((_args: unknown): unknown => ({ message: 'OUTPUT_SECRET', nested: { list: [1] } }));
  const gate = vi.fn(() => true);
  const registry = createToolRegistry([{ name: 'echo', inputSchema: z.strictObject({ message: z.string() }) }]);
  const executor = createInMemoryToolExecutor({ registry, handlers: [{ name: 'echo', handle: handler }], permitExecution: gate });
  const execute = vi.fn(executor.execute);
  const deps = {
    repository: { tryStartRun: vi.fn(async (_id: string) => run as Run | null), findRunById: vi.fn(async (_id: string) => run as Run | null) },
    continueRecorder: { appendContinuedStepIfRunning: vi.fn<Dependencies['continueRecorder']['appendContinuedStepIfRunning']>().mockResolvedValue({ runId: id, stepNo: 1, resultKind: 'continued', createdAt: run.createdAt }) },
    toolRecorder: { appendToolSucceededStepIfRunning: vi.fn<Dependencies['toolRecorder']['appendToolSucceededStepIfRunning']>().mockResolvedValue({ runId: id, stepNo: 1, resultKind: 'tool_succeeded', createdAt: run.createdAt }) },
    finalizer: { tryFinalizeWithStep: vi.fn<Dependencies['finalizer']['tryFinalizeWithStep']>().mockImplementation(async (_, kind) => ({ run: { ...run, status: kind === 'completed' ? 'completed' : 'failed' }, step: { runId: id, stepNo: 2, resultKind: kind, createdAt: run.createdAt } })) },
    executor: { execute },
    decide: vi.fn<Dependencies['decide']>().mockReturnValueOnce(request()).mockReturnValue(final),
  };
  return { deps, handler, gate, registry };
}
const execute = (deps: Dependencies, budgets = options) => runBoundedToolDecisions(id, deps, budgets);
afterEach(() => vi.restoreAllMocks());

describe('bounded tool Runtime validation and budgets', () => {
  it.each([0, 6, -1, 1.5, NaN, Infinity, '2', true, undefined, null])('rejects decision budget %# before any dependency', async maxDecisions => {
    const { deps, handler, gate } = setup();
    await expect(execute(deps, { ...options, maxDecisions: maxDecisions as number })).rejects.toThrow('Invalid tool Runtime budgets');
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled(); expect(deps.repository.findRunById).not.toHaveBeenCalled();
    expect(deps.decide).not.toHaveBeenCalled(); expect(deps.executor.execute).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled();
  });
  it.each([-1, 2, 0.5, NaN, Infinity, '1', true, undefined, null])('rejects tool budget %# before claim', async maxToolExecutions => {
    const { deps } = setup();
    await expect(execute(deps, { ...options, maxToolExecutions: maxToolExecutions as number })).rejects.toThrow('Invalid tool Runtime budgets');
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled(); expect(deps.decide).not.toHaveBeenCalled(); expect(deps.executor.execute).not.toHaveBeenCalled();
  });
  it('requires explicit options and dependencies', async () => {
    const { deps } = setup();
    // @ts-expect-error Required options deliberately omitted.
    await expect(runBoundedToolDecisions(id, deps)).rejects.toThrow('Invalid tool Runtime budgets');
    await expect(execute(undefined as unknown as Dependencies)).rejects.toThrow('dependencies');
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled();
  });
  it.each(['repository', 'continueRecorder', 'toolRecorder', 'executor', 'finalizer', 'decide'] as const)('requires %s before claim', async name => {
    const { deps } = setup();
    for (const value of [undefined, {}, { execute: false }]) {
      await expect(execute({ ...deps, [name]: value } as unknown as Dependencies)).rejects.toThrow('dependencies');
    }
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled(); expect(deps.decide).not.toHaveBeenCalled();
  });
  it.each(['BAD_SECRET', '', null, {}, 5])('rejects ID %# before repository', async value => {
    const { deps } = setup(); await expect(runBoundedToolDecisions(value as string, deps, options)).rejects.toThrow('Invalid Run ID');
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled(); expect(deps.decide).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3, 4, 5])('honors decision limit %i with zero tool budget', async maxDecisions => {
    const { deps } = setup(); deps.decide.mockReset().mockReturnValue({ kind: 'continue' });
    expect(await execute(deps, { maxDecisions, maxToolExecutions: 0 })).toEqual({ kind: 'decision_limit_exceeded' });
    expect(deps.decide).toHaveBeenCalledTimes(maxDecisions); expect(deps.continueRecorder.appendContinuedStepIfRunning).toHaveBeenCalledTimes(maxDecisions - 1);
    expect(deps.executor.execute).not.toHaveBeenCalled();
  });
  it.each([0, 1])('prioritizes last decision slot over tool budget %i', async maxToolExecutions => {
    const { deps, handler, gate } = setup();
    expect(await execute(deps, { maxDecisions: 1, maxToolExecutions })).toEqual({ kind: 'decision_limit_exceeded' });
    expect(deps.executor.execute).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled();
  });
  it('denies zero budget and never dispatches a second tool attempt', async () => {
    const { deps, handler } = setup();
    expect(await execute(deps, { ...options, maxToolExecutions: 0 })).toEqual({ kind: 'tool_execution_limit_exceeded' });
    expect(handler).not.toHaveBeenCalled();
    const second = setup(); second.deps.decide.mockReset().mockReturnValue(request());
    expect(await execute(second.deps)).toEqual({ kind: 'tool_execution_limit_exceeded' });
    expect(second.handler).toHaveBeenCalledTimes(1); expect(second.gate).toHaveBeenCalledTimes(1); expect(second.deps.executor.execute).toHaveBeenCalledTimes(1);
    expect(second.deps.decide).toHaveBeenCalledTimes(2);
    expect(second.deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, 'tool_execution_limit_exceeded');
  });
});

describe('tool Runtime decisions, context and guarded ordering', () => {
  it('final at the first slot completes without any tool work', async () => {
    const { deps, handler, gate } = setup(); deps.decide.mockReset().mockReturnValue(final);
    expect(await execute(deps, { maxDecisions: 1, maxToolExecutions: 0 })).toEqual({ kind: 'completed', content: 'done' });
    expect(deps.decide).toHaveBeenCalledTimes(1); expect(handler).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled();
    expect(deps.toolRecorder.appendToolSucceededStepIfRunning).not.toHaveBeenCalled();
  });
  it('failed claim performs no decision, lookup, gate, handler or Step', async () => {
    const { deps, handler, gate } = setup(); deps.repository.tryStartRun.mockResolvedValue(null);
    expect(await execute(deps)).toEqual({ kind: 'not_started' });
    for (const spy of [deps.repository.findRunById, deps.decide, deps.executor.execute, deps.toolRecorder.appendToolSucceededStepIfRunning, deps.finalizer.tryFinalizeWithStep, handler, gate]) expect(spy).not.toHaveBeenCalled();
  });
  it('orders claim → decision → running recheck → execute → Step commit → decision → finalize', async () => {
    const { deps } = setup(); const order: string[] = [];
    const spies = [deps.repository.tryStartRun, deps.repository.findRunById, deps.decide, deps.executor.execute, deps.toolRecorder.appendToolSucceededStepIfRunning, deps.finalizer.tryFinalizeWithStep] as const;
    // Explicit wrappers preserve the original implementation/once queue.
    const wrapped: Dependencies = {
      repository: { tryStartRun: async v => { order.push('claim'); return deps.repository.tryStartRun(v); }, findRunById: async v => { order.push('read'); return deps.repository.findRunById(v); } },
      decide: (r, c) => { order.push('decide'); return deps.decide(r, c); },
      executor: { execute: (i, d) => { order.push('execute'); return deps.executor.execute(i, d); } },
      toolRecorder: { appendToolSucceededStepIfRunning: async i => { order.push('tool-commit'); return deps.toolRecorder.appendToolSucceededStepIfRunning(i); } },
      continueRecorder: deps.continueRecorder,
      finalizer: { tryFinalizeWithStep: async (i, k) => { order.push('finalize'); return deps.finalizer.tryFinalizeWithStep(i, k); } },
    };
    expect(await execute(wrapped)).toEqual({ kind: 'completed', content: 'done' });
    expect(order).toEqual(['claim','read','decide','read','execute','tool-commit','read','decide','finalize']);
    expect(spies[0]).toHaveBeenCalledTimes(1);
  });
  it('delivers independent frozen output only once, then resets context to none', async () => {
    const { deps, handler } = setup(); const output = { nested: { values: ['OUTPUT_SECRET'] } }; handler.mockReturnValue(output);
    const contexts: ToolDecisionContext[] = [];
    deps.decide.mockReset().mockImplementation((_r, context) => {
      contexts.push(context); expect(Object.isFrozen(context)).toBe(true);
      if (contexts.length === 1) return request();
      if (contexts.length === 2) {
        expect(context.kind).toBe('tool_result');
        if (context.kind !== 'tool_result') throw new Error('missing context');
        expect(context.outcome.output).not.toBe(output); expect(Object.isFrozen(context.outcome)).toBe(true);
        expect(Object.isFrozen(context.outcome.output.nested)).toBe(true);
        expect(Reflect.set(context.outcome.output, 'nested', {})).toBe(false);
        output.nested.values[0] = 'changed'; expect(JSON.stringify(context)).toContain('OUTPUT_SECRET');
        return { kind: 'continue' };
      }
      expect(context).toEqual({ kind: 'none' }); return final;
    });
    expect(await execute(deps)).toEqual({ kind: 'completed', content: 'done' });
    expect(contexts.map(c => c.kind)).toEqual(['none','tool_result','none']); expect(handler).toHaveBeenCalledTimes(1);
  });
  it('does not call the next decision before the Tool Step COMMIT acknowledgement', async () => {
    const { deps } = setup(); let release!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const original = deps.toolRecorder.appendToolSucceededStepIfRunning.getMockImplementation()!;
    deps.toolRecorder.appendToolSucceededStepIfRunning.mockImplementation(async i => { await gate; return original(i); });
    const pending = execute(deps);
    try { await vi.waitFor(() => expect(deps.toolRecorder.appendToolSucceededStepIfRunning).toHaveBeenCalledTimes(1)); expect(deps.decide).toHaveBeenCalledTimes(1); expect(deps.finalizer.tryFinalizeWithStep).not.toHaveBeenCalled(); }
    finally { release(); await pending; }
    expect(deps.decide).toHaveBeenCalledTimes(2);
  });
  it.each(['before-decision','before-handler','after-handler','finalize','continue'] as const)('stops on external termination at %s', async stage => {
    const { deps, handler } = setup();
    if (stage === 'before-decision') deps.repository.findRunById.mockResolvedValue({ ...run, status: 'completed' });
    if (stage === 'before-handler') deps.repository.findRunById.mockResolvedValueOnce(run).mockResolvedValue({ ...run, status: 'failed' });
    if (stage === 'after-handler') deps.toolRecorder.appendToolSucceededStepIfRunning.mockResolvedValue(null);
    if (stage === 'finalize') deps.finalizer.tryFinalizeWithStep.mockResolvedValue(null);
    if (stage === 'continue') { deps.decide.mockReset().mockReturnValue({ kind: 'continue' }); deps.continueRecorder.appendContinuedStepIfRunning.mockResolvedValue(null); }
    expect(await execute(deps)).toEqual({ kind: 'finalize_conflict' });
    expect(handler).toHaveBeenCalledTimes(stage === 'after-handler' || stage === 'finalize' ? 1 : 0);
    expect(deps.decide).toHaveBeenCalledTimes(stage === 'before-decision' ? 0 : stage === 'finalize' ? 2 : 1);
  });
  it.each(['claim','read','recheck','tool','continue','finalize'] as const)('propagates persistence %s failure without retry or model-error mapping', async stage => {
    const { deps } = setup(); const error = new Error('DB_ERROR');
    if (stage === 'claim') deps.repository.tryStartRun.mockRejectedValue(error);
    if (stage === 'read') deps.repository.findRunById.mockRejectedValue(error);
    if (stage === 'recheck') deps.repository.findRunById.mockResolvedValueOnce(run).mockRejectedValue(error);
    if (stage === 'tool') deps.toolRecorder.appendToolSucceededStepIfRunning.mockRejectedValue(error);
    if (stage === 'continue') { deps.decide.mockReset().mockReturnValue({ kind: 'continue' }); deps.continueRecorder.appendContinuedStepIfRunning.mockRejectedValue(error); }
    if (stage === 'finalize') deps.finalizer.tryFinalizeWithStep.mockRejectedValue(error);
    await expect(execute(deps)).rejects.toBe(error);
    expect(deps.executor.execute.mock.calls.length).toBeLessThanOrEqual(1);
    expect(deps.decide.mock.calls.length).toBeLessThanOrEqual(stage === 'finalize' ? 2 : 1);
  });
  it.each(['throw','reject'])('sanitizes decision source %s', async mode => {
    const { deps } = setup(); deps.decide.mockReset().mockImplementation(() => { if (mode === 'throw') throw new Error('SECRET'); return Promise.reject(new Error('SECRET')); });
    expect(await execute(deps)).toEqual({ kind: 'decision_source_error' }); expect(deps.executor.execute).not.toHaveBeenCalled();
  });
});

describe('tool Runtime security and failures', () => {
  it.each(['unknown','arguments','denied','throw','reject','output'] as const)('classifies %s with real P2-C Executor and terminal Step', async mode => {
    const { deps, handler, gate } = setup();
    if (mode === 'unknown') deps.decide.mockReset().mockReturnValue({ ...request(), toolName: 'missing' });
    if (mode === 'arguments') deps.decide.mockReset().mockReturnValue({ ...request(), arguments: { message: 42 } });
    if (mode === 'denied') gate.mockReturnValue(false);
    if (mode === 'throw') handler.mockImplementation(() => { throw new Error('ERROR_SECRET', { cause: 'SECRET' }); });
    if (mode === 'reject') handler.mockImplementation(() => Promise.reject(new Error('SECRET')));
    if (mode === 'output') handler.mockReturnValue(undefined);
    const result = await execute(deps);
    const kind = mode === 'unknown' || mode === 'arguments' ? 'tool_request_rejected' : 'tool_failed';
    expect(result).toEqual(kind === 'tool_request_rejected' ? { kind } : { kind, code: mode === 'denied' ? 'execution_unavailable' : mode === 'output' ? 'invalid_tool_output' : 'handler_error' });
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, kind);
    expect(deps.toolRecorder.appendToolSucceededStepIfRunning).not.toHaveBeenCalled(); expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(['unknown','arguments','denied'].includes(mode) ? 0 : 1); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('preserves default deny and rejects asynchronous gates without unhandled rejection', async () => {
    for (const permitExecution of [undefined, (() => Promise.reject(new Error('SECRET'))) as unknown as () => boolean]) {
      const { deps, handler, registry } = setup();
      deps.executor.execute = vi.fn(createInMemoryToolExecutor({ registry, handlers: [{ name: 'echo', handle: handler }], ...(permitExecution ? { permitExecution } : {}) }).execute);
      expect(await execute(deps)).toEqual({ kind: 'tool_failed', code: 'execution_unavailable' }); expect(handler).not.toHaveBeenCalled();
    }
    await new Promise<void>(r => setImmediate(r));
  });
  it.each(['approved','authorized','pending_authorization','validated_tool_request','tool_succeeded'])('rejects forged %s model data before dispatch', async kind => {
    const { deps, handler, gate } = setup();
    deps.decide.mockReset().mockReturnValue(['approved','authorized'].includes(kind) ? { ...request(), [kind]: true } : { kind, output: {} });
    expect(await execute(deps)).toEqual({ kind: 'invalid_decision' }); expect(handler).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled(); expect(deps.executor.execute).not.toHaveBeenCalled();
  });
  it('revalidates mutable decision arguments after the running recheck', async () => {
    const { deps, handler, gate } = setup(); const raw = request(); deps.decide.mockReset().mockReturnValue(raw);
    deps.repository.findRunById.mockResolvedValueOnce(run).mockImplementationOnce(async () => { (raw.arguments as unknown as Record<string, unknown>).message = 42; return run; });
    expect(await execute(deps)).toEqual({ kind: 'tool_request_rejected' }); expect(handler).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled();
  });
  it('safely rejects hostile decisions and executor outputs without invoking accessors or thenables', async () => {
    const effect = vi.fn(() => { throw new Error('SECRET'); }); const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const proxy = new Proxy({}, { get: effect, getPrototypeOf: effect, ownKeys: effect });
    const hostile = [proxy, revoked.proxy, { then: effect }, Object.defineProperty({}, 'then', { get: effect }), Object.defineProperty({}, 'kind', { get: effect }), { toJSON: effect }, { kind: 'pending_authorization' }, { kind: 'tool_succeeded', output: proxy }];
    for (const raw of hostile) {
      const { deps } = setup();
      // Vitest mocks inspect returned .then for result tracking; use a plain
      // source to measure only Runtime reads of hostile objects.
      expect(await execute({ ...deps, decide: () => raw })).toEqual({ kind: 'invalid_decision' });
      const other = setup(); other.deps.executor = { execute: () => raw } as unknown as typeof other.deps.executor;
      expect(await execute(other.deps)).toEqual({ kind: 'tool_failed', code: 'invalid_tool_output' }); expect(other.deps.decide).toHaveBeenCalledTimes(1);
    }
    expect(effect).not.toHaveBeenCalled();
  });
  it.each(['throw','reject'])('sanitizes unexpected executor %s without retry', async mode => {
    const { deps } = setup(); deps.executor = { execute: () => { if (mode === 'throw') throw new Error('SECRET'); return Promise.reject(new Error('SECRET')); } } as unknown as typeof deps.executor;
    expect(await execute(deps)).toEqual({ kind: 'tool_failed', code: 'execution_unavailable' }); expect(deps.decide).toHaveBeenCalledTimes(1);
  });
  it.each(['bytes','depth'])('retains output %s limits through next context', async boundary => {
    function nested(n: number) { let v = {}; for (let i = 1; i < n; i++) v = { child: v }; return v; }
    for (const valid of [true, false]) {
      const { deps, handler } = setup(); handler.mockReturnValue(boundary === 'bytes' ? { text: 'x'.repeat(valid ? 8181 : 8182) } : nested(valid ? 8 : 9));
      expect((await execute(deps)).kind).toBe(valid ? 'completed' : 'tool_failed'); expect(deps.decide).toHaveBeenCalledTimes(valid ? 2 : 1);
    }
  });
  it('keeps arguments immutable and special keys as harmless snapshot data', async () => {
    const { deps, handler } = setup(); handler.mockImplementation(args => {
      expect(Object.isFrozen(args)).toBe(true); expect(Reflect.set(args as object, 'message', 'changed')).toBe(false);
      return JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{}},"then":"data","toJSON":"data"}');
    });
    expect((await execute(deps)).kind).toBe('completed');
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    const context = deps.decide.mock.calls[1]![1];
    if (context.kind !== 'tool_result') throw new Error('Expected context');
    expect(Object.getPrototypeOf(context.outcome.output)).toBe(null); expect(Object.isFrozen(context.outcome.output.__proto__)).toBe(true);
  });
  it('does no external I/O or raw logging beyond injected persistence on pure fixture paths', async () => {
    const spies = [vi.spyOn(globalThis,'fetch'), vi.spyOn(Pool.prototype,'connect'), vi.spyOn(Pool.prototype,'query'), vi.spyOn(fs,'readFileSync'),vi.spyOn(fs,'writeFileSync'),vi.spyOn(fs.promises,'readFile'),vi.spyOn(fs.promises,'writeFile'),vi.spyOn(childProcess,'exec'),vi.spyOn(childProcess,'spawn'), ...(['log','info','warn','error','debug','trace'] as const).map(k => vi.spyOn(console,k))];
    const { deps, handler } = setup(); expect(await execute(deps)).toEqual({ kind: 'completed', content: 'done' });
    handler.mockImplementation(() => { throw new Error('SECRET'); }); deps.decide.mockReset().mockReturnValue(request());
    expect(await execute(deps)).toEqual({ kind: 'tool_failed', code: 'handler_error' });
    spies.forEach(s => expect(s).not.toHaveBeenCalled());
    expect(JSON.stringify(deps.toolRecorder.appendToolSucceededStepIfRunning.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(deps.finalizer.tryFinalizeWithStep.mock.calls)).not.toContain('SECRET');
  });
});
