import { runMigrations } from './migration';
import { createPool } from './pool';

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const release = process.argv[2] ?? 'local';

if (!databaseUrl) {
  throw new Error(
    'MIGRATION_DATABASE_URL or DATABASE_URL is required to run migrations.',
  );
}

const database = createPool(databaseUrl);

try {
  const applied = await runMigrations(database, { release });
  process.stdout.write(`Applied migrations: ${applied.join(', ') || 'none'}\n`);
} finally {
  await database.close();
}
