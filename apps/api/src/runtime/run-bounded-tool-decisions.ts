import { types } from 'node:util';
import { InvalidRunInputError, parseModelDecision, runIdSchema, type ModelDecision } from '@axiom/contracts';
import type { Run, createRunRepository } from '../persistence/run-repository.js';
import type { createAtomicRunFinalizer } from '../persistence/atomic-run-finalizer.js';
import type { createRunContinueRecorder } from '../persistence/run-continue-recorder.js';
import type { createRunToolStepRecorder } from '../persistence/run-tool-step-recorder.js';
import { parseToolExecutionOutcome, type ToolExecutionOutcome, type ToolExecutionFailureCode } from '../tools/tool-execution-outcome.js';
import type { RuntimeResult } from './run-one-decision.js';

export type ToolDecisionContext =
  | { readonly kind: 'none' }
  | { readonly kind: 'tool_result'; readonly outcome: Extract<ToolExecutionOutcome, { kind: 'tool_succeeded' }> };
export type BoundedToolRuntimeResult = Exclude<RuntimeResult, { kind: 'unsupported_tool_request' }>
  | { kind: 'tool_failed'; code: ToolExecutionFailureCode }
  | { kind: 'tool_request_rejected' }
  | { kind: 'tool_execution_limit_exceeded' };
export interface BoundedToolRuntimeDependencies {
  repository: Pick<ReturnType<typeof createRunRepository>, 'tryStartRun' | 'findRunById'>;
  finalizer: ReturnType<typeof createAtomicRunFinalizer>;
  continueRecorder: ReturnType<typeof createRunContinueRecorder>;
  toolRecorder: ReturnType<typeof createRunToolStepRecorder>;
  // Trusted host dependencies. Outcome parsing validates data, not provenance.
  executor: { execute(runId: string, rawDecision: unknown): unknown };
  decide(run: Run, context: ToolDecisionContext): unknown;
}
const none: ToolDecisionContext = Object.freeze({ kind: 'none' });
const nativeThen = Promise.prototype.then;

// Never assimilate an arbitrary thenable before descriptor-based validation.
// Ordinary native Promises and unmodified Promise intrinsics are host assumptions.
async function invoke<T>(call: () => unknown, parse: (raw: unknown) => T, failed: () => T): Promise<T> {
  try {
    const raw = call();
    if (!types.isProxy(raw) && types.isPromise(raw)) return nativeThen.call(raw, parse, failed) as Promise<T>;
    return parse(raw);
  } catch { return failed(); }
}
type Decision = ModelDecision | { kind: 'invalid_decision' | 'decision_source_error' };
function decision(raw: unknown): Decision {
  try { return parseModelDecision(raw); } catch { return { kind: 'invalid_decision' }; }
}
type Execution = ToolExecutionOutcome | { kind: 'tool_request_rejected' };
function execution(raw: unknown): Execution {
  try { return parseToolExecutionOutcome(raw); } catch { /* Check only the fixed preflight failure envelope. */ }
  try {
    if (raw !== null && typeof raw === 'object' && !types.isProxy(raw) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(raw)) && Reflect.ownKeys(raw).length === 1) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, 'kind');
      if (descriptor?.enumerable && Object.hasOwn(descriptor, 'value') &&
          ['invalid_run_id', 'not_tool_request', 'unknown_tool', 'invalid_tool_arguments', 'invalid_model_decision'].includes(descriptor.value)) {
        return { kind: 'tool_request_rejected' };
      }
    }
  } catch { /* Never retain raw executor data or exceptions. */ }
  return { kind: 'tool_failed', code: 'invalid_tool_output' };
}

export async function runBoundedToolDecisions(
  runId: string, dependencies: BoundedToolRuntimeDependencies,
  options: { maxDecisions: number; maxToolExecutions: number },
): Promise<BoundedToolRuntimeResult> {
  const maxDecisions = options?.maxDecisions;
  const maxTools = options?.maxToolExecutions;
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 5 ||
      !Number.isInteger(maxTools) || maxTools < 0 || maxTools > 1) throw new Error('Invalid tool Runtime budgets');
  if (typeof runId !== 'string' || !runIdSchema.safeParse(runId).success) throw new InvalidRunInputError('Invalid Run ID');
  if (!dependencies) throw new Error('Tool Runtime dependencies are required');
  const { repository, finalizer, continueRecorder, toolRecorder, executor, decide } = dependencies;
  if (!repository || typeof repository.tryStartRun !== 'function' || typeof repository.findRunById !== 'function' ||
      !finalizer || typeof finalizer.tryFinalizeWithStep !== 'function' ||
      !continueRecorder || typeof continueRecorder.appendContinuedStepIfRunning !== 'function' ||
      !toolRecorder || typeof toolRecorder.appendToolSucceededStepIfRunning !== 'function' ||
      !executor || typeof executor.execute !== 'function' || typeof decide !== 'function') {
    throw new Error('Tool Runtime dependencies are required');
  }
  // Only this successful claim allows entry. No resume of another running Run.
  if (await repository.tryStartRun(runId) === null) return { kind: 'not_started' };
  let context = none;
  let attempts = 0;
  for (let index = 0; index < maxDecisions; index++) {
    const run = await repository.findRunById(runId);
    if (!run || run.status !== 'running') return { kind: 'finalize_conflict' };
    const currentContext = context;
    context = none; // Tool output is delivered to exactly one subsequent decision.
    const next = await invoke(() => decide(run, currentContext), decision, (): Decision => ({ kind: 'decision_source_error' }));
    let result: Exclude<BoundedToolRuntimeResult, { kind: 'not_started' | 'finalize_conflict' }>;
    if (next.kind === 'continue' && index + 1 < maxDecisions) {
      if (await continueRecorder.appendContinuedStepIfRunning(runId) === null) return { kind: 'finalize_conflict' };
      continue;
    }
    if (next.kind === 'tool_request') {
      // Decision slots take precedence over tool attempts when both are exhausted.
      if (index + 1 >= maxDecisions) result = { kind: 'decision_limit_exceeded' };
      else if (attempts >= maxTools) result = { kind: 'tool_execution_limit_exceeded' };
      else {
        const latest = await repository.findRunById(runId);
        if (!latest || latest.status !== 'running') return { kind: 'finalize_conflict' };
        attempts++;
        // No DB transaction spans the handler. This read is not a lease: external
        // finish can race with execute. The recorder/finalizer recheck under lock.
        const outcome = await invoke(() => executor.execute(runId, next), execution,
          (): Execution => ({ kind: 'tool_failed', code: 'execution_unavailable' }));
        if (outcome.kind === 'tool_succeeded') {
          if (await toolRecorder.appendToolSucceededStepIfRunning(runId) === null) return { kind: 'finalize_conflict' };
          context = Object.freeze({ kind: 'tool_result', outcome });
          continue; // Only after the Step COMMIT acknowledgement.
        }
        result = outcome;
      }
    } else if (next.kind === 'final') result = { kind: 'completed', content: next.content };
    else if (next.kind === 'continue') result = { kind: 'decision_limit_exceeded' };
    else result = next;
    // Keep all persistence outside source/executor catches. Never retry a DB error,
    // including an uncertain COMMIT; the persistence layer handles release/discard.
    return await finalizer.tryFinalizeWithStep(runId, result.kind) === null ? { kind: 'finalize_conflict' } : result;
  }
  throw new Error('Unexpected tool Runtime state');
}
