import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createFraudFlagRepository } from '../src/server/db/fraud-flag.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

async function withDatabase(
  operation: (database: DatabasePool) => Promise<void>,
): Promise<void> {
  const databaseName = `valstara_e303flag_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());

  try {
    await runMigrations(database, {
      applicationRolePassword,
      release: 'e3-03-flag-test',
    });
    await operation(database);
  } finally {
    await database.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [databaseName],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${databaseName}"` });
    await admin.close();
  }
}

async function insertPendingSubscriber(
  database: DatabasePool,
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `
      INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
      VALUES ($1, $2, $2, 'example.test', 'pending')
    `,
    values: [id, `${id}@example.test`],
  });
  return id;
}

interface FlagRow {
  readonly kind: string;
  readonly state: string;
  readonly detail: Record<string, unknown>;
}

async function openFlags(
  database: DatabasePool,
  subscriberId: string,
): Promise<readonly FlagRow[]> {
  return database.list<FlagRow>(
    {
      text: 'SELECT kind, state, detail FROM fraud_flag WHERE subscriber_id = $1',
      values: [subscriberId],
    },
    10,
  );
}

test('migration 0005 lets a challenge_timeout flag be written, and the detail carries no personal data', async () => {
  await withDatabase(async (database) => {
    const subscriberId = await insertPendingSubscriber(database);
    const written = await createFraudFlagRepository(
      database,
    ).insertChallengeTimeoutFlag({ id: randomUUID(), subscriberId });

    assert.equal(written, 1);
    const flags = await openFlags(database, subscriberId);
    assert.equal(flags.length, 1);
    assert.equal(flags[0]?.kind, 'challenge_timeout');
    assert.equal(flags[0]?.state, 'open');
    assert.deepEqual(flags[0]?.detail, {
      reason: 'turnstile_provider_timeout',
    });
  });
});

test('a second timeout for the same subscriber does not open a second flag', async () => {
  await withDatabase(async (database) => {
    const repository = createFraudFlagRepository(database);
    const subscriberId = await insertPendingSubscriber(database);

    const first = await repository.insertChallengeTimeoutFlag({
      id: randomUUID(),
      subscriberId,
    });
    const second = await repository.insertChallengeTimeoutFlag({
      id: randomUUID(),
      subscriberId,
    });

    assert.equal(first, 1);
    assert.equal(second, 0);
    assert.equal((await openFlags(database, subscriberId)).length, 1);
  });
});

test('the kind CHECK still constrains — an unknown kind is rejected at the database level', async () => {
  await withDatabase(async (database) => {
    const subscriberId = await insertPendingSubscriber(database);
    await assert.rejects(
      database.execute({
        text: `
          INSERT INTO fraud_flag (id, subscriber_id, kind, detail, state)
          VALUES ($1, $2, 'not_a_real_kind', '{}'::jsonb, 'open')
        `,
        values: [randomUUID(), subscriberId],
      }),
      /fraud_flag_kind_check|violates check constraint/,
    );
  });
});
