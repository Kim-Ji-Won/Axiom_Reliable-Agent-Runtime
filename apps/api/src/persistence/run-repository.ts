import { InvalidRunInputError, validateTask, runIdSchema, runOutcomeSchema, runStatusSchema } from '@axiom/contracts';
export { InvalidRunInputError, validateTask } from '@axiom/contracts';
import type { RunStatus, RunOutcome } from '@axiom/contracts';
import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

export interface Run {
  id: string;
  task: string;
  status: RunStatus;
  createdAt: Date;
}

interface RunRow extends QueryResultRow {
  id: string;
  task: string;
  status: string;
  created_at: Date;
}

function toRun(row: RunRow): Run {
  const status = runStatusSchema.safeParse(row.status);
  if (!status.success) throw new Error('Unexpected persisted run status');
  return { id: row.id, task: row.task, status: status.data, createdAt: row.created_at };
}

export function createRunRepository(db: Pick<Pool, 'query'>) {
  return {
    async createRun(task: string): Promise<Run> {
      validateTask(task);
      // A single INSERT is atomic. No multi-statement transaction is needed here.
      const result = await db.query<RunRow>(
        `INSERT INTO runs (id, task, status) VALUES ($1, $2, 'queued')
         RETURNING id, task, status, created_at`,
        [randomUUID(), task],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Run insert returned no row');
      return toRun(row);
    },
    async tryStartRun(id: string): Promise<Run | null> {
      if (!runIdSchema.safeParse(id).success) {
        throw new InvalidRunInputError('Run ID must be a UUID');
      }
      // Query-only Pool/PoolClient API. Claim alone creates a Lease together with
      // queued -> running; no supported attach/delete/requeue exists. A Claim
      // that wins the row lock breaks this UPDATE's rechecked queued condition.
      // Do not generalize this exception to arbitrary Step writes or reclaim.
      const result = await db.query<RunRow>(
        `UPDATE runs SET status = 'running'
         WHERE id = $1 AND status = 'queued'
           AND NOT EXISTS (SELECT 1 FROM run_execution_leases WHERE run_id = runs.id)
         RETURNING id, task, status, created_at`, [id],
      );
      return result.rows[0] ? toRun(result.rows[0]) : null;
    },
    async tryFinishRun(id: string, outcome: RunOutcome): Promise<Run | null> {
      if (!runIdSchema.safeParse(id).success || !runOutcomeSchema.safeParse(outcome).success) {
        throw new InvalidRunInputError('Invalid Run ID or outcome');
      }
      // A snapshot-queued Run cannot finish; a legacy-running Run cannot gain
      // a Lease through supported APIs. Existing Lease rows always deny this path.
      const result = await db.query<RunRow>(
        `UPDATE runs SET status = $2
         WHERE id = $1 AND status = 'running'
           AND NOT EXISTS (SELECT 1 FROM run_execution_leases WHERE run_id = runs.id)
         RETURNING id, task, status, created_at`, [id, outcome],
      );
      return result.rows[0] ? toRun(result.rows[0]) : null;
    },
    async findRunById(id: string): Promise<Run | null> {
      if (!runIdSchema.safeParse(id).success) {
        throw new InvalidRunInputError('Run ID must be a UUID');
      }
      const result = await db.query<RunRow>(
        'SELECT id, task, status, created_at FROM runs WHERE id = $1', [id],
      );
      return result.rows[0] ? toRun(result.rows[0]) : null;
    },
  };
}
