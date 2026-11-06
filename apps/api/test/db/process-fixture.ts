import { buildApp } from '../../src/app.js';
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
    const mode = process.argv[2];
    if (mode === 'http-create' || mode === 'http-read') {
      // Reuse the guarded client so every HTTP query stays in this test schema.
      const app = buildApp({ repository: repo, logger: false });
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const response = mode === 'http-create'
          ? await fetch(`${address}/runs`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ task: '  HTTP restart 회의록 😀  ' }),
            signal: AbortSignal.timeout(5000),
          })
          : await fetch(`${address}/runs/${process.argv[3] ?? ''}`, { signal: AbortSignal.timeout(5000) });
        console.log(JSON.stringify({ pid: process.pid, status: response.status, run: await response.json() }));
      } finally {
        await app.close();
      }
    } else {
      const run = mode === 'create'
        ? await repo.createRun('persist across separate processes')
        : await repo.findRunById(process.argv[3] ?? '');
      console.log(JSON.stringify(run));
    }
  } finally { client.release(); }
});
