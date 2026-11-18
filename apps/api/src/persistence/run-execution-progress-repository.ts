import { types } from 'node:util';
import { InvalidRunInputError, runStatusSchema, type RunStatus } from '@axiom/contracts';
import type { PoolClient } from 'pg';
import { captureLeaseCredentials, leaseWriteId, lockWriteParent, leaseWriteGuard, type LeaseWriteCredentials } from './lease-write-guard.js';

interface Database { connect(): Promise<Pick<PoolClient, 'query' | 'release'>> }
export interface ProgressBudgets { readonly maxDecisions: number; readonly maxToolAttempts: number }
export interface StepConfirmation { readonly expectedVersion: number; readonly stepNo: number }
export interface RunExecutionProgress extends ProgressBudgets {
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly checkpointVersion: number;
  readonly lastConfirmedStepNo: number | null;
  readonly decisionsReserved: number;
  readonly toolAttemptsReserved: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ProgressSnapshot extends RunExecutionProgress {
  readonly runStatus: RunStatus;
  readonly leaseState: 'missing' | 'run_not_running' | 'invalid_clock' | 'expired' | 'active';
  readonly maxStepNo: number | null;
  readonly diagnostic: 'aligned' | 'steps_ahead' | 'inconsistent';
}
const intMax = 2147483647;
function invalid(): never { throw new InvalidRunInputError('Invalid execution progress input'); }
function integer(raw: unknown, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) return invalid();
  return raw;
}
function own(raw: unknown, keys: readonly string[], exact = true): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
  if (exact && Reflect.ownKeys(raw).length !== keys.length) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid();
    result[key] = d.value;
  }
  return result;
}
// No Date objects escape; these fixed UTC strings preserve PostgreSQL microseconds.
function timestamp(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(raw) ||
      !Number.isFinite(Date.parse(raw)) || new Date(Date.parse(raw)).toISOString() !== raw.slice(0, 23) + 'Z') throw new Error();
  return raw;
}
const columns = ['run_id', 'schema_version', 'checkpoint_version', 'last_confirmed_step_no',
  'max_decisions', 'decisions_reserved', 'max_tool_attempts', 'tool_attempts_reserved', 'created_at', 'updated_at'];
