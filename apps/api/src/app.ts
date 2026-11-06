import Fastify, { LogController } from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { createRunRequestSchema, runIdSchema, runResponseSchema } from '@axiom/contracts';
import { createDatabase } from './persistence/database.js';
import { createRunRepository } from './persistence/run-repository.js';

interface AppOptions {
  databaseUrl?: string;
  repository?: ReturnType<typeof createRunRepository>;
  databaseFactory?: typeof createDatabase;
  logger?: FastifyServerOptions['logger'];
}

function databaseUnavailable(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(databaseUnavailable);
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && (
    code.startsWith('08') || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
      'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', '28P01', '28000', '3D000', '53300',
      '57P01', '57P02', '57P03'].includes(code)
  ) || ['Connection terminated unexpectedly', 'Connection terminated',
    'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect']
    .includes(error.message);
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  // Automatic request logging includes user-controlled URLs. Log only safe codes below.
  const app = Fastify({ logger: options.logger ?? true, logController: new LogController({ disableRequestLogging: true }) });
  let repository = options.repository;
  if (!repository && options.databaseUrl) {
    try {
      const url = new URL(options.databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid database configuration');
      const pool = (options.databaseFactory ?? createDatabase)(options.databaseUrl);
      app.addHook('onClose', async () => { await pool.end(); });
      repository = createRunRepository(pool);
    } catch {
      app.log.warn({ code: 'DATABASE_UNAVAILABLE' }, 'Database configuration unavailable');
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } });
    }
    const unavailable = databaseUnavailable(error);
    const code = unavailable ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR';
    app.log.error({ code }, 'Request failed');
    return reply.code(unavailable ? 503 : 500).send({ error: {
      code, message: unavailable ? 'Database unavailable' : 'Internal server error',
    } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    error: { code: 'INVALID_REQUEST', message: 'Route not found' },
  }));
  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/runs', async (request, reply) => {
    const input = createRunRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } });
    if (!repository) return reply.code(503).send({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' } });
    const run = await repository.createRun(input.data.task);
    return reply.code(201).send(runResponseSchema.parse({ ...run, createdAt: run.createdAt.toISOString() }));
  });
  app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const id = runIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } });
    if (!repository) return reply.code(503).send({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' } });
    const run = await repository.findRunById(id.data);
    if (!run) return reply.code(404).send({ error: { code: 'RUN_NOT_FOUND', message: 'Run not found' } });
    return runResponseSchema.parse({ ...run, createdAt: run.createdAt.toISOString() });
  });
  return app;
}
