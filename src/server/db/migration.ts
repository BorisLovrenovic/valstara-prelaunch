import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { MigrationChecksumMismatchError } from './errors.ts';
import type { DatabaseClient, DatabasePool } from './pool.ts';

const MIGRATION_LOCK_ID = 8_573_439_303;
const MIGRATION_LEDGER_LIMIT = 10_000;
const migrationFilename = /^\d{4}-[a-z0-9-]+\.sql$/;

export interface Migration {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface RunMigrationsOptions {
  readonly applicationRolePassword: string;
  readonly directory?: string;
  readonly release: string;
}

const defaultMigrationDirectory = fileURLToPath(
  new URL('./migrations/', import.meta.url),
);

export async function loadMigrations(
  directory = defaultMigrationDirectory,
): Promise<readonly Migration[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => migrationFilename.test(filename))
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(`${directory}/${filename}`, 'utf8');
      return { filename, sql, checksum: checksum(sql) };
    }),
  );
}

export async function runMigrations(
  database: DatabasePool,
  {
    applicationRolePassword,
    directory = defaultMigrationDirectory,
    release,
  }: RunMigrationsOptions,
): Promise<readonly string[]> {
  if (applicationRolePassword.length === 0) {
    throw new Error('The application database password is required.');
  }

  const migrations = await loadMigrations(directory);
  const connection = await database.connect();
  const applied: string[] = [];

  try {
    await connection.readOne({
      text: 'SELECT pg_advisory_lock($1)',
      values: [MIGRATION_LOCK_ID],
    });
    await initialiseLedger(connection);
    await assertAppliedHistoryMatchesFiles(connection, migrations);

    for (const migration of migrations) {
      const existing = await connection.readOne<{ checksum: string }>({
        text: 'SELECT checksum FROM migration_ledger WHERE filename = $1',
        values: [migration.filename],
      });

      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new MigrationChecksumMismatchError(migration.filename);
        }
        continue;
      }

      await applyMigration(
        connection,
        migration,
        release,
        applicationRolePassword,
      );
      applied.push(migration.filename);
    }
  } finally {
    await connection.readOne({
      text: 'SELECT pg_advisory_unlock($1)',
      values: [MIGRATION_LOCK_ID],
    });
    connection.release();
  }

  return applied;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function initialiseLedger(connection: DatabaseClient): Promise<void> {
  await connection.execute({
    text: `
      CREATE TABLE IF NOT EXISTS migration_ledger (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL,
        checksum text NOT NULL,
        applied_by_release text NOT NULL
      )
    `,
  });
}

async function applyMigration(
  connection: DatabaseClient,
  migration: Migration,
  release: string,
  applicationRolePassword: string,
): Promise<void> {
  try {
    await connection.execute({ text: 'BEGIN' });
    await connection.readOne({
      text: "SELECT set_config('valstara.application_role_password', $1, true)",
      values: [applicationRolePassword],
    });
    await connection.execute({ text: migration.sql });
    await connection.execute({
      text: `
        INSERT INTO migration_ledger (filename, applied_at, checksum, applied_by_release)
        VALUES ($1, CURRENT_TIMESTAMP, $2, $3)
      `,
      values: [migration.filename, migration.checksum, release],
    });
    await connection.execute({ text: 'COMMIT' });
  } catch (error) {
    await connection.execute({ text: 'ROLLBACK' });
    throw error;
  }
}

async function assertAppliedHistoryMatchesFiles(
  connection: DatabaseClient,
  migrations: readonly Migration[],
): Promise<void> {
  const appliedMigrations = await connection.list<{ filename: string }>(
    {
      text: 'SELECT filename FROM migration_ledger ORDER BY filename',
    },
    MIGRATION_LEDGER_LIMIT,
  );

  for (const [index, appliedMigration] of appliedMigrations.entries()) {
    if (migrations[index]?.filename !== appliedMigration.filename) {
      throw new Error(
        'Applied migration history does not match checked-in files.',
      );
    }
  }
}
