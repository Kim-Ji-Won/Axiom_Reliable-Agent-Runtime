import { readApprovalTime } from './tool-approval-clock.js';
import { evaluateToolAuthorization } from './tool-authorization-policy.js';
import { readScope, sameScope, type ToolAuthorizationScope } from './tool-authorization-scope.js';
import type { PendingToolDispatch } from './tool-dispatch-preflight.js';

export interface ToolApprovalGrant { readonly kind: 'host_tool_approval_grant' }
type Terminal = 'consumed' | 'revoked' | 'expired' | 'invalidated';
export type ToolApprovalGrantStatus = 'active' | Terminal | 'invalid_grant';

export class InvalidToolApprovalGrantError extends Error {
  constructor() {
    super('Invalid tool approval grant');
    this.name = 'InvalidToolApprovalGrantError';
  }
}

interface Active {
  readonly kind: 'active';
  readonly policy: unknown;
  readonly scope: ToolAuthorizationScope;
  readonly deadline: bigint;
  lastObserved: bigint;
}

type State = Active | { readonly kind: Terminal };
const grants = new WeakMap<object, State>();

function sample(): bigint {
  const now = readApprovalTime();
  if (typeof now !== 'bigint' || now < 0n) throw new InvalidToolApprovalGrantError();
  return now;
}

function observe(grant: object, active: Active): State {
  let kind: Terminal;
  try {
    const now = sample();
    if (now < active.lastObserved) kind = 'invalidated';
    else if (now >= active.deadline) kind = 'expired';
    else {
      active.lastObserved = now;
      return active;
    }
  } catch { kind = 'invalidated'; }
  const terminal = { kind };
  grants.set(grant, terminal);
  return terminal;
}

export function createToolApprovalGrant(policy: unknown, plan: unknown, ttlSeconds: number): ToolApprovalGrant {
  try {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300 ||
        evaluateToolAuthorization(policy, plan).kind !== 'approval_required') throw new InvalidToolApprovalGrantError();
    const { scope } = readScope(plan, 'kind');
    const issuedAt = sample();
    const grant = Object.freeze({ kind: 'host_tool_approval_grant' } as const);
    grants.set(grant, { kind: 'active', policy, scope, lastObserved: issuedAt,
      deadline: issuedAt + BigInt(ttlSeconds) * 1_000_000_000n });
    return grant;
  } catch { throw new InvalidToolApprovalGrantError(); }
}

export function inspectToolApprovalGrant(grant: unknown): Readonly<{ kind: ToolApprovalGrantStatus }> {
  if (grant === null || typeof grant !== 'object') return Object.freeze({ kind: 'invalid_grant' });
  const state = grants.get(grant);
  const kind = state?.kind === 'active' ? observe(grant, state).kind : state?.kind ?? 'invalid_grant';
  return Object.freeze({ kind });
}

export function revokeToolApprovalGrant(grant: unknown): boolean {
  if (grant === null || typeof grant !== 'object') return false;
  const state = grants.get(grant);
  if (state?.kind !== 'active' || observe(grant, state).kind !== 'active') return false;
  grants.set(grant, { kind: 'revoked' });
  return true;
}

export function createToolApprovalPermit(policy: unknown, grant: unknown): (plan: PendingToolDispatch) => boolean {
  return plan => {
    if (grant === null || typeof grant !== 'object') return false;
    const state = grants.get(grant);
    if (state?.kind !== 'active' || state.policy !== policy) return false;
    try {
      if (evaluateToolAuthorization(policy, plan).kind !== 'approval_required' ||
          !sameScope(state.scope, readScope(plan, 'kind').scope) || observe(grant, state).kind !== 'active') return false;
      grants.set(grant, { kind: 'consumed' });
      return true;
    } catch { return false; }
  };
}
