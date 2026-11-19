import { types } from 'node:util';
import { InvalidRunInputError, parseModelDecision, runIdSchema, validateTask, type ModelDecision } from '@axiom/contracts';
import type { createRunExecutionProgressRepository, RunExecutionProgress } from '../persistence/run-execution-progress-repository.js';
import type { Run } from '../persistence/run-repository.js';
import type { createRunToolStepRecorder } from '../persistence/run-tool-step-recorder.js';
import { snapshotToolArguments, type ToolArgumentsSnapshot } from '../tools/tool-arguments-snapshot.js';
import { parseToolExecutionOutcome, type ToolExecutionOutcome } from '../tools/tool-execution-outcome.js';
import type { BoundedToolRuntimeDependencies, BoundedToolRuntimeResult, ToolDecisionContext } from './run-bounded-tool-decisions.js';
import type { LeaseDecisionDependencies, LeaseDecisionOptions } from './run-lease-bounded-decisions.js';

export interface LeaseToolOptions extends LeaseDecisionOptions {
  maxToolAttempts: number;
}

export type LeaseToolDependencies = Omit<LeaseDecisionDependencies, 'decide'> &
  Pick<BoundedToolRuntimeDependencies, 'decide' | 'executor'> &
  Pick<ReturnType<typeof createRunExecutionProgressRepository>, 'tryReserveToolAttempt'> &
  Pick<ReturnType<typeof createRunToolStepRecorder>, 'appendToolSucceededStepWithLease'>;

export type LeaseToolResult = BoundedToolRuntimeResult | {
  kind: 'initialization_conflict' | 'decision_admission_conflict' | 'tool_admission_conflict' |
    'step_persistence_conflict' | 'checkpoint_conflict';
};

function dataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

const operations = [
  'tryClaimRunLease', 'initializeProgress', 'tryReserveDecision', 'tryConfirmCommittedStep',
  'tryReserveToolAttempt', 'appendToolSucceededStepWithLease', 'findRunById',
  'appendContinuedStepWithLease', 'tryFinalizeWithStepWithLease', 'decide',
] as const;

function uuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && runIdSchema.safeParse(value).success;
}

function integer(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

// Persistence factories return ordinary native promises. Reject a substituted
// thenable before await can run a getter, coercion or Proxy trap.
function nativePromise(value: unknown): value is Promise<unknown> {
  return !types.isProxy(value) && types.isPromise(value) && Object.getPrototypeOf(value) === Promise.prototype &&
    !Object.hasOwn(value, 'then') && !Object.hasOwn(value, 'constructor');
}
function acknowledged<T>(value: Promise<T>): Promise<T> {
  if (!nativePromise(value)) throw new Error('Invalid persistence response');
  return value;
}

// Validate metadata format only. Authority and expiry are evaluated by PostgreSQL.
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.slice(0, 23) + 'Z';
}
function validDate(value: unknown): boolean {
  return types.isDate(value) && Number.isFinite(Date.prototype.getTime.call(value));
}

function validProgress(p: RunExecutionProgress | null, runId: string, max: number,
  tools: number, attempts: number, version: number, reserved: number, watermark: number | null): p is RunExecutionProgress {
  return p !== null && dataRecord(p, ['runId', 'schemaVersion', 'checkpointVersion', 'lastConfirmedStepNo',
    'maxDecisions', 'decisionsReserved', 'maxToolAttempts', 'toolAttemptsReserved', 'createdAt', 'updatedAt']) &&
    p.runId === runId && p.schemaVersion === 1 && p.maxDecisions === max && p.decisionsReserved === reserved &&
    p.maxToolAttempts === tools && p.toolAttemptsReserved === attempts && p.checkpointVersion === version &&
    p.lastConfirmedStepNo === watermark && timestamp(p.createdAt) && timestamp(p.updatedAt) && p.createdAt <= p.updatedAt;
}

function validRun(run: Run | null, runId: string, status: Run['status']): run is Run {
  if (!run || !dataRecord(run, ['id', 'status', 'task', 'createdAt']) || run.id !== runId || run.status !== status ||
      typeof run.task !== 'string' || !validDate(run.createdAt)) return false;
  try { validateTask(run.task); return true; } catch { return false; }
}

