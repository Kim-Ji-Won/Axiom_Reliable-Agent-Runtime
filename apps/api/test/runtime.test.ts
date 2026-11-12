import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidRunInputError } from '@axiom/contracts';
import { createRunRepository, type Run } from '../src/persistence/run-repository.js';
import { runOneDecision, type RuntimeDependencies } from '../src/runtime/run-one-decision.js';

const id = '12345678-1234-4234-8234-123456789abc';
const running: Run = { id, task: 'TASK_SENTINEL', status: 'running', createdAt: new Date('2026-11-11T00:00:00Z') };
const content = '  FINAL_SENTINEL 분석 결과 😀  ';
const cases = [
  { kind: 'completed', decide: async () => ({ kind: 'final', content }), outcome: 'completed' },
  { kind: 'unsupported_tool_request', decide: async () => ({ kind: 'tool_request', toolName: 'tool_sentinel', arguments: { secret: 'ARG_SENTINEL' } }), outcome: 'failed' },
  { kind: 'invalid_decision', decide: async () => ({ kind: 'final', content, extra: 'RAW_SENTINEL' }), outcome: 'failed' },
  { kind: 'decision_source_error', decide: () => { throw new Error('ERROR_SENTINEL'); }, outcome: 'failed' },
  { kind: 'decision_source_error', decide: async () => { throw new Error('ERROR_SENTINEL'); }, outcome: 'failed' },
  { kind: 'decision_limit_exceeded', decide: async () => ({ kind: 'continue' }), outcome: 'failed' },
] as const;

function setup(decision: RuntimeDependencies['decide'] = cases[0].decide) {
  return {
    repository: {
      tryStartRun: vi.fn<RuntimeDependencies['repository']['tryStartRun']>().mockResolvedValue({ ...running }),
    },
    finalizer: {
      tryFinalizeWithStep: vi.fn<RuntimeDependencies['finalizer']['tryFinalizeWithStep']>().mockImplementation(async (_, kind) => ({
        run: { ...running, status: kind === 'completed' ? 'completed' : 'failed' },
        step: { runId: id, stepNo: 1, resultKind: kind, createdAt: running.createdAt },
      })),
    },
    decide: vi.fn(decision),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('one-shot Runtime', () => {
  it('rejects missing atomic finalizer before claim without falling back to direct finish', async () => {
    const deps = setup();
    const direct = vi.fn();
    const unsafe = { repository: { ...deps.repository, tryFinishRun: direct }, decide: deps.decide };
    await expect(runOneDecision(id, unsafe as unknown as RuntimeDependencies)).rejects.toThrow('Atomic Run finalizer is required');
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled();
    expect(deps.decide).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it.each(cases)('claims then decides once and finalizes $kind (%#)', async test => {
    const deps = setup(test.decide);
    const logs = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const spies = logs.map(method => vi.spyOn(console, method));
    const result = await runOneDecision(id, deps);
    expect(result).toEqual(test.kind === 'completed' ? { kind: test.kind, content } : { kind: test.kind });
    expect(deps.repository.tryStartRun).toHaveBeenCalledExactlyOnceWith(id);
    expect(deps.decide).toHaveBeenCalledExactlyOnceWith(running);
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, test.kind);
    expect(deps.repository.tryStartRun.mock.invocationCallOrder[0]).toBeLessThan(deps.decide.mock.invocationCallOrder[0]!);
    expect(deps.decide.mock.invocationCallOrder[0]).toBeLessThan(deps.finalizer.tryFinalizeWithStep.mock.invocationCallOrder[0]!);
    if (result.kind !== 'completed') expect(JSON.stringify(result)).not.toMatch(/SENTINEL|tool_sentinel/);
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it('does not decide or finalize when the atomic claim returns null', async () => {
    const deps = setup();
    deps.repository.tryStartRun.mockResolvedValue(null);
    expect(await runOneDecision(id, deps)).toEqual({ kind: 'not_started' });
    expect(deps.repository.tryStartRun).toHaveBeenCalledExactlyOnceWith(id);
    expect(deps.decide).not.toHaveBeenCalled();
    expect(deps.finalizer.tryFinalizeWithStep).not.toHaveBeenCalled();
  });

  it('uses existing UUID validation before SQL and never calls decide for an invalid ID', async () => {
    const query = vi.fn();
    const deps = { finalizer: setup().finalizer, repository: createRunRepository({ query }), decide: vi.fn(cases[0].decide) };
    await expect(runOneDecision('bad-id', deps)).rejects.toThrow(InvalidRunInputError);
    expect(query).not.toHaveBeenCalled();
    expect(deps.decide).not.toHaveBeenCalled();
  });

  it('propagates a start DB error without deciding, finalizing, or retrying', async () => {
    const deps = setup();
    const error = new Error('database unavailable');
    deps.repository.tryStartRun.mockRejectedValue(error);
    await expect(runOneDecision(id, deps)).rejects.toBe(error);
    expect(deps.repository.tryStartRun).toHaveBeenCalledTimes(1);
    expect(deps.decide).not.toHaveBeenCalled();
    expect(deps.finalizer.tryFinalizeWithStep).not.toHaveBeenCalled();
  });

  it.each(cases)('returns only finalize_conflict if $kind cannot be persisted (%#)', async test => {
    const deps = setup(test.decide);
    deps.finalizer.tryFinalizeWithStep.mockResolvedValue(null);
    expect(await runOneDecision(id, deps)).toEqual({ kind: 'finalize_conflict' });
    expect(deps.repository.tryStartRun).toHaveBeenCalledTimes(1);
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, test.kind);
  });

  it.each(cases)('propagates finish DB errors for $kind without disguising or retrying them (%#)', async test => {
    const deps = setup(test.decide);
    const error = new Error('database unavailable');
    deps.finalizer.tryFinalizeWithStep.mockRejectedValue(error);
    await expect(runOneDecision(id, deps)).rejects.toBe(error);
    expect(deps.repository.tryStartRun).toHaveBeenCalledTimes(1);
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, test.kind);
  });

  it('rejects hostile model output without executing getters or tools, or making network calls', async () => {
    const effect = vi.fn(() => { throw new Error('ERROR_SENTINEL'); });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const deps = setup(async () => Object.defineProperty({ kind: 'final' }, 'content', { enumerable: true, get: effect }));
    expect(await runOneDecision(id, deps)).toEqual({ kind: 'invalid_decision' });
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, 'invalid_decision');
    // Even extra capabilities supplied by a caller are not consulted or authorized.
    const toolDeps = { ...setup(cases[1].decide), tools: { tool_sentinel: effect }, authorize: effect };
    expect(await runOneDecision(id, toolDeps)).toEqual({ kind: 'unsupported_tool_request' });
    expect(toolDeps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, 'unsupported_tool_request');
    expect(effect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
