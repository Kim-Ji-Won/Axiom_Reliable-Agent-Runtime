import { types } from 'node:util';
import { InvalidRunInputError, runIdSchema } from '@axiom/contracts';
import { runLeaseBoundedDecisions, type LeaseDecisionDependencies, type LeaseDecisionOptions,
  type LeaseDecisionResult } from './run-lease-bounded-decisions.js';
import { runLeaseBoundedToolDecisions, type LeaseToolDependencies, type LeaseToolResult } from './run-lease-bounded-tool-decisions.js';

type DecisionOptions = LeaseDecisionOptions & { mode: 'decision_only'; maxToolAttempts: 0 };
type ToolOptions = LeaseDecisionOptions & { mode: 'tool_enabled'; maxToolAttempts: 0 | 1 };
export type OneShotWorkerOptions = DecisionOptions | ToolOptions;

const decisionMethods = ['tryClaimRunLease', 'initializeProgress', 'findRunById', 'tryReserveDecision',
  'appendContinuedStepWithLease', 'tryConfirmCommittedStep', 'tryFinalizeWithStepWithLease', 'decide'] as const;
const toolMethods = [...decisionMethods, 'tryReserveToolAttempt', 'appendToolSucceededStepWithLease'] as const;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === null || proto === Object.prototype) && Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable && Object.hasOwn(field, 'value');
    });
}

const functionToString = Function.prototype.toString;
const nativeFunctionSource = /^function\b[^(){}]*\(\s*\)\s*\{\s*\[native code\]\s*\}$/u;
// A class declaration/expression and a method named "class" share the first token.
// Skip only the trivia after it; a method's next token is its opening parenthesis.
const classPrefix = /^class(?=[\s/{(])(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*/u;

function supportedCallback(fn: unknown): boolean {
  if (typeof fn !== 'function' || types.isProxy(fn) || types.isGeneratorFunction(fn)) return false;
  try {
    const source = functionToString.call(fn);
    if (nativeFunctionSource.test(source)) return false;
    const prefix = classPrefix.exec(source);
    return prefix === null || source[prefix[0].length] === '(';
  } catch {
    return false;
  }
}
function uuid(value: unknown) { return typeof value === 'string' && value.length === 36 && runIdSchema.safeParse(value).success; }
function invalid(): never { throw new InvalidRunInputError('Invalid one-shot worker input'); }

function decisionDependencies(value: unknown): value is LeaseDecisionDependencies {
  return exact(value, decisionMethods) && decisionMethods.every(key => supportedCallback(value[key]));
}
function toolDependencies(value: unknown): value is LeaseToolDependencies {
  return exact(value, [...toolMethods, 'executor']) && toolMethods.every(key => supportedCallback(value[key])) &&
    exact(value.executor, ['execute']) && supportedCallback(value.executor.execute);
}

export function runOneShotWorker(id: string, dependencies: LeaseDecisionDependencies, options: DecisionOptions): Promise<LeaseDecisionResult>;
export function runOneShotWorker(id: string, dependencies: LeaseToolDependencies, options: ToolOptions): Promise<LeaseToolResult>;
export async function runOneShotWorker(id: string, dependencies: LeaseDecisionDependencies | LeaseToolDependencies,
  options: OneShotWorkerOptions): Promise<LeaseDecisionResult | LeaseToolResult> {
  if (!uuid(id) || !exact(options, ['mode', 'ownerId', 'leaseSeconds', 'maxDecisions', 'maxToolAttempts'])) return invalid();
  const { mode, ownerId, leaseSeconds, maxDecisions, maxToolAttempts } = options;
  if (!uuid(ownerId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300 ||
      !Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 5) return invalid();

  const budgets = { ownerId: ownerId.toLowerCase(), leaseSeconds, maxDecisions };
  if (mode === 'decision_only') {
    if (maxToolAttempts !== 0 || !decisionDependencies(dependencies)) return invalid();
    return runLeaseBoundedDecisions(id.toLowerCase(), { ...dependencies }, budgets);
  }
  if (mode !== 'tool_enabled' || (maxToolAttempts !== 0 && maxToolAttempts !== 1) || !toolDependencies(dependencies)) return invalid();
  // P3-E captures this executor and its method synchronously, preserving the receiver.
  return runLeaseBoundedToolDecisions(id.toLowerCase(), { ...dependencies }, { ...budgets, maxToolAttempts });
}
