import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunRepository, type Run } from '../src/persistence/run-repository.js';
import { runBoundedDecisions, type BoundedRuntimeDependencies } from '../src/runtime/run-bounded-decisions.js';

const id = '12345678-1234-4234-8234-123456789abc';
const run: Run = { id, task: 'TASK_SENTINEL', status: 'running', createdAt: new Date() };
const content = ' FINAL_SENTINEL 😀 ';
function setup() {
  return {
    repository: {
      tryStartRun: vi.fn<BoundedRuntimeDependencies['repository']['tryStartRun']>().mockResolvedValue(run),
      findRunById: vi.fn<BoundedRuntimeDependencies['repository']['findRunById']>().mockResolvedValue(run),
    },
    finalizer: {
      tryFinalizeWithStep: vi.fn<BoundedRuntimeDependencies['finalizer']['tryFinalizeWithStep']>().mockImplementation(async (_, kind) => ({
        run: { ...run, status: kind === 'completed' ? 'completed' : 'failed' },
        step: { runId: id, stepNo: 1, resultKind: kind, createdAt: run.createdAt },
      })),
    },
    continueRecorder: {
      appendContinuedStepIfRunning: vi.fn<BoundedRuntimeDependencies['continueRecorder']['appendContinuedStepIfRunning']>()
        .mockResolvedValue({ runId: id, stepNo: 1, resultKind: 'continued', createdAt: run.createdAt }),
    },
    decide: vi.fn<BoundedRuntimeDependencies['decide']>().mockResolvedValue({ kind: 'continue' }),
  };
}
afterEach(() => vi.restoreAllMocks());