const none: ToolDecisionContext = Object.freeze({ kind: 'none' });
const nativeThen = Promise.prototype.then;

// Never assimilate an arbitrary thenable before descriptor-based validation.
// Ordinary native Promises and unmodified Promise intrinsics are host assumptions.
async function invoke<T>(call: () => unknown, parse: (raw: unknown) => T, failed: () => T): Promise<T> {
  try {
    const raw = call();
    if (nativePromise(raw)) return nativeThen.call(raw, parse, failed) as Promise<T>;
    return parse(raw);
  } catch { return failed(); }
}
type Decision = Exclude<ModelDecision, { kind: 'tool_request' }> |
  { kind: 'tool_request'; toolName: string; arguments: ToolArgumentsSnapshot } | { kind: 'invalid_decision' | 'decision_source_error' };
function decision(raw: unknown): Decision {
  try {
    const parsed = parseModelDecision(raw);
    return parsed.kind === 'tool_request' ? { ...parsed, arguments: snapshotToolArguments(parsed.arguments) } : parsed;
  } catch { return { kind: 'invalid_decision' }; }
}
type Execution = ToolExecutionOutcome | { kind: 'tool_request_rejected' };
function execution(raw: unknown): Execution {
  try { return parseToolExecutionOutcome(raw); } catch { /* Check only the fixed preflight failure envelope. */ }
  if (dataRecord(raw, ['kind']) && typeof raw.kind === 'string' &&
      ['invalid_run_id', 'not_tool_request', 'unknown_tool', 'invalid_tool_arguments', 'invalid_model_decision'].includes(raw.kind)) {
    return { kind: 'tool_request_rejected' };
  }
  return { kind: 'tool_failed', code: 'invalid_tool_output' };
}

function validStep(step: unknown, runId: string, stepNo: number, kind: string): boolean {
  if (!dataRecord(step, ['runId', 'stepNo', 'resultKind', 'createdAt'])) return false;
  return step.runId === runId && step.stepNo === stepNo && step.resultKind === kind && validDate(step.createdAt);
}