const returning = `p.run_id, p.schema_version, p.checkpoint_version, p.last_confirmed_step_no,
  p.max_decisions, p.decisions_reserved, p.max_tool_attempts, p.tool_attempts_reserved,
  to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;
function decode(raw: unknown, runId: string): RunExecutionProgress {
  try {
    const v = own(raw, columns, false);
    if (v.run_id !== runId || v.schema_version !== 1) throw new Error();
    const maxDecisions = integer(v.max_decisions, 1, 5);
    const decisionsReserved = integer(v.decisions_reserved, 0, maxDecisions);
    const maxToolAttempts = integer(v.max_tool_attempts, 0, 1);
    const createdAt = timestamp(v.created_at); const updatedAt = timestamp(v.updated_at);
    if (updatedAt < createdAt) throw new Error();
    return Object.freeze({ runId, schemaVersion: 1, checkpointVersion: integer(v.checkpoint_version, 0, intMax),
      lastConfirmedStepNo: v.last_confirmed_step_no === null ? null : integer(v.last_confirmed_step_no, 1, intMax),
      maxDecisions, decisionsReserved, maxToolAttempts,
      toolAttemptsReserved: integer(v.tool_attempts_reserved, 0, Math.min(maxToolAttempts, decisionsReserved)), createdAt, updatedAt });
  } catch { throw new Error('Invalid persisted execution progress'); }
}
const initializeSql = `${leaseWriteGuard}
  INSERT INTO run_execution_progress AS p
    (run_id, schema_version, checkpoint_version, last_confirmed_step_no, max_decisions,
     decisions_reserved, max_tool_attempts, tool_attempts_reserved, created_at, updated_at)
  SELECT g.run_id, 1, 0, NULL, $4, 0, $5, 0, t, t
  FROM lease_write_guard g CROSS JOIN lease_write_tick
  WHERE NOT EXISTS (SELECT 1 FROM run_execution_progress WHERE run_id = g.run_id)
    AND NOT EXISTS (SELECT 1 FROM run_steps WHERE run_id = g.run_id)
    AND NOT EXISTS (SELECT 1 FROM run_tool_results WHERE run_id = g.run_id)
  RETURNING ${returning}`;
const assignments = {
  decision: 'decisions_reserved = p.decisions_reserved + 1',
  tool: 'tool_attempts_reserved = p.tool_attempts_reserved + 1',
  confirm: 'last_confirmed_step_no = $5',
} as const;
const conditions = {
  decision: 'p.decisions_reserved < p.max_decisions',
  tool: 'p.tool_attempts_reserved < p.max_tool_attempts AND p.tool_attempts_reserved < p.decisions_reserved',
  // bigint prevents overflow in the contiguous watermark check itself.
  confirm: `($5::bigint = COALESCE(p.last_confirmed_step_no::bigint, 0) + 1)
    AND EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id = p.run_id AND s.step_no = $5
      AND s.result_kind IN ('continued', 'tool_succeeded'))`,
} as const;
type Mutation = keyof typeof assignments;
function updateSql(mode: Mutation): string {
  return `${leaseWriteGuard}
    UPDATE run_execution_progress p SET ${assignments[mode]},
      checkpoint_version = p.checkpoint_version + 1, updated_at = t
    FROM lease_write_guard g CROSS JOIN lease_write_tick
    WHERE p.run_id = g.run_id AND p.checkpoint_version = $4 AND p.checkpoint_version < 2147483647
      AND t >= p.updated_at AND ${conditions[mode]}
    RETURNING ${returning}`;
}
// Trusted internal repository. No callback/HTTP/Model/Tool inside the transaction.
// Step COMMIT and acknowledgement COMMIT remain separate; this is NOT a resume API.
export function createRunExecutionProgressRepository(db: Database) {
  async function write(runId: string, credentials: LeaseWriteCredentials, sql: string, extra: number[]) {
    const client = await db.connect(); let committing = false; let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      let progress: RunExecutionProgress | null = null;
      if (await lockWriteParent(client, runId, true)) {
        // Parent lock serializes the absent-row initialization case as well.
        await client.query('SELECT run_id FROM run_execution_progress WHERE run_id = $1 FOR UPDATE', [runId]);
        // All locks have completed. First DML samples the single authorization clock.
        const result = await client.query(sql, [runId, credentials.ownerId, credentials.leaseToken, ...extra]);
        if (result.rows.length > 1) throw new Error('Invalid persisted execution progress');
        if (result.rows.length) progress = decode(result.rows[0], runId);
      }
      committing = true; await client.query('COMMIT'); return progress;
    } catch (error) {
      discard = committing;
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error; // Internal DB errors reject, with no log, public response, or retry.
    } finally { client.release(discard); }
  }
  return {
    async initializeProgress(runId: string, credentials: LeaseWriteCredentials, budgets: ProgressBudgets): Promise<RunExecutionProgress | null> {
      runId = leaseWriteId(runId); const captured = captureLeaseCredentials(credentials);
      const b = own(budgets, ['maxDecisions', 'maxToolAttempts']);
      return write(runId, captured, initializeSql, [integer(b.maxDecisions, 1, 5), integer(b.maxToolAttempts, 0, 1)]);
    },
    async tryReserveDecision(runId: string, credentials: LeaseWriteCredentials, expectedVersion: number): Promise<RunExecutionProgress | null> {
      runId = leaseWriteId(runId); const captured = captureLeaseCredentials(credentials);
      return write(runId, captured, updateSql('decision'), [integer(expectedVersion, 0, intMax)]);
    },
    async tryReserveToolAttempt(runId: string, credentials: LeaseWriteCredentials, expectedVersion: number): Promise<RunExecutionProgress | null> {
      runId = leaseWriteId(runId); const captured = captureLeaseCredentials(credentials);
      return write(runId, captured, updateSql('tool'), [integer(expectedVersion, 0, intMax)]);
    },
    async tryConfirmCommittedStep(runId: string, credentials: LeaseWriteCredentials, confirmation: StepConfirmation): Promise<RunExecutionProgress | null> {
      runId = leaseWriteId(runId); const captured = captureLeaseCredentials(credentials);
      const c = own(confirmation, ['expectedVersion', 'stepNo']);
      return write(runId, captured, updateSql('confirm'), [integer(c.expectedVersion, 0, intMax), integer(c.stepNo, 1, intMax)]);
    },
    async getProgressSnapshot(runId: string): Promise<ProgressSnapshot | null> {
      runId = leaseWriteId(runId); const client = await db.connect(); let discard = false;
      try {
        // Single statement/MVCC snapshot. Neither task, owner nor token is selected.
        const result = await client.query(`/* progress snapshot */
          WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS t)
          SELECT ${returning}, r.status AS run_status,
            CASE WHEN l.run_id IS NULL THEN 'missing'
              WHEN r.status <> 'running' THEN 'run_not_running'
              WHEN NOT (isfinite(l.acquired_at) AND isfinite(l.renewed_at) AND isfinite(l.expires_at)
                AND l.lease_seconds BETWEEN 1 AND 300 AND l.renewed_at >= l.acquired_at
                AND l.expires_at = l.renewed_at + l.lease_seconds * INTERVAL '1 second')
                OR l.renewed_at > t THEN 'invalid_clock'
              WHEN l.expires_at <= t THEN 'expired' ELSE 'active' END AS lease_state,
            s.max_step_no,
            CASE WHEN s.n <> COALESCE(s.max_step_no, 0)
                OR COALESCE(p.last_confirmed_step_no, 0) > COALESCE(s.max_step_no, 0)
                OR (p.last_confirmed_step_no IS NOT NULL AND NOT EXISTS
                  (SELECT 1 FROM run_steps a WHERE a.run_id = p.run_id AND a.step_no = p.last_confirmed_step_no
                    AND a.result_kind IN ('continued', 'tool_succeeded'))) THEN 'inconsistent'
              WHEN COALESCE(s.max_step_no, 0) > COALESCE(p.last_confirmed_step_no, 0) THEN 'steps_ahead'
              ELSE 'aligned' END AS diagnostic
          FROM runs r JOIN run_execution_progress p ON p.run_id = r.id
          LEFT JOIN run_execution_leases l ON l.run_id = p.run_id CROSS JOIN tick
          CROSS JOIN LATERAL (SELECT MAX(step_no) AS max_step_no, COUNT(*) AS n FROM run_steps WHERE run_id = p.run_id) s
          WHERE p.run_id = $1`, [runId]);
        if (!result.rows.length) return null;
        if (result.rows.length !== 1) throw new Error('Invalid persisted execution progress');
        const progress = decode(result.rows[0], runId);
        try {
          const v = own(result.rows[0], ['run_status', 'lease_state', 'max_step_no', 'diagnostic'], false);
          const status = runStatusSchema.safeParse(v.run_status);
          if (!status.success || !['missing', 'run_not_running', 'invalid_clock', 'expired', 'active'].includes(v.lease_state as string) ||
              !['aligned', 'steps_ahead', 'inconsistent'].includes(v.diagnostic as string)) throw new Error();
          return Object.freeze({ ...progress, runStatus: status.data, leaseState: v.lease_state as ProgressSnapshot['leaseState'],
            maxStepNo: v.max_step_no === null ? null : integer(v.max_step_no, 1, intMax), diagnostic: v.diagnostic as ProgressSnapshot['diagnostic'] });
        } catch { throw new Error('Invalid persisted execution progress'); }
      } catch (error) { discard = true; throw error; }
      finally { client.release(discard); }
    },
  };
}
