import { types } from 'node:util';
import { dataField, readScope, sameScope, type ToolAuthorizationScope } from './tool-authorization-scope.js';
import type { PendingToolDispatch } from './tool-dispatch-preflight.js';

export type ToolAuthorizationEffect = 'allow' | 'deny' | 'approval_required';

export interface ToolAuthorizationRule extends ToolAuthorizationScope {
  readonly effect: ToolAuthorizationEffect;
}

export interface ToolAuthorizationPolicy { readonly kind: 'host_tool_authorization_policy' }

type DenialCode = 'invalid_policy' | 'invalid_request' | 'no_matching_rule' | 'rule_denied';
export type ToolAuthorizationDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'approval_required' }
  | { readonly kind: 'deny'; readonly code: DenialCode };

export class InvalidToolAuthorizationPolicyError extends Error {
  constructor() {
    super('Invalid tool authorization policy');
    this.name = 'InvalidToolAuthorizationPolicyError';
  }
}

const policies = new WeakMap<object, readonly ToolAuthorizationRule[]>();

export function createToolAuthorizationPolicy(rules: readonly ToolAuthorizationRule[] = []): ToolAuthorizationPolicy {
  const captured: ToolAuthorizationRule[] = [];
  try {
    if (types.isProxy(rules) || !Array.isArray(rules) || Object.getPrototypeOf(rules) !== Array.prototype ||
        rules.length > 32 || Reflect.ownKeys(rules).length !== rules.length + 1) throw new InvalidToolAuthorizationPolicyError();
    for (let i = 0; i < rules.length; i++) {
      const { tag: effect, scope } = readScope(dataField(rules, String(i)), 'effect');
      if (effect !== 'allow' && effect !== 'deny' && effect !== 'approval_required') throw new InvalidToolAuthorizationPolicyError();
      if (captured.some(rule => sameScope(rule, scope))) throw new InvalidToolAuthorizationPolicyError();
      captured.push(Object.freeze({ ...scope, effect }));
    }
  } catch {
    throw new InvalidToolAuthorizationPolicyError();
  }
  const policy = Object.freeze({ kind: 'host_tool_authorization_policy' } as const);
  policies.set(policy, Object.freeze(captured));
  return policy;
}

function deny(code: DenialCode): ToolAuthorizationDecision {
  return Object.freeze({ kind: 'deny', code });
}

export function evaluateToolAuthorization(policy: unknown, plan: unknown): ToolAuthorizationDecision {
  const rules = policy !== null && typeof policy === 'object' ? policies.get(policy) : undefined;
  if (!rules) return deny('invalid_policy');
  try {
    const { tag, scope } = readScope(plan, 'kind');
    if (tag !== 'pending_authorization') return deny('invalid_request');
    const rule = rules.find(candidate => sameScope(candidate, scope));
    if (!rule) return deny('no_matching_rule');
    if (rule.effect === 'deny') return deny('rule_denied');
    return Object.freeze({ kind: rule.effect });
  } catch {
    return deny('invalid_request');
  }
}

export function createToolAuthorizationPermit(policy: unknown): (plan: PendingToolDispatch) => boolean {
  return plan => evaluateToolAuthorization(policy, plan).kind === 'allow';
}
