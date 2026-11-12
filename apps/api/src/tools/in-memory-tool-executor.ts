import { types } from 'node:util';
import { parseModelDecision } from '@axiom/contracts';
import { prepareToolDispatch, type PendingToolDispatch, type ToolDispatchPreflightResult } from './tool-dispatch-preflight.js';
import { parseToolExecutionOutcome, type ToolExecutionOutcome, type ToolExecutionFailureCode } from './tool-execution-outcome.js';
import type { ToolArgumentsSnapshot } from './tool-arguments-snapshot.js';
import type { ToolRegistry } from './tool-registry.js';

export interface InMemoryToolHandler {
  readonly name: string;
  readonly handle: (argumentsSnapshot: ToolArgumentsSnapshot) => unknown;
}
export interface InMemoryToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly handlers: readonly InMemoryToolHandler[];
  readonly permitExecution?: (plan: PendingToolDispatch) => boolean;
}
export type InMemoryToolExecutionResult = ToolExecutionOutcome
  | Exclude<ToolDispatchPreflightResult, PendingToolDispatch>;

const nativeThen = Promise.prototype.then;
const ignore = () => undefined;
const failure = (code: ToolExecutionFailureCode): ToolExecutionOutcome =>
  parseToolExecutionOutcome({ kind: 'tool_failed', code });
function outputOutcome(output: unknown): ToolExecutionOutcome {
  try { return parseToolExecutionOutcome({ kind: 'tool_succeeded', output }); }
  catch { return failure('invalid_tool_output'); }
}

// Only trusted host definitions, pure handlers, and ordinary native Promises.
// This is not a sandbox for host code/closures or tampered Promise intrinsics.
export function createInMemoryToolExecutor(options: InMemoryToolExecutorOptions) {
  const { registry, handlers, permitExecution } = options;
  const entries = new Map<string, InMemoryToolHandler['handle']>();
  try {
    for (const definition of handlers) {
      const { name, handle } = definition;
      parseModelDecision({ kind: 'tool_request', toolName: name, arguments: {} });
      if (!registry.lookup(name) || entries.has(name) || typeof handle !== 'function') {
        throw new Error();
      }
      entries.set(name, handle);
    }
  } catch { throw new Error('Invalid in-memory tool handler'); }

  return Object.freeze({
    async execute(runId: unknown, rawDecision: unknown): Promise<InMemoryToolExecutionResult> {
      const plan = prepareToolDispatch(registry, runId, rawDecision);
      if (plan.kind !== 'pending_authorization') return plan;
      try {
        if (typeof permitExecution !== 'function') return failure('execution_unavailable');
        const permit: unknown = permitExecution(plan);
        if (permit !== true) {
          // A mistaken async gate never grants permission. Observe rejection
          // immediately without reading .then on arbitrary objects/thenables.
          if (!types.isProxy(permit) && types.isPromise(permit)) {
            nativeThen.call(permit, ignore, ignore);
          }
          return failure('execution_unavailable');
        }
      } catch { return failure('execution_unavailable'); }

      const handle = entries.get(plan.toolName);
      if (!handle) return failure('execution_unavailable');
      try {
        const output: unknown = handle(plan.arguments);
        // Do not await/resolve raw objects: that would invoke a hostile then
        // getter before the P2-B descriptor guard. Only native Promises settle.
        if (!types.isProxy(output) && types.isPromise(output)) {
          // Both settlement callbacks produce a validated ToolExecutionOutcome.
          return nativeThen.call(output, outputOutcome, () => failure('handler_error')) as Promise<ToolExecutionOutcome>;
        }
        return outputOutcome(output);
      } catch { return failure('handler_error'); }
    },
  });
}
