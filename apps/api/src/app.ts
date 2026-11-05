import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  // Liveness only: this does not check external dependencies.
  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
