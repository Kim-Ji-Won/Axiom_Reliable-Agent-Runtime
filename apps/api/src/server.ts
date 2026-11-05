import { buildApp } from './app.js';

const app = buildApp();
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');

  try {
    await app.close();
    app.log.info('Server closed');
  } catch (error) {
    app.log.error(error, 'Shutdown failed');
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await app.listen({ host: '127.0.0.1', port: 3000 });
} catch (error) {
  app.log.error(error, 'Startup failed');
  process.exitCode = 1;
  await app.close();
}
