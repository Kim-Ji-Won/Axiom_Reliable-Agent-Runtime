import { isDeepStrictEqual, types } from 'node:util';
import { parseModelDecision, runIdSchema } from '@axiom/contracts';
import { snapshotToolArguments, type ToolArgumentsSnapshot } from './tool-arguments-snapshot.js';

export function dataField(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid tool authorization scope');
  return descriptor.value;
}

export interface ToolAuthorizationScope {
  readonly runId: string;
  readonly toolName: string;
  readonly arguments: ToolArgumentsSnapshot;
}

export function readScope(raw: unknown, discriminator: 'effect' | 'kind') {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== 4) {
    throw new Error('Invalid tool authorization scope');
  }
  const tag = dataField(raw, discriminator);
  const runId = dataField(raw, 'runId');
  const toolName = dataField(raw, 'toolName');
  const args = dataField(raw, 'arguments');
  if (typeof runId !== 'string' || runId.length !== 36 || !runIdSchema.safeParse(runId).success ||
      typeof toolName !== 'string') throw new Error('Invalid tool authorization scope');
  parseModelDecision({ kind: 'tool_request', toolName, arguments: {} });
  return { tag, scope: { runId: runId.toLowerCase(), toolName, arguments: snapshotToolArguments(args) } };
}

export function sameScope(a: ToolAuthorizationScope, b: ToolAuthorizationScope): boolean {
  // Both inputs have independent frozen JSON snapshots with normalized object prototypes.
  return a.runId === b.runId && a.toolName === b.toolName && isDeepStrictEqual(a.arguments, b.arguments);
}
