import { parseModelDecision } from '@axiom/contracts';
import { snapshotToolArguments, type ToolArgumentsSnapshot } from './tool-arguments-snapshot.js';
import type { ToolRegistry } from './tool-registry.js';

export type ToolRequestResolution =
  | { readonly kind: 'validated_tool_request'; readonly toolName: string; readonly arguments: ToolArgumentsSnapshot }
  | { readonly kind: 'not_tool_request' }
  | { readonly kind: 'unknown_tool' }
  | { readonly kind: 'invalid_tool_arguments' }
  | { readonly kind: 'invalid_model_decision' };

// Registry/schema definitions are trusted. Model data is always revalidated.
// A validated request is not execution authorization; there is no executor here.
export function resolveToolRequest(registry: ToolRegistry, raw: unknown): ToolRequestResolution {
  let decision;
  try { decision = parseModelDecision(raw); }
  catch { return { kind: 'invalid_model_decision' }; }
  if (decision.kind !== 'tool_request') return { kind: 'not_tool_request' };
  const tool = registry.lookup(decision.toolName);
  if (!tool) return { kind: 'unknown_tool' };
  try {
    const snapshot = snapshotToolArguments(decision.arguments);
    if (!registry.accepts(tool.name, snapshot)) return { kind: 'invalid_tool_arguments' };
    return Object.freeze({ kind: 'validated_tool_request', toolName: tool.name, arguments: snapshot });
  } catch { return { kind: 'invalid_tool_arguments' }; }
}
