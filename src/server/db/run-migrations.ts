import { runMigrations } from './migration';
import { createPool } from './pool';

const databaseUrl = process.env.DATABASE_URL;
const release = process.argv[2] ?? 'local';

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run migrations.');
}

const database = createPool(databaseUrl);

try {
  const applied = await runMigrations(database, { release });
  process.stdout.write(`Applied migrations: ${applied.join(', ') || 'none'}\n`);
} finally {
  await database.close();
}
