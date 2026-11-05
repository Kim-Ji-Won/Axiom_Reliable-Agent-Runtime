import { Pool } from 'pg';

export function createDatabase(connectionString: string): Pool {
  if (!connectionString) throw new Error('A database connection string is required');
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  // Never log connection strings, credentials, or query payloads.
  pool.on('error', () => { console.error('An idle PostgreSQL connection failed'); });
  return pool;
}

export async function withDatabase<T>(
  connectionString: string,
  work: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = createDatabase(connectionString);
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}
