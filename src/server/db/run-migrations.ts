import { runMigrations } from './migration';
import { createPool } from './pool';

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
const applicationRolePassword = process.env.VALSTARA_APP_DB_PASSWORD;
const release = process.argv[2] ?? 'local';

if (!databaseUrl) {
  throw new Error('MIGRATION_DATABASE_URL is required to run migrations.');
}

if (!applicationRolePassword) {
  throw new Error('VALSTARA_APP_DB_PASSWORD is required to run migrations.');
}

const database = createPool(databaseUrl);

try {
  const applied = await runMigrations(database, {
    applicationRolePassword,
    release,
  });
  process.stdout.write(`Applied migrations: ${applied.join(', ') || 'none'}\n`);
} finally {
  await database.close();
}
