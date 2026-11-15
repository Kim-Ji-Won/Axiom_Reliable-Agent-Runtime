import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { InvalidRunInputError, runIdSchema, runStatusSchema } from '@axiom/contracts';
import type { PoolClient } from 'pg';

interface Database { connect(): Promise<Pick<PoolClient, 'query' | 'release'>> }
export interface LeaseMetadata {
  readonly runId: string;
  readonly ownerId: string;
  readonly leaseSeconds: number;
  // UTC strings retain PostgreSQL microseconds; information, never write authority.
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}
export interface LeaseHandle extends LeaseMetadata { readonly leaseToken: string }
export interface LeaseSnapshot extends LeaseMetadata {
  readonly state: 'active' | 'expired' | 'run_not_running';
}
export interface ClaimLeaseOptions { readonly ownerId: string; readonly leaseSeconds: number }
export interface RenewLeaseOptions { readonly ownerId: string; readonly leaseToken: string }

function invalidInput(): never { throw new InvalidRunInputError('Invalid execution lease input'); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !runIdSchema.safeParse(value).success) return invalidInput();
  return value.toLowerCase();
}
function ownValues(raw: unknown, keys: readonly string[], exact = false): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) || Array.isArray(raw)) throw new Error();
  if (exact && (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null ||
      Reflect.ownKeys(raw).length !== keys.length)) throw new Error();
  const values: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw new Error();
    values[key] = d.value;
  }
  return values;
}
function options(raw: unknown, renewal: boolean) {
  try {
    const v = ownValues(raw, renewal ? ['ownerId', 'leaseToken'] : ['ownerId', 'leaseSeconds'], true);
    const ownerId = uuid(v.ownerId);
    if (renewal) return { ownerId, leaseToken: uuid(v.leaseToken), leaseSeconds: undefined };
    if (typeof v.leaseSeconds !== 'number' || !Number.isInteger(v.leaseSeconds) || v.leaseSeconds < 1 || v.leaseSeconds > 300) return invalidInput();
    return { ownerId, leaseSeconds: v.leaseSeconds, leaseToken: undefined };
  } catch { return invalidInput(); }
}
// SQL checks the original precision. No JS Date round trip participates in writes.
const metadata = `run_id, owner_id, lease_seconds,
  to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS acquired_at,
  to_char(renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS renewed_at,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
  (isfinite(acquired_at) AND isfinite(renewed_at) AND isfinite(expires_at)
    AND renewed_at >= acquired_at AND lease_seconds BETWEEN 1 AND 300
    AND expires_at = renewed_at + lease_seconds * INTERVAL '1 second') AS time_valid`;
const fields = ['run_id', 'owner_id', 'lease_seconds', 'acquired_at', 'renewed_at', 'expires_at', 'time_valid'];
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value.slice(0, 23) + 'Z') throw new Error();
  return value;
}
function decode(raw: unknown, runId: string, expected?: { ownerId: string; leaseToken: string; leaseSeconds?: number }): LeaseHandle | LeaseSnapshot {
  try {
    const v = ownValues(raw, [...fields, expected ? 'lease_token' : 'state']);
    if (uuid(v.run_id) !== runId || v.run_id !== runId || v.time_valid !== true ||
        typeof v.lease_seconds !== 'number' || !Number.isInteger(v.lease_seconds) || v.lease_seconds < 1 || v.lease_seconds > 300) throw new Error();
    const ownerId = uuid(v.owner_id);
    const result: LeaseMetadata = { runId, ownerId, leaseSeconds: v.lease_seconds,
      acquiredAt: time(v.acquired_at), renewedAt: time(v.renewed_at), expiresAt: time(v.expires_at) };
    // Fixed-width UTC strings preserve microseconds for defensive row validation.
    if (result.renewedAt < result.acquiredAt || result.expiresAt <= result.renewedAt) throw new Error();
    if (expected) {
      if (ownerId !== expected.ownerId || uuid(v.lease_token) !== expected.leaseToken ||
          expected.leaseSeconds !== undefined && result.leaseSeconds !== expected.leaseSeconds) throw new Error();
      return Object.freeze({ ...result, leaseToken: expected.leaseToken });
    }
    if (v.state !== 'active' && v.state !== 'expired' && v.state !== 'run_not_running') throw new Error();
    return Object.freeze({ ...result, state: v.state });
  } catch { throw new Error('Invalid persisted execution lease'); }
}
function parentStatus(rows: unknown[]): string | null {
  if (!rows.length) return null;
  try {
    if (rows.length !== 1) throw new Error();
    const { status } = ownValues(rows[0], ['status']);
    if (typeof status !== 'string' || !runStatusSchema.safeParse(status).success) throw new Error();
    return status;
  } catch { throw new Error('Invalid persisted lease parent'); }
}
async function transaction<T>(db: Database, work: (client: Pick<PoolClient, 'query'>) => Promise<T>): Promise<T> {
  const client = await db.connect(); let committing = false; let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await work(client);
    committing = true;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    discard = committing;
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error; // Trusted internal caller only; no logging, public mapping or retry.
  } finally { client.release(discard); }
}

