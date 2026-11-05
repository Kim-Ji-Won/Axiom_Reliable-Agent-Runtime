import type { ClientBase } from 'pg';

export function readDatabaseUrl(target: 'dev' | 'test', env = process.env): string {
  const value = target === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL;
  if (!value) throw new Error(target === 'test' ? 'TEST_DATABASE_URL is required' : 'DATABASE_URL is required');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid database URL'); }
  const database = target === 'test' ? 'axiom_test' : 'axiom';
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== `/${database}` || url.username !== database ||
      url.search !== '' || url.hash !== '') {
    throw new Error(`Refusing database URL: expected local ${database} database and user without URL options`);
  }
  return value;
}

export async function assertDatabaseIdentity(client: ClientBase, target: 'dev' | 'test'): Promise<void> {
  const result = await client.query<{ database: string; role: string }>(
    'SELECT current_database() AS database, current_user AS role',
  );
  const expected = target === 'test' ? 'axiom_test' : 'axiom';
  if (result.rows[0]?.database !== expected || result.rows[0]?.role !== expected) {
    throw new Error('Database identity mismatch; refusing migration or test setup');
  }
}
