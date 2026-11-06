import { buildApp } from './app.js';

const app = buildApp(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {});
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');

  try {
    await app.close();
    app.log.info('Server closed');
  } catch {
    app.log.error('Shutdown failed');
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await app.listen({ host: '127.0.0.1', port: 3000 });
} catch {
  app.log.error('Startup failed');
  process.exitCode = 1;
  await app.close();
}
