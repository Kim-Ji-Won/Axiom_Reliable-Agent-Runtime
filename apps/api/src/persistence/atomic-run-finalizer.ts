import { captureLeaseCredentials, leaseWriteId, lockWriteParent, leaseWriteGuard, type LeaseWriteCredentials } from './lease-write-guard.js';
import { InvalidRunInputError, runIdSchema, runOutcomeSchema } from '@axiom/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Run } from './run-repository.js';
import type { RunStep } from './run-step-repository.js';

export const finalizationResultKinds = [
  'completed', 'unsupported_tool_request', 'invalid_decision', 'decision_source_error',
  'decision_limit_exceeded', 'tool_failed', 'tool_request_rejected', 'tool_execution_limit_exceeded',
] as const;
export type FinalizationResultKind = typeof finalizationResultKinds[number];
export interface FinalizedRun { run: Run; step: RunStep }

interface FinalizationDatabase {
  // Lease an exclusive idle connection, never a shared/in-flight transaction.
  connect(): Promise<Pick<PoolClient, 'query' | 'release'>>;
}
interface RunRow extends QueryResultRow {
  id: string; task: string; status: string; created_at: Date;
}
interface StepRow extends QueryResultRow {
  run_id: string; step_no: number; result_kind: string; created_at: Date;
}

export function createAtomicRunFinalizer(db: FinalizationDatabase) {
  async function finalize(runId: string, resultKind: FinalizationResultKind, credentials?: LeaseWriteCredentials): Promise<FinalizedRun | null> {
    if (!runIdSchema.safeParse(runId).success ||
        !finalizationResultKinds.some(kind => kind === resultKind)) {
      throw new InvalidRunInputError('Invalid Run ID or finalization result kind');
    }
    const status = resultKind === 'completed' ? 'completed' : 'failed';
    const client = await db.connect();
    let discard = false;
    let committing = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // Never update before the fresh post-lock Lease existence check.
      if (!await lockWriteParent(client, runId, credentials !== undefined)) {
        committing = true; await client.query('COMMIT'); return null;
      }
      const updated = await client.query<RunRow>(
        credentials ? `${leaseWriteGuard}
         UPDATE runs SET status = $4 WHERE id = $1 AND status = 'running'
           AND EXISTS (SELECT 1 FROM lease_write_guard)
         RETURNING id, task, status, created_at` :
         `UPDATE runs SET status = $2 WHERE id = $1 AND status = 'running'
         RETURNING id, task, status, created_at`, credentials ? [runId, credentials.ownerId, credentials.leaseToken, status] : [runId, status],
      );
      const row = updated.rows[0];
      let result: FinalizedRun | null = null;
      if (row) {
        // Separate statement after acquiring the lock observes preceding appends.
        const inserted = await client.query<StepRow>(
          `INSERT INTO run_steps (run_id, step_no, result_kind)
           SELECT $1, COALESCE(MAX(step_no), 0) + 1, $2 FROM run_steps WHERE run_id = $1
           RETURNING run_id, step_no, result_kind, created_at`, [runId, resultKind],
        );
        const step = inserted.rows[0];
        if (row.id !== runId.toLowerCase() || typeof row.task !== 'string' ||
            !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime()) ||
            row.status !== status || !runOutcomeSchema.safeParse(row.status).success ||
            !step || step.run_id !== runId.toLowerCase() || step.result_kind !== resultKind || !Number.isInteger(step.step_no) ||
            step.step_no < 1 || !(step.created_at instanceof Date) || !Number.isFinite(step.created_at.getTime())) {
          throw new Error('Unexpected persisted finalization');
        }
        result = {
          run: { id: row.id, task: row.task, status, createdAt: row.created_at },
          step: { runId: step.run_id, stepNo: step.step_no, resultKind, createdAt: step.created_at },
        };
      }
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // Even if ROLLBACK succeeds, a failed COMMIT response may be ambiguous.
      // Conservatively discard every COMMIT-failure connection; never retry.
      discard = committing;
      try { await client.query('ROLLBACK'); }
      catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }
  return {
    async tryFinalizeWithStep(runId: string, resultKind: FinalizationResultKind): Promise<FinalizedRun | null> {
      return finalize(runId, resultKind);
    },
    async tryFinalizeWithStepWithLease(runId: string, resultKind: FinalizationResultKind, credentials: LeaseWriteCredentials): Promise<FinalizedRun | null> {
      runId = leaseWriteId(runId); const captured = captureLeaseCredentials(credentials);
      return finalize(runId, resultKind, captured);
    },
  };
}
