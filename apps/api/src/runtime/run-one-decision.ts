import { parseModelDecision } from '@axiom/contracts';
import type { createAtomicRunFinalizer } from '../persistence/atomic-run-finalizer.js';
import type { createRunRepository, Run } from '../persistence/run-repository.js';

export type RuntimeResult =
  | { kind: 'not_started' }
  | { kind: 'completed'; content: string }
  | { kind: 'unsupported_tool_request' }
  | { kind: 'invalid_decision' }
  | { kind: 'decision_source_error' }
  | { kind: 'finalize_conflict' };

export interface RuntimeDependencies {
  repository: Pick<ReturnType<typeof createRunRepository>, 'tryStartRun'>;
  finalizer: ReturnType<typeof createAtomicRunFinalizer>;
  decide(run: Run): Promise<unknown>;
}

type DecisionResult = Exclude<RuntimeResult, { kind: 'not_started' | 'finalize_conflict' }>;

async function decideOnce(run: Run, decide: RuntimeDependencies['decide']): Promise<DecisionResult> {
  let raw: unknown;
  try {
    raw = await decide(run);
  } catch {
    // Source failures are untrusted too: retain neither the error nor its cause.
    return { kind: 'decision_source_error' };
  }
  try {
    const decision = parseModelDecision(raw);
    return decision.kind === 'final'
      ? { kind: 'completed', content: decision.content }
      : { kind: 'unsupported_tool_request' };
  } catch {
    return { kind: 'invalid_decision' };
  }
}

export async function runOneDecision(runId: string, dependencies: RuntimeDependencies): Promise<RuntimeResult> {
  const { repository, finalizer, decide } = dependencies;
  if (!finalizer || typeof finalizer.tryFinalizeWithStep !== 'function') {
    throw new Error('Atomic Run finalizer is required');
  }
  const run = await repository.tryStartRun(runId);
  if (run === null) return { kind: 'not_started' };

  const result = await decideOnce(run, decide);
  // Keep persistence outside the decision catches. DB errors reject without retry.
  // A model request is not execution authorization; tool requests fail closed.
  const finished = await finalizer.tryFinalizeWithStep(runId, result.kind);
  return finished === null ? { kind: 'finalize_conflict' } : result;
}
