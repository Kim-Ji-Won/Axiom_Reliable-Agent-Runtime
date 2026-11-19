import { types } from 'node:util';
import { InvalidRunInputError, runIdSchema, validateTask } from '@axiom/contracts';
import type { createRunExecutionLeaseRepository } from '../persistence/run-execution-lease-repository.js';
import type { createRunExecutionProgressRepository, RunExecutionProgress } from '../persistence/run-execution-progress-repository.js';
import type { createRunRepository, Run } from '../persistence/run-repository.js';
import type { createRunContinueRecorder } from '../persistence/run-continue-recorder.js';
import type { createAtomicRunFinalizer } from '../persistence/atomic-run-finalizer.js';
import { decideOnce, type RuntimeResult } from './run-one-decision.js';

export interface LeaseDecisionOptions {
  ownerId: string;
  leaseSeconds: number;
  maxDecisions: number;
}

// Accept only the operations required by this entry point. No lookup of a token,
// renewal, tool, snapshot or legacy writer is needed.
export type LeaseDecisionDependencies =
  Pick<ReturnType<typeof createRunExecutionLeaseRepository>, 'tryClaimRunLease'> &
  Pick<ReturnType<typeof createRunExecutionProgressRepository>,
    'initializeProgress' | 'tryReserveDecision' | 'tryConfirmCommittedStep'> &
  Pick<ReturnType<typeof createRunRepository>, 'findRunById'> &
  Pick<ReturnType<typeof createRunContinueRecorder>, 'appendContinuedStepWithLease'> &
  Pick<ReturnType<typeof createAtomicRunFinalizer>, 'tryFinalizeWithStepWithLease'> &
  { decide(run: Run): unknown };

export type LeaseDecisionResult = RuntimeResult | {
  kind: 'initialization_conflict' | 'decision_admission_conflict' | 'step_persistence_conflict' | 'checkpoint_conflict';
};

function dataRecord(value: unknown, keys: readonly string[]): boolean {
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
  'findRunById', 'appendContinuedStepWithLease', 'tryFinalizeWithStepWithLease', 'decide',
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
  version: number, reserved: number, watermark: number | null): p is RunExecutionProgress {
  return p !== null && dataRecord(p, ['runId', 'schemaVersion', 'checkpointVersion', 'lastConfirmedStepNo',
    'maxDecisions', 'decisionsReserved', 'maxToolAttempts', 'toolAttemptsReserved', 'createdAt', 'updatedAt']) &&
    p.runId === runId && p.schemaVersion === 1 && p.maxDecisions === max && p.decisionsReserved === reserved &&
    p.maxToolAttempts === 0 && p.toolAttemptsReserved === 0 && p.checkpointVersion === version &&
    p.lastConfirmedStepNo === watermark && timestamp(p.createdAt) && timestamp(p.updatedAt) && p.createdAt <= p.updatedAt;
}

function validRun(run: Run | null, runId: string, status: Run['status']): run is Run {
  if (!run || !dataRecord(run, ['id', 'status', 'task', 'createdAt']) || run.id !== runId || run.status !== status ||
      typeof run.task !== 'string' || !validDate(run.createdAt)) return false;
  try { validateTask(run.task); return true; } catch { return false; }
}

