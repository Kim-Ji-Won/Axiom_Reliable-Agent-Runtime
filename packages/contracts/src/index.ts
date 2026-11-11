import { z } from 'zod';

export class InvalidRunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRunInputError';
  }
}

export const taskSchema = z.string().refine(task =>
  task.trim().length > 0 && [...task].length <= 4000 &&
  !task.includes('\0') && !/[\uD800-\uDFFF]/u.test(task),
  'Task must contain non-whitespace text and at most 4000 Unicode code points');

export function validateTask(task: unknown): asserts task is string {
  if (!taskSchema.safeParse(task).success) {
    throw new InvalidRunInputError('Invalid task');
  }
}

export const runIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const createRunRequestSchema = z.strictObject({ task: taskSchema });
export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export const runOutcomeSchema = z.enum(['completed', 'failed']);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runResponseSchema = z.strictObject({
  id: runIdSchema,
  task: taskSchema,
  status: runStatusSchema,
  createdAt: z.iso.datetime(),
});
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
export type RunResponse = z.infer<typeof runResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export { modelDecisionSchema, parseModelDecision, InvalidModelDecisionError } from './model-decision.js';
export type { ModelDecision, JsonObject } from './model-decision.js';
