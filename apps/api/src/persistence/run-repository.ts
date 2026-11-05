import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

export interface Run {
  id: string;
  task: string;
  status: 'queued';
  createdAt: Date;
}

interface RunRow extends QueryResultRow {
  id: string;
  task: string;
  status: string;
  created_at: Date;
}

export class InvalidRunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRunInputError';
  }
}

export function validateTask(task: unknown): asserts task is string {
  if (typeof task !== 'string' || task.trim().length === 0 ||
      [...task].length > 4000 || task.includes('\0') || /[\uD800-\uDFFF]/u.test(task)) {
    throw new InvalidRunInputError('Task must contain non-whitespace text and at most 4000 Unicode code points');
  }
}

function toRun(row: RunRow): Run {
  if (row.status !== 'queued') throw new Error('Unexpected persisted run status');
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
    async findRunById(id: string): Promise<Run | null> {
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new InvalidRunInputError('Run ID must be a UUID');
      }
      const result = await db.query<RunRow>(
        'SELECT id, task, status, created_at FROM runs WHERE id = $1', [id],
      );
      return result.rows[0] ? toRun(result.rows[0]) : null;
    },
  };
}
