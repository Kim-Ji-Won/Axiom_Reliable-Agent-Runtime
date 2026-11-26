import { types } from 'node:util';
import { InvalidRunInputError, runIdSchema, runStatusSchema } from '@axiom/contracts';
import type { Pool } from 'pg';
import { finalizationResultKinds } from './atomic-run-finalizer.js';
import { runStepResultKinds } from './run-step-repository.js';

const inspectionSql = `
  WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS t)
  SELECT r.id, r.status,
    CASE WHEN l.run_id IS NULL THEN 'absent'
      WHEN NOT (isfinite(l.acquired_at) AND isfinite(l.renewed_at) AND isfinite(l.expires_at)
        AND l.lease_seconds BETWEEN 1 AND 300 AND l.acquired_at <= l.renewed_at
        AND l.renewed_at <= tick.t AND l.expires_at = l.renewed_at + l.lease_seconds * INTERVAL '1 second')
        THEN 'invalid_clock'
      WHEN l.expires_at <= tick.t THEN 'expired' ELSE 'active' END AS lease,
    p.schema_version, p.checkpoint_version, p.max_decisions, p.decisions_reserved,
    p.max_tool_attempts, p.tool_attempts_reserved, p.last_confirmed_step_no,
    (isfinite(p.created_at) AND isfinite(p.updated_at) AND p.created_at <= p.updated_at
      AND p.updated_at <= tick.t AND (l.run_id IS NULL OR
        (p.created_at >= l.acquired_at AND p.updated_at < l.expires_at))) AS progress_clock_ok,
    s.step_count, s.max_step_no, s.terminal_count, s.tool_successes, last.result_kind AS last_kind
  FROM runs r CROSS JOIN tick
  LEFT JOIN run_execution_leases l ON l.run_id = r.id
  LEFT JOIN run_execution_progress p ON p.run_id = r.id
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS step_count, max(step_no) AS max_step_no,
      (count(*) FILTER (WHERE result_kind NOT IN ('continued', 'tool_succeeded')))::int AS terminal_count,
      (count(*) FILTER (WHERE result_kind = 'tool_succeeded'))::int AS tool_successes
    FROM run_steps WHERE run_id = r.id
  ) s
  LEFT JOIN run_steps last ON last.run_id = r.id AND last.step_no = s.max_step_no
  WHERE r.id = $1`;

const progressKeys = ['schema_version', 'checkpoint_version', 'max_decisions', 'decisions_reserved',
  'max_tool_attempts', 'tool_attempts_reserved', 'last_confirmed_step_no', 'progress_clock_ok'];
