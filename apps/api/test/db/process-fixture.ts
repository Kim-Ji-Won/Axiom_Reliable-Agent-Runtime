import { withDatabase } from '../../src/persistence/database.js';
import { createRunRepository } from '../../src/persistence/run-repository.js';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';

const schema = process.env.TEST_SCHEMA;
if (!schema || !/^axiom_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid test schema');
await withDatabase(readDatabaseUrl('test'), async (pool) => {
  const client = await pool.connect();
  try {
    await assertDatabaseIdentity(client, 'test');
    await client.query(`SET search_path TO "${schema}"`);
    const repo = createRunRepository(client);
    const run = process.argv[2] === 'create'
      ? await repo.createRun('persist across separate processes')
      : await repo.findRunById(process.argv[3] ?? '');
    console.log(JSON.stringify(run));
  } finally { client.release(); }
});
