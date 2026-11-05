import { migrate } from './migrate.js';

const target = process.argv[2];
if (target !== 'dev' && target !== 'test') {
  console.error('Usage: migrate-cli.ts dev|test');
  process.exitCode = 1;
} else {
  try {
    const applied = await migrate(target);
    console.log(`Applied ${applied.length} migration(s) to ${target}`);
  } catch {
    // Database errors can include credentials or SQL payloads; do not print raw errors.
    console.error('Migration failed. Check the local database URL, identity, availability, and migration files.');
    process.exitCode = 1;
  }
}
