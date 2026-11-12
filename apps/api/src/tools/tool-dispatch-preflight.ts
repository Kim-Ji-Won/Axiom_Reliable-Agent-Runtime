import { runIdSchema } from '@axiom/contracts';
import { resolveToolRequest, type ToolRequestResolution } from './tool-request-resolver.js';
import type { ToolArgumentsSnapshot } from './tool-arguments-snapshot.js';
import type { ToolRegistry } from './tool-registry.js';

export interface PendingToolDispatch {
  readonly kind: 'pending_authorization';
  readonly runId: string;
  readonly toolName: string;
  readonly arguments: ToolArgumentsSnapshot;
}
export type ToolDispatchPreflightResult = PendingToolDispatch
  | { readonly kind: 'invalid_run_id' }
  | Exclude<ToolRequestResolution, { kind: 'validated_tool_request' }>;

// A plan is data, not an unforgeable capability or execution authorization.
// UUID validation does not establish Run existence/state, approval or a lease.
export function prepareToolDispatch(
  registry: ToolRegistry, runId: unknown, rawDecision: unknown,
): ToolDispatchPreflightResult {
  // Reject objects before Zod can inspect them for error reporting/coercion.
  if (typeof runId !== 'string' || !runIdSchema.safeParse(runId).success) {
    return { kind: 'invalid_run_id' };
  }
  const resolution = resolveToolRequest(registry, rawDecision);
  if (resolution.kind !== 'validated_tool_request') return { kind: resolution.kind };
  return Object.freeze({
    kind: 'pending_authorization', runId, toolName: resolution.toolName,
    arguments: resolution.arguments,
  });
}