export async function runLeaseBoundedToolDecisions(runId: string, dependencies: LeaseToolDependencies,
  options: LeaseToolOptions): Promise<LeaseToolResult> {
  if (!uuid(runId) || !dataRecord(options, ['ownerId', 'leaseSeconds', 'maxDecisions', 'maxToolAttempts']) ||
      !uuid(options.ownerId) || !integer(options.leaseSeconds, 300) || !integer(options.maxDecisions, 5) ||
      !(options.maxToolAttempts === 0 || options.maxToolAttempts === 1) ||
      !dataRecord(dependencies, [...operations, 'executor']) ||
      !operations.every(key => typeof dependencies[key] === 'function' && !types.isProxy(dependencies[key])) ||
      !dataRecord(dependencies.executor, ['execute']) || typeof dependencies.executor.execute !== 'function' ||
      types.isProxy(dependencies.executor.execute)) throw new InvalidRunInputError('Invalid lease tool input');

  runId = runId.toLowerCase();
  const ownerId = options.ownerId.toLowerCase();
  const { leaseSeconds, maxDecisions, maxToolAttempts } = options;
  const { tryClaimRunLease, initializeProgress, findRunById, tryReserveDecision, tryReserveToolAttempt, decide,
    appendContinuedStepWithLease, appendToolSucceededStepWithLease, tryConfirmCommittedStep,
    tryFinalizeWithStepWithLease, executor } = dependencies;
  const { execute } = executor;

  const claim = await acknowledged(tryClaimRunLease(runId, { ownerId, leaseSeconds }));
  if (claim === null) return { kind: 'not_started' };
  if (!dataRecord(claim, ['runId', 'ownerId', 'leaseToken', 'leaseSeconds', 'acquiredAt', 'renewedAt', 'expiresAt']) ||
      claim.runId !== runId || claim.ownerId !== ownerId || claim.leaseSeconds !== leaseSeconds || !uuid(claim.leaseToken) ||
      !timestamp(claim.acquiredAt) || claim.renewedAt !== claim.acquiredAt || !timestamp(claim.expiresAt) ||
      claim.expiresAt <= claim.renewedAt) {
    throw new Error('Invalid lease claim response');
  }
  const credentials = Object.freeze({ ownerId, leaseToken: claim.leaseToken });
  const initial = await acknowledged(initializeProgress(runId, credentials, { maxDecisions, maxToolAttempts }));
  if (!validProgress(initial, runId, maxDecisions, maxToolAttempts, 0, 0, 0, null)) return { kind: 'initialization_conflict' };
  const created = initial.createdAt;
  let version = 0;
  let attempts = 0;
  let watermark: number | null = null;
  let context: ToolDecisionContext = none;
  let identity: { task: string; createdAt: number } | undefined;
  function advances(p: RunExecutionProgress | null, slot: number, tools: number, confirmed: number | null) {
    return validProgress(p, runId, maxDecisions, maxToolAttempts, tools, version + 1, slot, confirmed) && p.createdAt === created;
  }

  for (let slot = 1; slot <= maxDecisions; slot++) {
    const row = await acknowledged(findRunById(runId));
    if (!validRun(row, runId, 'running')) return { kind: 'decision_admission_conflict' };
    const task = row.task;
    const createdAt = Date.prototype.getTime.call(row.createdAt);
    if (identity && (task !== identity.task || createdAt !== identity.createdAt)) return { kind: 'decision_admission_conflict' };
    identity ??= { task, createdAt };
    const run = { ...row, createdAt: new Date(createdAt) };
    const admission = await acknowledged(tryReserveDecision(runId, credentials, version));
    if (!advances(admission, slot, attempts, watermark)) return { kind: 'decision_admission_conflict' };
    version++;
    const previous = context;
    context = none;
    const next = await invoke(() => decide(run, previous), decision, (): Decision => ({ kind: 'decision_source_error' }));

    let result: Exclude<BoundedToolRuntimeResult, { kind: 'finalize_conflict' | 'not_started' }> | undefined;
    let followingContext: ToolDecisionContext = none;
    if (next.kind === 'final') result = { kind: 'completed', content: next.content };
    else if (next.kind === 'invalid_decision' || next.kind === 'decision_source_error') result = next;
    else if (slot === maxDecisions) result = { kind: 'decision_limit_exceeded' };
    else if (next.kind === 'tool_request') {
      if (attempts >= maxToolAttempts) result = { kind: 'tool_execution_limit_exceeded' };
      else {
        const reserved = await acknowledged(tryReserveToolAttempt(runId, credentials, version));
        if (!advances(reserved, slot, attempts + 1, watermark)) return { kind: 'tool_admission_conflict' };
        version++;
        attempts++;
        // Admission has committed. Only the trusted executor may authorize its handler.
        const outcome = await invoke(() => Reflect.apply(execute, executor, [runId, next]), execution,
          (): Execution => ({ kind: 'tool_failed', code: 'execution_unavailable' }));
        if (outcome.kind === 'tool_succeeded') followingContext = Object.freeze({ kind: 'tool_result', outcome });
        else result = outcome;
      }
    }

    if (result) {
      const finished = await acknowledged(tryFinalizeWithStepWithLease(runId, result.kind, credentials));
      if (!finished || !dataRecord(finished, ['run', 'step']) ||
          !validRun(finished.run, runId, result.kind === 'completed' ? 'completed' : 'failed') ||
          finished.run.task !== task || Date.prototype.getTime.call(finished.run.createdAt) !== createdAt ||
          !validStep(finished.step, runId, slot, result.kind)) return { kind: 'finalize_conflict' };
      return result;
    }

    const tool = followingContext.kind === 'tool_result';
    const append = tool ? appendToolSucceededStepWithLease : appendContinuedStepWithLease;
    const step = await acknowledged(append(runId, credentials));
    if (!validStep(step, runId, slot, tool ? 'tool_succeeded' : 'continued')) return { kind: 'step_persistence_conflict' };
    const confirmed = await acknowledged(tryConfirmCommittedStep(runId, credentials, { expectedVersion: version, stepNo: slot }));
    if (!advances(confirmed, slot, attempts, slot)) return { kind: 'checkpoint_conflict' };
    version++;
    watermark = slot;
    context = followingContext;
  }
  throw new Error('Unexpected lease tool decision state');
}
