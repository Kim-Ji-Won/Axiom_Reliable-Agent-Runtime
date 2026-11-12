import { parseModelDecision } from '@axiom/contracts';

export type ToolJsonValue = string | number | boolean | null | readonly ToolJsonValue[] | ToolArgumentsSnapshot;
export interface ToolArgumentsSnapshot { readonly [key: string]: ToolJsonValue }

export class InvalidToolArgumentsError extends Error {
  constructor() { super('Invalid tool arguments'); this.name = 'InvalidToolArgumentsError'; }
}

// Reuse the exact contract limits and hostile-object checks. Validation and copy
// are synchronous, with no callback/await between them. Only descriptors are read.
export function snapshotToolArguments(raw: unknown): ToolArgumentsSnapshot {
  try {
    const decision = parseModelDecision({ kind: 'tool_request', toolName: 'snapshot', arguments: raw });
    if (decision.kind !== 'tool_request') throw new InvalidToolArgumentsError();
    function copy(value: unknown): ToolJsonValue {
      if (value === null || typeof value !== 'object') return value as string | number | boolean | null;
      const array = Array.isArray(value);
      const result = array ? [] : Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        Object.defineProperty(result, key, {
          value: copy(descriptor.value), enumerable: true, writable: false, configurable: false,
        });
      }
      return Object.freeze(result) as ToolJsonValue;
    }
    return copy(decision.arguments) as ToolArgumentsSnapshot;
  } catch {
    // No input, Zod issues, or exception cause escapes this boundary.
    throw new InvalidToolArgumentsError();
  }
}
