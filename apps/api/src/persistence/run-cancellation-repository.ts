import { InvalidRunInputError, runIdSchema, runStatusSchema } from '@axiom/contracts';
import { types } from 'node:util';
import type { PoolClient, QueryResult } from 'pg';

export interface RunCancellationResult {
  readonly kind: 'cancelled';
  readonly runId: string;
  readonly stepNo: number;
}

type Client = Pick<PoolClient, 'query' | 'release'>;
const unexpected = () => new Error('Unexpected persisted cancellation');

// Validate each PostgreSQL projection before reading fields. A missing parent
// is the only successful query in this operation that may have an empty row set.
function readRow(result: QueryResult, command: string, columns: readonly string[], optional = false) {
  if (result?.command !== command || !Array.isArray(result.rows) || result.rowCount !== result.rows.length) throw unexpected();
  if (optional && result.rowCount === 0) return null;
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row || typeof row !== 'object' || types.isProxy(row) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(row)) || Reflect.ownKeys(row).length !== columns.length ||
      !columns.every(key => {
        const field = Object.getOwnPropertyDescriptor(row, key);
        return field?.enumerable && Object.hasOwn(field, 'value');
      })) throw unexpected();
  return row;
}

async function cancelLocked(client: Client, id: string): Promise<RunCancellationResult | null> {
  const parent = readRow(await client.query('SELECT status FROM runs WHERE id = $1 FOR UPDATE', [id]), 'SELECT', ['status'], true);
  if (!parent) return null;
  const status = parent.status;
  if (typeof status !== 'string' || !runStatusSchema.safeParse(status).success) throw unexpected();
  if (status !== 'running' && status !== 'queued') return null;

  // READ COMMITTED now sees Steps written by the previous parent lock holder.
  const history = readRow(await client.query(`
    SELECT count(*)::int AS count, max(step_no) AS maximum,
      (count(*) FILTER (WHERE result_kind NOT IN ('continued', 'tool_succeeded')))::int AS terminals,
      EXISTS (SELECT 1 FROM run_execution_leases WHERE run_id = $1) AS leased,
      EXISTS (SELECT 1 FROM run_execution_progress WHERE run_id = $1) AS progressed
    FROM run_steps WHERE run_id = $1`, [id]), 'SELECT', ['count', 'maximum', 'terminals', 'leased', 'progressed']);
  if (!history) throw unexpected();
  const { count, maximum, terminals, leased, progressed } = history;
  if (!Number.isInteger(count) || count < 0 || count > 2147483647 ||
      !Number.isInteger(terminals) || terminals < 0 || terminals > count ||
      (count === 0 ? maximum !== null : !Number.isInteger(maximum) || maximum < count || maximum > 2147483647) ||
      typeof leased !== 'boolean' || typeof progressed !== 'boolean') throw unexpected();
  // Positive unique step numbers are contiguous exactly when max equals count.
  if ((maximum ?? 0) !== count || terminals !== 0 || (status === 'queued' && (count !== 0 || leased || progressed))) return null;
  if (count === 2147483647) throw unexpected();

  const run = readRow(await client.query(`
    UPDATE runs SET status = 'cancelled' WHERE id = $1 AND status IN ('queued', 'running')
    RETURNING id, status`, [id]), 'UPDATE', ['id', 'status']);
  if (run?.id !== id || run.status !== 'cancelled') throw unexpected();
  const stepNo = count + 1;
  const step = readRow(await client.query(`
    INSERT INTO run_steps (run_id, step_no, result_kind, created_at) VALUES ($1, $2, 'cancelled', clock_timestamp())
    RETURNING run_id, step_no, result_kind, created_at`, [id, stepNo]), 'INSERT', ['run_id', 'step_no', 'result_kind', 'created_at']);
  if (step?.run_id !== id || step.step_no !== stepNo || step.result_kind !== 'cancelled' ||
      !types.isDate(step.created_at) || !Number.isFinite(Date.prototype.getTime.call(step.created_at))) throw unexpected();
  return Object.freeze({ kind: 'cancelled', runId: id, stepNo });
}

export function createRunCancellationRepository(db: { connect(): Promise<Client> }) {
  return {
    async tryCancelRun(runId: string): Promise<RunCancellationResult | null> {
      if (typeof runId !== 'string' || runId.length !== 36 || !runIdSchema.safeParse(runId).success) {
        throw new InvalidRunInputError('Invalid cancellation Run ID');
      }
      const id = runId.toLowerCase();
      const client = await db.connect();
      let committing = false;
      let discard = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const result = await cancelLocked(client, id);
        committing = true;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        discard = committing;
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error;
      } finally { client.release(discard); }
    },
  };
}
