import { InvalidRunInputError, runIdSchema } from '@axiom/contracts';
import type { PoolClient, QueryResultRow } from 'pg';

export const appendRunStepResultKinds = [
  'completed', 'unsupported_tool_request', 'invalid_decision',
  'decision_source_error', 'finalize_conflict',
] as const;
export const runStepResultKinds = [...appendRunStepResultKinds, 'continued', 'decision_limit_exceeded'] as const;
export type AppendRunStepResultKind = typeof appendRunStepResultKinds[number];
export type RunStepResultKind = typeof runStepResultKinds[number];

export interface RunStep {
  runId: string;
  stepNo: number;
  resultKind: RunStepResultKind;
  createdAt: Date;
}

interface StepDatabase {
  // Each call leases an exclusive, idle connection; a pg Pool satisfies this contract.
  connect(): Promise<Pick<PoolClient, 'query' | 'release'>>;
}
interface StepRow extends QueryResultRow {
  run_id: string;
  step_no: number | null;
  result_kind: string | null;
  created_at: Date | null;
}
function validKind(value: unknown): value is RunStepResultKind {
  return typeof value === 'string' && runStepResultKinds.some(kind => kind === value);
}
function validateId(id: unknown): void {
  if (!runIdSchema.safeParse(id).success) throw new InvalidRunInputError('Invalid Run ID');
}
function toStep(row: StepRow): RunStep {
  if (!Number.isInteger(row.step_no) || row.step_no === null || row.step_no < 1 ||
      !validKind(row.result_kind) || !(row.created_at instanceof Date)) {
    throw new Error('Unexpected persisted Run Step');
  }
  return { runId: row.run_id, stepNo: row.step_no, resultKind: row.result_kind, createdAt: row.created_at };
}

export function createRunStepRepository(db: StepDatabase) {
  return {
    async appendRunStep(runId: string, resultKind: AppendRunStepResultKind): Promise<RunStep | null> {
      validateId(runId);
      if (!appendRunStepResultKinds.some(kind => kind === resultKind)) throw new InvalidRunInputError('Invalid Run Step result kind');
      const client = await db.connect();
      let discard = false;
      try {
        // A new statement snapshot after the parent lock observes the previous append.
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const parent = await client.query('SELECT id FROM runs WHERE id = $1 FOR UPDATE', [runId]);
        if (parent.rowCount === 0) {
          await client.query('COMMIT');
          return null;
        }
        const inserted = await client.query<StepRow>(
          `INSERT INTO run_steps (run_id, step_no, result_kind)
           SELECT $1, COALESCE(MAX(step_no), 0) + 1, $2 FROM run_steps WHERE run_id = $1
           RETURNING run_id, step_no, result_kind, created_at`, [runId, resultKind],
        );
        if (!inserted.rows[0]) throw new Error('Run Step insert returned no row');
        const step = toStep(inserted.rows[0]);
        await client.query('COMMIT');
        return step;
      } catch (error) {
        try { await client.query('ROLLBACK'); }
        catch { discard = true; } // Never return a connection with an unknown transaction state.
        throw error;
      } finally { client.release(discard); }
    },
    async listRunSteps(runId: string): Promise<RunStep[] | null> {
      validateId(runId);
      const client = await db.connect();
      let discard = false;
      try {
        // One snapshot distinguishes a missing Run from an existing empty history.
        const result = await client.query<StepRow>(
          `SELECT r.id AS run_id, s.step_no, s.result_kind, s.created_at
           FROM runs r LEFT JOIN run_steps s ON s.run_id = r.id
           WHERE r.id = $1 ORDER BY s.step_no ASC`, [runId],
        );
        if (result.rows.length === 0) return null;
        return result.rows.filter(row => row.step_no !== null).map(toStep);
      } catch (error) {
        discard = true;
        throw error;
      } finally { client.release(discard); }
    },
  };
}
