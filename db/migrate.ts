import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { assertDatabaseIdentity, readDatabaseUrl } from './connection.js';

export async function migrate(
  target: 'dev' | 'test',
  direction: 'up' | 'down' = 'up',
  schema = 'public',
) {
  if (schema !== 'public' && !/^axiom_test_[0-9a-f]{32}$/.test(schema)) {
    throw new Error('Invalid migration schema');
  }
  if (direction === 'down' && (target !== 'test' || schema === 'public')) {
    throw new Error('Rollback is restricted to disposable test schemas');
  }
  const client = new Client({ connectionString: readDatabaseUrl(target), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await assertDatabaseIdentity(client, target);
    return await runner({
      dbClient: client,
      dir: fileURLToPath(new URL('./migrations', import.meta.url)),
      migrationsTable: 'pgmigrations',
      schema,
      migrationsSchema: schema,
      direction,
      count: direction === 'down' ? 1 : Infinity,
      singleTransaction: true,
      checkOrder: true,
      log: () => {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
  } finally {
    await client.end();
  }
}