export async function runLeaseBoundedDecisions(runId: string, dependencies: LeaseDecisionDependencies,
  options: LeaseDecisionOptions): Promise<LeaseDecisionResult> {
  if (!uuid(runId) || !dataRecord(options, ['ownerId', 'leaseSeconds', 'maxDecisions']) || !uuid(options.ownerId) ||
      !integer(options.leaseSeconds, 300) || !integer(options.maxDecisions, 5) || !dataRecord(dependencies, operations) ||
      !operations.every(key => typeof dependencies[key] === 'function' && !types.isProxy(dependencies[key]))) {
    throw new InvalidRunInputError('Invalid lease decision input');
  }
  runId = runId.toLowerCase();
  const ownerId = options.ownerId.toLowerCase();
  const { leaseSeconds, maxDecisions } = options;
  const { tryClaimRunLease, initializeProgress, findRunById, tryReserveDecision, decide,
    appendContinuedStepWithLease, tryConfirmCommittedStep, tryFinalizeWithStepWithLease } = dependencies;

  const claim = await acknowledged(tryClaimRunLease(runId, { ownerId, leaseSeconds }));
  if (claim === null) return { kind: 'not_started' };
  if (!dataRecord(claim, ['runId', 'ownerId', 'leaseToken', 'leaseSeconds', 'acquiredAt', 'renewedAt', 'expiresAt']) ||
      claim.runId !== runId || claim.ownerId !== ownerId || claim.leaseSeconds !== leaseSeconds || !uuid(claim.leaseToken) ||
      !timestamp(claim.acquiredAt) || claim.renewedAt !== claim.acquiredAt || !timestamp(claim.expiresAt) ||
      claim.expiresAt <= claim.renewedAt) {
    throw new Error('Invalid lease claim response');
  }
  const credentials = Object.freeze({ ownerId, leaseToken: claim.leaseToken });
  let progress = await acknowledged(initializeProgress(runId, credentials, { maxDecisions, maxToolAttempts: 0 }));
  if (!validProgress(progress, runId, maxDecisions, 0, 0, null)) return { kind: 'initialization_conflict' };
  let version = progress.checkpointVersion;
  let watermark = progress.lastConfirmedStepNo;

  for (let slot = 1; slot <= maxDecisions; slot++) {
    const row = await acknowledged(findRunById(runId));
    if (!validRun(row, runId, 'running')) return { kind: 'decision_admission_conflict' };
    const run = { ...row, createdAt: new Date(Date.prototype.getTime.call(row.createdAt)) };
    progress = await acknowledged(tryReserveDecision(runId, credentials, version));
    if (!validProgress(progress, runId, maxDecisions, version + 1, slot, watermark)) return { kind: 'decision_admission_conflict' };
    version = progress.checkpointVersion;

    const decision = await decideOnce(run, () => {
      const raw = decide(run);
      if (nativePromise(raw)) return raw;
      // Avoid assimilating a synchronous hostile envelope before decideOnce parses it.
      if (!raw || typeof raw !== 'object' || types.isProxy(raw) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || 'then' in raw) return Promise.resolve(null);
      return Promise.resolve(raw);
    });

    if (decision.kind === 'continue' && slot < maxDecisions) {
      const step = await acknowledged(appendContinuedStepWithLease(runId, credentials));
      if (!step || !dataRecord(step, ['runId', 'stepNo', 'resultKind', 'createdAt']) ||
          !validDate(step.createdAt) || step.runId !== runId || step.resultKind !== 'continued' || step.stepNo !== (watermark ?? 0) + 1) {
        return { kind: 'step_persistence_conflict' };
      }
      const stepNo = step.stepNo;
      progress = await acknowledged(tryConfirmCommittedStep(runId, credentials, { expectedVersion: version, stepNo }));
      if (!validProgress(progress, runId, maxDecisions, version + 1, slot, stepNo)) return { kind: 'checkpoint_conflict' };
      version = progress.checkpointVersion;
      watermark = progress.lastConfirmedStepNo;
      continue;
    }

    const result = decision.kind === 'continue' ? { kind: 'decision_limit_exceeded' as const } : decision;
    const finished = await acknowledged(tryFinalizeWithStepWithLease(runId, result.kind, credentials));
    if (!finished || !dataRecord(finished, ['run', 'step']) ||
        !validRun(finished.run, runId, result.kind === 'completed' ? 'completed' : 'failed') ||
        finished.run.task !== row.task || Date.prototype.getTime.call(finished.run.createdAt) !== Date.prototype.getTime.call(row.createdAt) ||
        !dataRecord(finished.step, ['runId', 'stepNo', 'resultKind', 'createdAt']) || finished.step.runId !== runId ||
        !validDate(finished.step.createdAt) || finished.step.resultKind !== result.kind || finished.step.stepNo !== slot) return { kind: 'finalize_conflict' };
    return result;
  }
  throw new Error('Unexpected lease decision state');
}
