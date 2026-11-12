import { types } from 'node:util';
import { snapshotToolArguments, type ToolArgumentsSnapshot } from './tool-arguments-snapshot.js';

export const toolExecutionFailureCodes = Object.freeze([
  'handler_error', 'invalid_tool_output', 'execution_unavailable',
] as const);
export type ToolExecutionFailureCode = typeof toolExecutionFailureCodes[number];
export type ToolExecutionOutcome =
  | { readonly kind: 'tool_succeeded'; readonly output: ToolArgumentsSnapshot }
  | { readonly kind: 'tool_failed'; readonly code: ToolExecutionFailureCode };

export class InvalidToolExecutionOutcomeError extends Error {
  constructor() {
    super('Invalid tool execution outcome');
    this.name = 'InvalidToolExecutionOutcomeError';
  }
}

// Validate data only. A synthetic outcome is not proof that a tool ran, nor
// permission to execute it. The future trusted Executor must establish provenance.
export function parseToolExecutionOutcome(raw: unknown): ToolExecutionOutcome {
  try {
    if (raw === null || typeof raw !== 'object' || types.isProxy(raw)) {
      throw new InvalidToolExecutionOutcomeError();
    }
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) throw new InvalidToolExecutionOutcomeError();
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 2) throw new InvalidToolExecutionOutcomeError();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new InvalidToolExecutionOutcomeError();
      }
    }
    const kind: unknown = Object.getOwnPropertyDescriptor(raw, 'kind')?.value;
    if (kind === 'tool_succeeded' && keys.includes('output')) {
      const output = snapshotToolArguments(Object.getOwnPropertyDescriptor(raw, 'output')!.value);
      return Object.freeze({ kind, output });
    }
    if (kind === 'tool_failed' && keys.includes('code')) {
      const code: unknown = Object.getOwnPropertyDescriptor(raw, 'code')!.value;
      if (toolExecutionFailureCodes.some(allowed => allowed === code)) {
        return Object.freeze({ kind, code: code as ToolExecutionFailureCode });
      }
    }
    throw new InvalidToolExecutionOutcomeError();
  } catch {
    // Discard all original input/errors/causes; never expose Zod or source data.
    throw new InvalidToolExecutionOutcomeError();
  }
}
