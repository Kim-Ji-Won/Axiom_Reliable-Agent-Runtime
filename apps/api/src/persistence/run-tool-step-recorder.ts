import { captureLeaseCredentials, leaseWriteId, lockWriteParent, leaseWriteGuard, type LeaseWriteCredentials } from './lease-write-guard.js';
import { InvalidRunInputError, runIdSchema } from '@axiom/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { RunStep } from './run-step-repository.js';

interface ToolStepDatabase {
  // Lease an exclusive idle connection; its lifetime ends at release, not pool.end.
  connect(): Promise<Pick<PoolClient, 'query' | 'release'>>;
}
interface StepRow extends QueryResultRow {
  run_id: string; step_no: number; result_kind: string; created_at: Date;
}

export function createRunToolStepRecorder(db: ToolStepDatabase) {
  async function append(runId: string, credentials?: LeaseWriteCredentials): Promise<RunStep | null> {
    if (!runIdSchema.safeParse(runId).success) throw new InvalidRunInputError('Invalid Run ID');
    const client = await db.connect();
    let committing = false;
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // Same parent lock as append/finalization/direct finish, held through COMMIT.
      const allowed = await lockWriteParent(client, runId, credentials !== undefined);
      let step: RunStep | null = null;
      if (allowed) {
        const inserted = await client.query<StepRow>(
          credentials ? `${leaseWriteGuard}
           INSERT INTO run_steps (run_id, step_no, result_kind)
           SELECT g.run_id, n.step_no, 'tool_succeeded' FROM lease_write_guard g
           CROSS JOIN LATERAL (SELECT COALESCE(MAX(step_no), 0) + 1 AS step_no FROM run_steps WHERE run_id = g.run_id) n
           RETURNING run_id, step_no, result_kind, created_at` :
           `INSERT INTO run_steps (run_id, step_no, result_kind)
           SELECT $1, COALESCE(MAX(step_no), 0) + 1, 'tool_succeeded' FROM run_steps WHERE run_id = $1
           RETURNING run_id, step_no, result_kind, created_at`, credentials ? [runId, credentials.ownerId, credentials.leaseToken] : [runId],
        );
        const row = inserted.rows[0];
        if (!row && credentials && inserted.rows.length === 0) {
          committing = true; await client.query('COMMIT'); return null;
        }
        if (!row || row.run_id !== runId || row.result_kind !== 'tool_succeeded' ||
            !Number.isInteger(row.step_no) || row.step_no < 1 || !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())) {
          throw new Error('Unexpected persisted tool Step');
        }
        step = { runId: row.run_id, stepNo: row.step_no, resultKind: 'tool_succeeded', createdAt: row.created_at };
      }
      committing = true;
      await client.query('COMMIT');
      return step;
    } catch (error) {
      discard = committing;
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }
  return {
    async appendToolSucceededStepIfRunning(runId: string): Promise<RunStep | null> { return append(runId); },
    async appendToolSucceededStepWithLease(runId: string, credentials: LeaseWriteCredentials): Promise<RunStep | null> {
      runId = leaseWriteId(runId); const captured = captureLeaseCredentials(credentials);
      return append(runId, captured);
    },
  };
}
