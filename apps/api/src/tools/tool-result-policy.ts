import { types } from 'node:util';
import { parseModelDecision } from '@axiom/contracts';
import { parseToolExecutionOutcome, type ToolExecutionOutcome } from './tool-execution-outcome.js';

export interface PersistableToolResult {
  readonly schemaVersion: 1;
  readonly status: 'ok' | 'empty';
  readonly itemCount: number;
}
export const maxPersistableResultBytes = 1024;
export class InvalidPersistableResultError extends Error {
  constructor() { super('Invalid persistable tool result'); this.name = 'InvalidPersistableResultError'; }
}
export function parsePersistableToolResult(raw: unknown): PersistableToolResult {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error();
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 3 || !['schemaVersion', 'status', 'itemCount'].every(k => keys.includes(k))) throw new Error();
    const data: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(raw, key)!;
      if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) throw new Error();
      data[key] = d.value;
    }
    if (data.schemaVersion !== 1 || (data.status !== 'ok' && data.status !== 'empty') ||
        typeof data.itemCount !== 'number' || !Number.isInteger(data.itemCount) || data.itemCount < 0 || data.itemCount > 1000) throw new Error();
    const safe = Object.freeze({ schemaVersion: 1 as const, status: data.status, itemCount: data.itemCount });
    if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > maxPersistableResultBytes) throw new Error();
    return safe;
  } catch { throw new InvalidPersistableResultError(); }
}

type Success = Extract<ToolExecutionOutcome, { kind: 'tool_succeeded' }>;
export interface ToolResultPolicyDefinition {
  readonly name: string;
  readonly retentionSeconds: number;
  readonly project: (outcome: Success) => unknown;
}
// Identity is held out of band: a structural cast or model approval flag is not
// a policy. Host modules can create policies; arbitrary host code is trusted.
export interface ToolResultPolicy { readonly kind: 'host_tool_result_policy' }
const policies = new WeakMap<ToolResultPolicy, ReadonlyMap<string, ToolResultPolicyDefinition>>();
const nativeThen = Promise.prototype.then;
const ignore = () => undefined;
export function createToolResultPolicy(definitions: readonly ToolResultPolicyDefinition[] = []): ToolResultPolicy {
  const entries = new Map<string, ToolResultPolicyDefinition>();
  try {
    if (types.isProxy(definitions) || !Array.isArray(definitions)) throw new Error();
    for (let i = 0; i < definitions.length; i++) {
      const element = Object.getOwnPropertyDescriptor(definitions, String(i));
      const def: unknown = element?.value;
      if (!def || typeof def !== 'object' || types.isProxy(def) || ![Object.prototype,null].includes(Object.getPrototypeOf(def))) throw new Error();
      const keys = Reflect.ownKeys(def);
      if (keys.length !== 3 || !['name','project','retentionSeconds'].every(k => keys.includes(k))) throw new Error();
      const values: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(def,key)!;
        if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d,'value')) throw new Error();
        values[key] = d.value;
      }
      const { name, project, retentionSeconds } = values;
      parseModelDecision({ kind: 'tool_request', toolName: name, arguments: {} });
      if (typeof name !== 'string' || entries.has(name) || typeof project !== 'function' || types.isProxy(project) || types.isAsyncFunction(project) ||
          typeof retentionSeconds !== 'number' || !Number.isInteger(retentionSeconds) || retentionSeconds < 1 || retentionSeconds > 86400) throw new Error();
      entries.set(name, Object.freeze({ name, project: project as ToolResultPolicyDefinition['project'], retentionSeconds }));
    }
  } catch { throw new Error('Invalid tool result policy'); }
  const policy = Object.freeze({ kind: 'host_tool_result_policy' as const });
  policies.set(policy, entries);
  return policy;
}

// Internal preparation: only a captured host policy may choose projection/TTL.
// Incoming Outcome and projector output are both independently copied/validated.
export function prepareToolResult(policy: ToolResultPolicy | undefined, toolName: unknown, rawOutcome: unknown) {
  const entry = policy && typeof toolName === 'string' ? policies.get(policy)?.get(toolName) : undefined;
  if (!entry) return null;
  try {
    const outcome = parseToolExecutionOutcome(rawOutcome);
    if (outcome.kind !== 'tool_succeeded') return null;
    const projected = entry.project(outcome);
    if (!types.isProxy(projected) && types.isPromise(projected)) {
      nativeThen.call(projected, ignore, ignore); // Reject async projection, observe native rejection.
      return null;
    }
    return Object.freeze({ safeResult: parsePersistableToolResult(projected), retentionSeconds: entry.retentionSeconds });
  } catch { return null; } // No input, raw error, cause, or Zod issues escape.
}
