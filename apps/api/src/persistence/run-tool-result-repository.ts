import { types } from 'node:util';
import { InvalidRunInputError, runIdSchema } from '@axiom/contracts';
import type { PoolClient } from 'pg';
import { parsePersistableToolResult, prepareToolResult, type PersistableToolResult, type ToolResultPolicy } from '../tools/tool-result-policy.js';
import type { RunStep } from './run-step-repository.js';

interface Database { connect(): Promise<Pick<PoolClient, 'query' | 'release'>> }
export interface SavedToolResult {
  readonly runId: string;
  readonly stepNo: number;
  readonly safeResult: PersistableToolResult;
  readonly createdAt: string;
  readonly expiresAt: string;
}
// Keep microsecond precision in PostgreSQL: pg Date decoding truncates to milliseconds.
// This computed field is validation evidence only, never persisted or returned to callers.
const ttlValidation = `(expires_at >= created_at + INTERVAL '1 second'
  AND expires_at <= created_at + INTERVAL '24 hours') AS ttl_valid`;
const noStore = Object.freeze({ kind: 'no_store' as const });
function validateKey(runId: unknown, stepNo?: unknown) {
  if (typeof runId !== 'string' || !runIdSchema.safeParse(runId).success ||
      (stepNo !== undefined && (typeof stepNo !== 'number' || !Number.isInteger(stepNo) || stepNo < 1 || stepNo > 2147483647))) {
    throw new InvalidRunInputError('Invalid tool result key');
  }
}
function decode(raw: unknown, runId: string, stepNo: number): SavedToolResult {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw)) throw new Error();
    const data: Record<string, unknown> = Object.create(null);
    for (const key of ['run_id','step_no','result_kind','schema_version','status','item_count','created_at','expires_at','ttl_valid']) {
      const d = Object.getOwnPropertyDescriptor(raw,key);
      if (!d?.enumerable || !Object.hasOwn(d,'value')) throw new Error();
      data[key] = d.value;
    }
    if (data.run_id !== runId || data.step_no !== stepNo || data.result_kind !== 'tool_succeeded') throw new Error();
    const safeResult = parsePersistableToolResult({ schemaVersion: data.schema_version, status: data.status, itemCount: data.item_count });
    const start = Date.prototype.getTime.call(data.created_at); const end = Date.prototype.getTime.call(data.expires_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || data.ttl_valid !== true || end - start < 1000 || end - start > 86400000) throw new Error();
    return Object.freeze({ runId, stepNo, safeResult, createdAt: new Date(start).toISOString(), expiresAt: new Date(end).toISOString() });
  } catch { throw new Error('Invalid saved tool result'); }
}

// Trusted internal API only. Knowledge of a key is not user/tenant authorization.
// No HTTP, Runtime, Handler execution, background cleanup, or retry integration.
export function createRunToolResultRepository(db: Database, policy?: ToolResultPolicy) {
  return {
    async appendToolSucceededStepWithSafeResultIfRunning(runId: string, toolName: unknown, rawOutcome: unknown): Promise<{ step: RunStep; result: SavedToolResult } | typeof noStore | null> {
      validateKey(runId);
      runId = runId.toLowerCase(); // PostgreSQL returns canonical lowercase UUIDs.
      const prepared = prepareToolResult(policy, toolName, rawOutcome);
      if (!prepared) return noStore; // No connection or Step without host permission.
      const client = await db.connect(); let committing = false; let discard = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const parent = await client.query('SELECT status FROM runs WHERE id = $1 FOR UPDATE', [runId]);
        let saved: { step: RunStep; result: SavedToolResult } | null = null;
        if (parent.rows[0]?.status === 'running') {
          const inserted = await client.query(
            `INSERT INTO run_steps (run_id, step_no, result_kind)
             SELECT $1, COALESCE(MAX(step_no), 0) + 1, 'tool_succeeded' FROM run_steps WHERE run_id = $1
             RETURNING run_id, step_no, result_kind, created_at`, [runId]);
          const row = inserted.rows[0];
          if (!row || row.run_id !== runId || row.result_kind !== 'tool_succeeded' || !Number.isInteger(row.step_no) || row.step_no < 1 ||
              !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())) throw new Error('Invalid saved tool Step');
          const safe = prepared.safeResult;
          const result = await client.query(
            `INSERT INTO run_tool_results (run_id, step_no, schema_version, status, item_count, expires_at)
             VALUES ($1, $2, $3, $4, $5, statement_timestamp() + $6 * INTERVAL '1 second') RETURNING *, ${ttlValidation}`,
            [runId, row.step_no, safe.schemaVersion, safe.status, safe.itemCount, prepared.retentionSeconds]);
          saved = { step: { runId, stepNo: row.step_no, resultKind: 'tool_succeeded', createdAt: new Date(row.created_at) }, result: decode(result.rows[0],runId,row.step_no) };
        }
        committing = true; await client.query('COMMIT'); return saved;
      } catch (error) {
        discard = committing;
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error; // Trusted persistence caller; no automatic logging or model mapping.
      } finally { client.release(discard); }
    },
    async getSavedToolResult(runId: string, stepNo: number): Promise<SavedToolResult | null> {
      validateKey(runId,stepNo);
      runId = runId.toLowerCase();
      // Missing stepNo must also fail before connection acquisition.
      if (stepNo === undefined) throw new InvalidRunInputError('Invalid tool result key');
      const client = await db.connect(); let discard = false;
      try {
        const result = await client.query(`SELECT *, ${ttlValidation} FROM run_tool_results WHERE run_id = $1 AND step_no = $2 AND expires_at > statement_timestamp()`, [runId,stepNo]);
        return result.rows.length ? decode(result.rows[0],runId,stepNo) : null;
      } catch (error) { discard = true; throw error; }
      finally { client.release(discard); }
    },
    async deleteExpiredToolResults(): Promise<number> {
      const client = await db.connect(); let discard = false;
      try {
        const result = await client.query('DELETE FROM run_tool_results WHERE expires_at <= statement_timestamp()');
        return result.rowCount ?? 0;
      } catch (error) { discard = true; throw error; }
      finally { client.release(discard); }
    },
  };
}
