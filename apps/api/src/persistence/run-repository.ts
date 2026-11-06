import { InvalidRunInputError, validateTask, runIdSchema } from '@axiom/contracts';
export { InvalidRunInputError, validateTask } from '@axiom/contracts';
import type { RunStatus } from '@axiom/contracts';
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
  if (row.status !== 'queued' && row.status !== 'running') throw new Error('Unexpected persisted run status');
  return { id: row.id, task: row.task, status: row.status, createdAt: row.created_at };
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
      // PostgreSQL rechecks the predicate after waiting on a concurrent updater.
      const result = await db.query<RunRow>(
        `UPDATE runs SET status = 'running'
         WHERE id = $1 AND status = 'queued'
         RETURNING id, task, status, created_at`, [id],
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
