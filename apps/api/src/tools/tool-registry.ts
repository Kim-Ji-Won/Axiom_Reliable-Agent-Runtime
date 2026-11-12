import { parseModelDecision } from '@axiom/contracts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { snapshotToolArguments, type ToolArgumentsSnapshot } from './tool-arguments-snapshot.js';

export interface ToolDefinition {
  readonly name: string;
  readonly inputSchema: z.ZodType;
}
const invalidDefinition = () => new Error('Invalid tool definition');

// Only declarative JSON schemas are supported. All object levels must be strict;
// defaults, coercion, transforms, catch, lazy and permissive schemas fail closed.
// Copy schema containers so changing a caller's definition/shape cannot register
// new fields later. Refinements/check functions remain trusted application code.
function copyStrictSchema(schema: z.ZodType, ancestors = new Set<z.ZodType>()): z.ZodType {
  if (ancestors.has(schema) || ancestors.size > 16) throw invalidDefinition();
  const def = schema.def;
  if (('coerce' in def && def.coerce) ||
      def.checks?.some(check => check._zod.def.check === 'overwrite')) throw invalidDefinition();
  ancestors.add(schema);
  const copy = (child: z.ZodType) => copyStrictSchema(child, ancestors);
  let result: z.ZodType;
  if (schema instanceof z.ZodObject) {
    if (!(schema.def.catchall instanceof z.ZodNever)) throw invalidDefinition();
    const shape: Record<string, z.ZodType> = Object.create(null);
    for (const [key, child] of Object.entries(schema.shape)) {
      Object.defineProperty(shape, key, { value: copy(child as z.ZodType), enumerable: true });
    }
    result = schema.clone({ ...schema.def, shape });
  } else if (schema instanceof z.ZodArray) {
    result = schema.clone({ ...schema.def, element: copy(schema.element as z.ZodType) });
  } else if (schema instanceof z.ZodOptional) {
    result = schema.clone({ ...schema.def, innerType: copy(schema.unwrap() as z.ZodType) });
  } else if (schema instanceof z.ZodNullable) {
    result = schema.clone({ ...schema.def, innerType: copy(schema.unwrap() as z.ZodType) });
  } else if (schema instanceof z.ZodUnion) {
    result = schema.clone({ ...schema.def, options: schema.options.map(s => copy(s as z.ZodType)) });
  } else if (schema instanceof z.ZodString || schema instanceof z.ZodNumber ||
      schema instanceof z.ZodBoolean || schema instanceof z.ZodNull ||
      schema instanceof z.ZodLiteral || schema instanceof z.ZodEnum) {
    result = (schema as z.ZodType).clone({ ...schema.def });
  } else throw invalidDefinition();
  ancestors.delete(schema);
  return result;
}

export function createToolRegistry(definitions: readonly ToolDefinition[]) {
  const entries = new Map<string, { name: Readonly<{ name: string }>; schema: z.ZodType }>();
  try {
    for (const definition of definitions) {
      const { name, inputSchema } = definition;
      // One authoritative name rule, shared with ModelDecision.
      parseModelDecision({ kind: 'tool_request', toolName: name, arguments: {} });
      if (entries.has(name) || !(inputSchema instanceof z.ZodObject)) throw invalidDefinition();
      entries.set(name, { name: Object.freeze({ name }), schema: copyStrictSchema(inputSchema) });
    }
  } catch { throw invalidDefinition(); }
  return Object.freeze({
    lookup(name: string): Readonly<{ name: string }> | undefined { return entries.get(name)?.name; },
    accepts(name: string, snapshot: ToolArgumentsSnapshot): boolean {
      const entry = entries.get(name);
      if (!entry) return false;
      try {
        const input = snapshotToolArguments(snapshot);
        const parsed = entry.schema.safeParse(input);
        // Never return Zod output. Even a trusted refinement must not silently
        // transform/expand the validated input. Revalidate its output safely.
        return parsed.success && isDeepStrictEqual(snapshotToolArguments(parsed.data), input);
      } catch { return false; }
    },
  });
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>;
