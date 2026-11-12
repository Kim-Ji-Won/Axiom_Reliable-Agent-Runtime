import { InvalidRunInputError, runIdSchema } from '@axiom/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { RunStep } from './run-step-repository.js';

interface ContinueDatabase {
  // Lease an exclusive idle connection; its lifetime ends at release, not pool.end.
  connect(): Promise<Pick<PoolClient, 'query' | 'release'>>;
}
interface StepRow extends QueryResultRow {
  run_id: string; step_no: number; result_kind: string; created_at: Date;
}

export function createRunContinueRecorder(db: ContinueDatabase) {
  return {
    async appendContinuedStepIfRunning(runId: string): Promise<RunStep | null> {
      if (!runIdSchema.safeParse(runId).success) throw new InvalidRunInputError('Invalid Run ID');
      const client = await db.connect();
      let committing = false;
      let discard = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        // Same parent lock as append/finalization/direct finish, held through COMMIT.
        const parent = await client.query('SELECT status FROM runs WHERE id = $1 FOR UPDATE', [runId]);
        let step: RunStep | null = null;
        if (parent.rows[0]?.status === 'running') {
          const inserted = await client.query<StepRow>(
            `INSERT INTO run_steps (run_id, step_no, result_kind)
             SELECT $1, COALESCE(MAX(step_no), 0) + 1, 'continued' FROM run_steps WHERE run_id = $1
             RETURNING run_id, step_no, result_kind, created_at`, [runId],
          );
          const row = inserted.rows[0];
          if (!row || row.run_id !== runId || row.result_kind !== 'continued' ||
              !Number.isInteger(row.step_no) || row.step_no < 1 || !(row.created_at instanceof Date)) {
            throw new Error('Unexpected persisted continued Step');
          }
          step = { runId: row.run_id, stepNo: row.step_no, resultKind: 'continued', createdAt: row.created_at };
        }
        committing = true;
        await client.query('COMMIT');
        return step;
      } catch (error) {
        discard = committing;
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error;
      } finally { client.release(discard); }
    },
  };
}