describe('bounded Runtime', () => {
  it.each([0, -1, 1.5, 6, NaN, Infinity, null, undefined, '3', true])('rejects invalid budget %# before any work', async value => {
    const deps = setup();
    await expect(runBoundedDecisions(id, deps, { maxDecisions: value as number })).rejects.toThrow('Invalid decision limit');
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled();
    expect(deps.repository.findRunById).not.toHaveBeenCalled();
    expect(deps.decide).not.toHaveBeenCalled();
    expect(deps.continueRecorder.appendContinuedStepIfRunning).not.toHaveBeenCalled();
    expect(deps.finalizer.tryFinalizeWithStep).not.toHaveBeenCalled();
  });
  it('requires explicit options without a default', async () => {
    const deps = setup();
    // @ts-expect-error Deliberately omit the required budget.
    await expect(runBoundedDecisions(id, deps)).rejects.toThrow('Invalid decision limit');
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled();
  });
  it.each(['finalizer', 'continueRecorder', 'decide', 'repository'] as const)('rejects missing %s before claiming', async key => {
    const deps = setup();
    await expect(runBoundedDecisions(id, { ...deps, [key]: undefined } as unknown as BoundedRuntimeDependencies, { maxDecisions: 3 }))
      .rejects.toThrow('Bounded Runtime dependencies are required');
    expect(deps.repository.tryStartRun).not.toHaveBeenCalled();
    expect(deps.decide).not.toHaveBeenCalled();
  });
  it('uses repository UUID validation before SQL', async () => {
    const query = vi.fn();
    const deps = { ...setup(), repository: createRunRepository({ query }) };
    await expect(runBoundedDecisions('INVALID_SENTINEL', deps, { maxDecisions: 2 })).rejects.toThrow('UUID');
    expect(query).not.toHaveBeenCalled();
    expect(deps.decide).not.toHaveBeenCalled();
  });
  it.each([1, 2, 5])('allows exactly %s sequential decisions and one Step per decision', async maxDecisions => {
    const deps = setup();
    const order: string[] = [];
    deps.decide.mockImplementation(async () => { order.push('decide'); return { kind: 'continue' }; });
    const append = deps.continueRecorder.appendContinuedStepIfRunning.getMockImplementation()!;
    deps.continueRecorder.appendContinuedStepIfRunning.mockImplementation(async id => { order.push('commit'); return append(id); });
    expect(await runBoundedDecisions(id, deps, { maxDecisions })).toEqual({ kind: 'decision_limit_exceeded' });
    expect(deps.repository.tryStartRun).toHaveBeenCalledExactlyOnceWith(id);
    expect(deps.decide).toHaveBeenCalledTimes(maxDecisions);
    expect(deps.continueRecorder.appendContinuedStepIfRunning).toHaveBeenCalledTimes(maxDecisions - 1);
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, 'decision_limit_exceeded');
    expect(order).toEqual([...Array.from({ length: maxDecisions - 1 }, () => ['decide', 'commit']).flat(), 'decide']);
  });
  it.each([
    { raw: { kind: 'final', content }, kind: 'completed' },
    { raw: { kind: 'tool_request', toolName: 'tool_sentinel', arguments: { value: 'ARG_SENTINEL' } }, kind: 'unsupported_tool_request' },
    { raw: { kind: 'continue', reason: 'RAW_SENTINEL' }, kind: 'invalid_decision' },
  ] as const)('continues once then terminates on $kind without exposing model data', async test => {
    const deps = setup();
    const effects = vi.fn();
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(m => vi.spyOn(console, m));
    const network = vi.spyOn(globalThis, 'fetch');
    deps.decide.mockResolvedValueOnce({ kind: 'continue' }).mockResolvedValueOnce(test.raw);
    const result = await runBoundedDecisions(id, { ...deps, ...{ tools: effects, authorize: effects } }, { maxDecisions: 5 });
    expect(result).toEqual(test.kind === 'completed' ? { kind: 'completed', content } : { kind: test.kind });
    expect(deps.decide).toHaveBeenCalledTimes(2);
    expect(deps.continueRecorder.appendContinuedStepIfRunning).toHaveBeenCalledTimes(1);
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, test.kind);
    if (result.kind !== 'completed') expect(JSON.stringify(result)).not.toMatch(/SENTINEL|tool_sentinel/);
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(effects).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('continues twice then returns final content after exactly three decisions', async () => {
    const deps = setup();
    deps.decide.mockResolvedValueOnce({ kind: 'continue' }).mockResolvedValueOnce({ kind: 'continue' }).mockResolvedValueOnce({ kind: 'final', content });
    expect(await runBoundedDecisions(id, deps, { maxDecisions: 5 })).toEqual({ kind: 'completed', content });
    expect(deps.decide).toHaveBeenCalledTimes(3);
    expect(deps.continueRecorder.appendContinuedStepIfRunning).toHaveBeenCalledTimes(2);
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, 'completed');
  });
  it.each(['throw', 'reject'])('safely terminates after a source %s', async mode => {
    const deps = setup();
    deps.decide.mockResolvedValueOnce({ kind: 'continue' }).mockImplementationOnce(() => {
      const error = new Error('ERROR_SENTINEL CREDENTIAL_SENTINEL', { cause: 'CAUSE_SENTINEL' });
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    });
    expect(await runBoundedDecisions(id, deps, { maxDecisions: 5 })).toEqual({ kind: 'decision_source_error' });
    expect(deps.decide).toHaveBeenCalledTimes(2);
    expect(deps.finalizer.tryFinalizeWithStep).toHaveBeenCalledExactlyOnceWith(id, 'decision_source_error');
  });
  it('does no work after a failed claim', async () => {
    const deps = setup(); deps.repository.tryStartRun.mockResolvedValue(null);
    expect(await runBoundedDecisions(id, deps, { maxDecisions: 5 })).toEqual({ kind: 'not_started' });
    expect(deps.repository.findRunById).not.toHaveBeenCalled(); expect(deps.decide).not.toHaveBeenCalled();
    expect(deps.continueRecorder.appendContinuedStepIfRunning).not.toHaveBeenCalled();
    expect(deps.finalizer.tryFinalizeWithStep).not.toHaveBeenCalled();
  });
  it.each(['recorder', 'finalizer'])('stops after %s conflict without returning content or retrying', async stage => {
    const deps = setup();
    if (stage === 'recorder') deps.continueRecorder.appendContinuedStepIfRunning.mockResolvedValue(null);
    else { deps.decide.mockResolvedValueOnce({ kind: 'final', content }); deps.finalizer.tryFinalizeWithStep.mockResolvedValue(null); }
    expect(await runBoundedDecisions(id, deps, { maxDecisions: 5 })).toEqual({ kind: 'finalize_conflict' });
    expect(deps.decide).toHaveBeenCalledTimes(1);
    if (stage === 'recorder') expect(deps.finalizer.tryFinalizeWithStep).not.toHaveBeenCalled();
    else expect(deps.continueRecorder.appendContinuedStepIfRunning).not.toHaveBeenCalled();
  });
  it.each([null, 'completed', 'failed'] as const)('stops before the next decide after observing %s', async status => {
    const deps = setup();
    deps.repository.findRunById.mockResolvedValueOnce(run).mockResolvedValue(status === null ? null : { ...run, status });
    expect(await runBoundedDecisions(id, deps, { maxDecisions: 5 })).toEqual({ kind: 'finalize_conflict' });
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(deps.continueRecorder.appendContinuedStepIfRunning).toHaveBeenCalledTimes(1);
    expect(deps.finalizer.tryFinalizeWithStep).not.toHaveBeenCalled();
  });
  it.each(['claim', 'read', 'recorder', 'finalizer'] as const)('propagates %s DB failure without disguising it', async stage => {
    const deps = setup(); const error = new Error('DB_SENTINEL');
    const operation = stage === 'claim' ? deps.repository.tryStartRun : stage === 'read' ? deps.repository.findRunById :
      stage === 'recorder' ? deps.continueRecorder.appendContinuedStepIfRunning : deps.finalizer.tryFinalizeWithStep;
    operation.mockRejectedValue(error);
    await expect(runBoundedDecisions(id, deps, { maxDecisions: stage === 'finalizer' ? 1 : 5 })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(deps.decide).toHaveBeenCalledTimes(stage === 'claim' || stage === 'read' ? 0 : 1);
  });
  it.each(['recorder', 'finalizer'])('waits for %s COMMIT before continuing or returning final content', async stage => {
    const deps = setup();
    let acknowledge!: () => void;
    const gate = new Promise<void>(resolve => { acknowledge = resolve; });
    const operation = stage === 'recorder' ? deps.continueRecorder.appendContinuedStepIfRunning : deps.finalizer.tryFinalizeWithStep;
    if (stage === 'recorder') {
      const original = deps.continueRecorder.appendContinuedStepIfRunning.getMockImplementation()!;
      deps.continueRecorder.appendContinuedStepIfRunning.mockImplementationOnce(async id => { await gate; return original(id); });
    } else {
      deps.decide.mockResolvedValue({ kind: 'final', content });
      const original = deps.finalizer.tryFinalizeWithStep.getMockImplementation()!;
      deps.finalizer.tryFinalizeWithStep.mockImplementationOnce(async (id, kind) => { await gate; return original(id, kind); });
    }
    let resolved = false;
    const pending = runBoundedDecisions(id, deps, { maxDecisions: 2 }).then(value => { resolved = true; return value; });
    try {
      await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
      expect(deps.decide).toHaveBeenCalledTimes(1); expect(resolved).toBe(false);
    } finally { acknowledge(); await pending; }
    expect(resolved).toBe(true);
  });
});