// No execution authorization, reclaim, heartbeat, recovery or Runtime integration.
export function createRunExecutionLeaseRepository(db: Database) {
  return {
    async tryClaimRunLease(runId: string, input: ClaimLeaseOptions): Promise<LeaseHandle | null> {
      runId = uuid(runId); const { ownerId, leaseSeconds } = options(input, false);
      return transaction(db, async client => {
        const parent = await client.query('SELECT status FROM runs WHERE id = $1 FOR UPDATE', [runId]);
        if (parentStatus(parent.rows) !== 'queued') return null;
        const existing = await client.query('SELECT run_id FROM run_execution_leases WHERE run_id = $1 FOR UPDATE', [runId]);
        if (existing.rows.length) return null;
        const leaseToken = randomUUID();
        // Separate statements above completed BOTH locks before this single clock sample.
        // Run UPDATE and Lease INSERT share one transaction, not legacy tryStartRun().
        const result = await client.query(`/* lease claim */
          WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS t),
          started AS (UPDATE runs SET status = 'running' FROM tick
            WHERE id = $1 AND status = 'queued' RETURNING id)
          INSERT INTO run_execution_leases
            (run_id, owner_id, lease_token, lease_seconds, acquired_at, renewed_at, expires_at)
          SELECT started.id, $2, $3, $4, tick.t, tick.t, tick.t + $4::integer * INTERVAL '1 second'
          FROM started CROSS JOIN tick
          RETURNING ${metadata}, lease_token`, [runId, ownerId, leaseToken, leaseSeconds]);
        if (result.rows.length !== 1) throw new Error('Invalid persisted execution lease');
        const handle = decode(result.rows[0], runId, { ownerId, leaseToken, leaseSeconds: leaseSeconds! }) as LeaseHandle;
        if (handle.acquiredAt !== handle.renewedAt) throw new Error('Invalid persisted execution lease');
        return handle;
      });
    },
    async tryRenewRunLease(runId: string, input: RenewLeaseOptions): Promise<LeaseHandle | null> {
      runId = uuid(runId); const { ownerId, leaseToken } = options(input, true);
      return transaction(db, async client => {
        const parent = await client.query('SELECT status FROM runs WHERE id = $1 FOR UPDATE', [runId]);
        if (parentStatus(parent.rows) !== 'running') return null;
        await client.query('SELECT run_id FROM run_execution_leases WHERE run_id = $1 FOR UPDATE', [runId]);
        // No transaction-start/statement-start timestamp and no JS timestamp parameter.
        const result = await client.query(`/* lease renewal */
          WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS t)
          UPDATE run_execution_leases SET renewed_at = tick.t,
            expires_at = tick.t + lease_seconds * INTERVAL '1 second'
          FROM tick WHERE run_id = $1 AND owner_id = $2 AND lease_token = $3
            AND expires_at > tick.t AND renewed_at <= tick.t
          RETURNING ${metadata}, lease_token`, [runId, ownerId, leaseToken]);
        if (!result.rows.length) return null;
        if (result.rows.length !== 1) throw new Error('Invalid persisted execution lease');
        return decode(result.rows[0], runId, { ownerId, leaseToken: leaseToken! }) as LeaseHandle;
      });
    },
    async getRunLeaseSnapshot(runId: string): Promise<LeaseSnapshot | null> {
      runId = uuid(runId);
      const client = await db.connect(); let discard = false;
      try {
        // One MVCC snapshot, one DB clock sample. Token is never selected.
        const result = await client.query(`/* lease snapshot */
          WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS t)
          SELECT ${metadata}, CASE WHEN r.status <> 'running' THEN 'run_not_running'
            WHEN l.expires_at <= tick.t THEN 'expired' ELSE 'active' END AS state
          FROM runs r JOIN run_execution_leases l ON l.run_id = r.id CROSS JOIN tick
          WHERE r.id = $1`, [runId]);
        if (!result.rows.length) return null;
        if (result.rows.length !== 1) throw new Error('Invalid persisted execution lease');
        return decode(result.rows[0], runId) as LeaseSnapshot;
      } catch (error) { discard = true; throw error; }
      finally { client.release(discard); }
    },
  };
}
