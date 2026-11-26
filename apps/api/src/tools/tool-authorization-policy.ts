import { isDeepStrictEqual, types } from 'node:util';
import { parseModelDecision, runIdSchema } from '@axiom/contracts';
import { snapshotToolArguments, type ToolArgumentsSnapshot } from './tool-arguments-snapshot.js';
import type { PendingToolDispatch } from './tool-dispatch-preflight.js';

export type ToolAuthorizationEffect = 'allow' | 'deny' | 'approval_required';

export interface ToolAuthorizationRule {
  readonly runId: string;
  readonly toolName: string;
  readonly arguments: ToolArgumentsSnapshot;
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

function dataField(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new InvalidToolAuthorizationPolicyError();
  return descriptor.value;
}

type Scope = Omit<ToolAuthorizationRule, 'effect'>;

function readScope(raw: unknown, discriminator: 'effect' | 'kind') {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== 4) {
    throw new InvalidToolAuthorizationPolicyError();
  }
  const tag = dataField(raw, discriminator);
  const runId = dataField(raw, 'runId');
  const toolName = dataField(raw, 'toolName');
  const args = dataField(raw, 'arguments');
  if (typeof runId !== 'string' || runId.length !== 36 || !runIdSchema.safeParse(runId).success ||
      typeof toolName !== 'string') throw new InvalidToolAuthorizationPolicyError();
  parseModelDecision({ kind: 'tool_request', toolName, arguments: {} });
  return { tag, scope: { runId: runId.toLowerCase(), toolName, arguments: snapshotToolArguments(args) } };
}

function sameScope(a: Scope, b: Scope): boolean {
  // Both inputs have independent frozen JSON snapshots with normalized object prototypes.
  return a.runId === b.runId && a.toolName === b.toolName && isDeepStrictEqual(a.arguments, b.arguments);
}

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
