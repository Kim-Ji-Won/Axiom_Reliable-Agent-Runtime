import type { createRunRepository } from '../persistence/run-repository.js';
import type { createRunContinueRecorder } from '../persistence/run-continue-recorder.js';
import { decideOnce, type RuntimeDependencies, type RuntimeResult } from './run-one-decision.js';

export interface BoundedRuntimeDependencies extends RuntimeDependencies {
  repository: Pick<ReturnType<typeof createRunRepository>, 'tryStartRun' | 'findRunById'>;
  continueRecorder: ReturnType<typeof createRunContinueRecorder>;
}

export async function runBoundedDecisions(
  runId: string, dependencies: BoundedRuntimeDependencies, options: { maxDecisions: number },
): Promise<RuntimeResult> {
  const maxDecisions = options?.maxDecisions;
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 5) {
    throw new Error('Invalid decision limit');
  }
  const { repository, finalizer, continueRecorder, decide } = dependencies;
  if (!repository || typeof repository.tryStartRun !== 'function' ||
      typeof repository.findRunById !== 'function' ||
      !finalizer || typeof finalizer.tryFinalizeWithStep !== 'function' ||
      !continueRecorder || typeof continueRecorder.appendContinuedStepIfRunning !== 'function' ||
      typeof decide !== 'function') {
    throw new Error('Bounded Runtime dependencies are required');
  }
  let run = await repository.tryStartRun(runId);
  if (run === null) return { kind: 'not_started' };
  for (let index = 0; index < maxDecisions; index++) {
    // Observe external termination before each decision. This is not a lease:
    // another writer may finish after this read; persistence rechecks under lock.
    run = await repository.findRunById(runId);
    if (run === null || run.status !== 'running') return { kind: 'finalize_conflict' };
    const decision = await decideOnce(run, decide);
    if (decision.kind === 'continue' && index + 1 < maxDecisions) {
      // Await COMMIT before observing state and calling the next decision source.
      if (await continueRecorder.appendContinuedStepIfRunning(runId) === null) {
        return { kind: 'finalize_conflict' };
      }
      continue;
    }
    const result = decision.kind === 'continue'
      ? { kind: 'decision_limit_exceeded' as const } : decision;
    // Persistence errors must escape unchanged, outside source/parser catches.
    const finished = await finalizer.tryFinalizeWithStep(runId, result.kind);
    return finished === null ? { kind: 'finalize_conflict' } : result;
  }
  throw new Error('Unexpected Runtime state');
}
