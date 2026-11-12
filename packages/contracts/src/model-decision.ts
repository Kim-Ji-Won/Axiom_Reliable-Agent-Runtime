import { Buffer } from 'node:buffer';
import { types } from 'node:util';
import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

const MAX_BYTES = 8192;
const MAX_DEPTH = 8;
const INVALID_DECISION = 'Invalid model decision';

export class InvalidModelDecisionError extends Error {
  constructor() {
    super(INVALID_DECISION);
    this.name = 'InvalidModelDecisionError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Inspect descriptors, never invoke accessors or toJSON. Root container depth is 1.
function validArguments(root: unknown): root is JsonObject {
  if (!isPlainObject(root)) return false;
  let bytes = 0;
  const ancestors = new Set<object>();
  function add(size: number): boolean {
    bytes += size;
    return bytes <= MAX_BYTES;
  }
  function stringSize(value: string): boolean {
    // JSON UTF-8 bytes are at least the UTF-16 length. Bound work before encoding.
    return value.length <= MAX_BYTES - bytes &&
      add(Buffer.byteLength(JSON.stringify(value), 'utf8'));
  }
  function visit(value: unknown, depth: number): boolean {
    if (value === null) return add(4);
    if (typeof value === 'string') return stringSize(value);
    if (typeof value === 'boolean') return add(value ? 4 : 5);
    if (typeof value === 'number') return Number.isFinite(value) && add(JSON.stringify(value).length);
    if (typeof value !== 'object' || types.isProxy(value) || depth > MAX_DEPTH) return false;
    if (ancestors.has(value)) return false;
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isPlainObject(value)) return false;
    if (array && value.length > MAX_BYTES / 2) return false;
    const keys = Reflect.ownKeys(value);
    // Even the smallest JSON member needs bytes. Reject wide objects before walking values.
    if (keys.length > MAX_BYTES / 2 + 1 || !add(2)) return false;
    if (array && keys.length !== value.length + 1) return false;
    ancestors.add(value);
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return false;
      if (array && key !== String(count)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
      if (count > 0 && !add(1)) return false;
      if (!array && (!stringSize(key) || !add(1))) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
      count++;
    }
    ancestors.delete(value);
    return true;
  }
  return visit(root, 1);
}

function validDecision(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 1 && keys.length !== 2 && keys.length !== 3) return false;
  for (const key of keys) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  const kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value;
  if (kind === 'continue') return keys.length === 1;
  if (kind === 'final') {
    if (keys.length !== 2 || !keys.includes('content')) return false;
    const content = Object.getOwnPropertyDescriptor(raw, 'content')!.value;
    return typeof content === 'string' && content.length <= 8000 &&
      content.trim().length > 0 && [...content].length <= 4000 &&
      !content.includes('\0') && !/[\uD800-\uDFFF]/u.test(content);
  }
  if (kind === 'tool_request') {
    if (keys.length !== 3 || !keys.includes('toolName') || !keys.includes('arguments')) return false;
    const name = Object.getOwnPropertyDescriptor(raw, 'toolName')!.value;
    return typeof name === 'string' && name.length <= 64 && /^[a-z][a-z0-9_-]*$/.test(name) &&
      validArguments(Object.getOwnPropertyDescriptor(raw, 'arguments')!.value);
  }
  return false;
}

const decisionVariants = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('continue') }),
  z.strictObject({ kind: z.literal('final'), content: z.string() }),
  z.strictObject({
    kind: z.literal('tool_request'), toolName: z.string(), arguments: z.custom<JsonObject>(),
  }),
]);
export type ModelDecision = z.infer<typeof decisionVariants>;

// Reject hostile objects before Zod reads properties. Invalid input is replaced only
// on the failure path so even reportInput errors cannot retain model secrets.
export const modelDecisionSchema = z.preprocess((raw: unknown) => {
  try { return validDecision(raw) ? raw : undefined; }
  catch { return undefined; }
}, decisionVariants);

export function parseModelDecision(raw: unknown): ModelDecision {
  const result = modelDecisionSchema.safeParse(raw);
  if (!result.success) throw new InvalidModelDecisionError();
  return result.data;
}