const columns = ['id', 'status', 'lease', ...progressKeys, 'step_count', 'max_step_no', 'terminal_count', 'tool_successes', 'last_kind'];
const invalidRow = () => new Error('Invalid recovery observation');
function integer(value: unknown, min = 0, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalidRow();
  return value;
}
function progressOf(row: Record<string, unknown>) {
  if (row.schema_version === null) {
    if (!progressKeys.every(key => row[key] === null)) throw invalidRow();
    return null;
  }
  if (row.schema_version !== 1 || typeof row.progress_clock_ok !== 'boolean') throw invalidRow();
  const maxDecisions = integer(row.max_decisions, 1, 5);
  const decisionsReserved = integer(row.decisions_reserved, 0, maxDecisions);
  const maxToolAttempts = integer(row.max_tool_attempts, 0, 1);
  return { maxDecisions, decisionsReserved, maxToolAttempts,
    toolAttemptsReserved: integer(row.tool_attempts_reserved, 0, Math.min(decisionsReserved, maxToolAttempts)),
    checkpointVersion: integer(row.checkpoint_version),
    lastConfirmedStepNo: row.last_confirmed_step_no === null ? null : integer(row.last_confirmed_step_no, 1) };
}
function decode(raw: unknown, id: string) {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== columns.length ||
      !columns.every(key => {
        const d = Object.getOwnPropertyDescriptor(raw, key);
        return d?.enumerable && Object.hasOwn(d, 'value');
      })) throw invalidRow();
  const row = raw as Record<string, unknown>;
  if (row.id !== id || typeof row.status !== 'string') throw invalidRow();
  const status = runStatusSchema.parse(row.status);
  const lease = row.lease;
  if (lease !== 'absent' && lease !== 'invalid_clock' && lease !== 'active' && lease !== 'expired') throw invalidRow();
  const progress = progressOf(row);
  const count = integer(row.step_count);
  const maxStepNo = row.max_step_no === null ? null : integer(row.max_step_no, 1);
  const lastKind = row.last_kind === null ? null : runStepResultKinds.find(kind => kind === row.last_kind);
  const terminals = integer(row.terminal_count, 0, count);
  const toolSuccesses = integer(row.tool_successes, 0, count - terminals);
  if (lastKind === undefined || (count === 0) !== (maxStepNo === null) || (count === 0) !== (lastKind === null) ||
      (lastKind !== null && lastKind !== 'continued' && lastKind !== 'tool_succeeded' && terminals === 0) ||
      (lastKind === 'tool_succeeded' && !toolSuccesses) || (lastKind === 'continued' && count === terminals + toolSuccesses)) throw invalidRow();

  const watermark = progress?.lastConfirmedStepNo ?? 0;
  const nonterminalCount = count - terminals;
  const ambiguousToolAttempt = !!progress && progress.toolAttemptsReserved > toolSuccesses;
  const unconfirmedNonterminalStep = !!progress && nonterminalCount > watermark;
  const terminal = status === 'completed' || status === 'failed';
  const compatibleEnd = terminals === 1 && (status === 'completed' ? lastKind === 'completed' :
    lastKind !== 'completed' && finalizationResultKinds.some(kind => kind === lastKind));
  const inconsistent = (maxStepNo ?? 0) !== count || lease === 'invalid_clock' ||
    (terminal ? !compatibleEnd : terminals !== 0) ||
    (status === 'queued' && (lease !== 'absent' || progress !== null || count !== 0)) ||
    (progress !== null && (lease === 'absent' || !row.progress_clock_ok || watermark > nonterminalCount || toolSuccesses > progress.toolAttemptsReserved ||
      progress.checkpointVersion !== progress.decisionsReserved + progress.toolAttemptsReserved + watermark)) ||
    (status === 'running' && (lease === 'absent' || (!progress && count > 0)));

  function category() {
    if (inconsistent) return 'legacy_or_inconsistent_manual_review' as const;
    if (terminal) return 'terminal_observed' as const;
    if (status === 'queued') return 'queued_observed' as const;
    if (!progress) return 'claimed_without_progress' as const;
    if (ambiguousToolAttempt) return 'ambiguous_attempt_manual_review' as const;
    if (unconfirmedNonterminalStep) return 'unconfirmed_step_manual_review' as const;
    return lease === 'expired' ? 'expired_lease_manual_review' as const : 'active_lease_unverified' as const;
  }
  return { category: category(), status, lease, progress, steps: { count, maxStepNo, lastKind },
    ambiguousToolAttempt, unconfirmedNonterminalStep } as const;
}
export type RecoveryInspection = { category: 'missing_run' } | ReturnType<typeof decode>;

// Pool.query owns checkout/release; a transaction owner may also supply its own client.
export function createRunRecoveryInspectionRepository(db: Pick<Pool, 'query'>) {
  return {
    async inspectRunRecovery(runId: string): Promise<RecoveryInspection> {
      if (typeof runId !== 'string' || runId.length !== 36 || !runIdSchema.safeParse(runId).success) {
        throw new InvalidRunInputError('Invalid recovery Run ID');
      }
      const id = runId.toLowerCase();
      let result;
      try { result = await db.query(inspectionSql, [id]); }
      catch { throw new Error('Recovery inspection query failed'); }
      try {
        if (result.command !== 'SELECT' || !Array.isArray(result.rows) || result.rowCount !== result.rows.length || result.rowCount > 1) throw invalidRow();
        if (result.rowCount === 0) return { category: 'missing_run' };
        return decode(result.rows[0], id);
      } catch { throw invalidRow(); }
    },
  };
}
