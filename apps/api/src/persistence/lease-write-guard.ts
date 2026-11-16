import { types } from 'node:util';
import { InvalidRunInputError, runIdSchema, runStatusSchema } from '@axiom/contracts';
import type { PoolClient } from 'pg';

export interface LeaseWriteCredentials { readonly ownerId: string; readonly leaseToken: string }
export function leaseWriteId(value: unknown): string {
  if (typeof value !== 'string' || !runIdSchema.safeParse(value).success) throw new InvalidRunInputError('Invalid lease write input');
  return value.toLowerCase();
}
// Capture primitive credentials before the first await, without invoking host accessors.
export function captureLeaseCredentials(raw: unknown): LeaseWriteCredentials {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error();
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 2 || !keys.includes('ownerId') || !keys.includes('leaseToken')) throw new Error();
    const owner = Object.getOwnPropertyDescriptor(raw, 'ownerId');
    const token = Object.getOwnPropertyDescriptor(raw, 'leaseToken');
    if (!owner?.enumerable || !token?.enumerable || !Object.hasOwn(owner, 'value') || !Object.hasOwn(token, 'value')) throw new Error();
    return Object.freeze({ ownerId: leaseWriteId(owner.value), leaseToken: leaseWriteId(token.value) });
  } catch { throw new InvalidRunInputError('Invalid lease write input'); }
}
type Client = Pick<PoolClient, 'query'>;
// Called only AFTER the parent's FOR UPDATE statement has completed. A fresh
// READ COMMITTED statement sees a Lease committed while that lock was waiting.
export async function hasRunLease(client: Client, runId: string): Promise<boolean> {
  const result = await client.query('SELECT run_id FROM run_execution_leases WHERE run_id = $1', [runId]);
  return result.rows.length !== 0;
}
export async function lockWriteParent(client: Client, runId: string, leased: boolean): Promise<boolean> {
  const parent = await client.query('SELECT status FROM runs WHERE id = $1 FOR UPDATE', [runId]);
  if (parent.rows.length === 0) return false;
  if (parent.rows.length !== 1 || typeof parent.rows[0]?.status !== 'string' ||
      !runStatusSchema.safeParse(parent.rows[0].status).success) throw new Error('Invalid persisted write parent');
  if (parent.rows[0].status !== 'running') return false;
  if (!leased) return !await hasRunLease(client, runId);
  await client.query('SELECT run_id FROM run_execution_leases WHERE run_id = $1 FOR UPDATE', [runId]);
  return true;
}
// Internal SQL fragment, not a caller-supplied callback/authorization API.
// Both lock statements finish BEFORE the first DML samples t. Parameters 1..3
// are captured run/owner/token. No Snapshot or JavaScript clock participates.
// The guard remains an OUTER input to step aggregation, so zero guard rows
// cannot turn into an unconditional aggregate INSERT.
export const leaseWriteGuard = `/* lease write guard */
  WITH lease_write_tick AS MATERIALIZED (SELECT clock_timestamp() AS t),
  lease_write_guard AS MATERIALIZED (
    SELECT l.run_id FROM run_execution_leases l JOIN runs r ON r.id = l.run_id
    CROSS JOIN lease_write_tick
    WHERE l.run_id = $1 AND r.status = 'running' AND l.owner_id = $2 AND l.lease_token = $3
      AND l.expires_at > t AND l.renewed_at <= t
      AND isfinite(l.acquired_at) AND isfinite(l.renewed_at) AND isfinite(l.expires_at)
      AND l.lease_seconds BETWEEN 1 AND 300 AND l.renewed_at >= l.acquired_at
      AND l.expires_at = l.renewed_at + l.lease_seconds * INTERVAL '1 second'
  )`;
