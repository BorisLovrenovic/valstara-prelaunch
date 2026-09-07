import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { consumeThinVerificationToken } from '../src/server/e1-11/verify.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';

// E1-11 built the thin signup→verify slice. E3-02 promoted the signup half into
// the real subscriber module and route (see `subscriber-signup.test.ts` and
// `signup-route.test.ts`); the `/verify` consumer remains E1-11's until E3-07,
// so its contract is tested here directly against a seeded token.

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e111_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e1-11-test',
  });

  return {
    database,
    async dispose() {
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
    },
  };
}

async function seedPendingToken(
  database: DatabasePool,
  token: string,
  expiresAt: Date,
): Promise<string> {
  const subscriberId = randomUUID();
  await database.execute({
    text: `
      INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `,
    values: [
      subscriberId,
      'verify@example.test',
      'verify@example.test',
      'example.test',
    ],
  });
  await database.execute({
    text: `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      )
      VALUES ($1, $2, $3, 'verify', $4)
    `,
    values: [
      randomUUID(),
      subscriberId,
      createHash('sha256').update(token).digest(),
      expiresAt,
    ],
  });
  return subscriberId;
}

test('/verify consumes a token once, sets verified, and a replay returns already', async () => {
  const fixture = await createDatabaseFixture();
  const token = 'valid-verify-token';
  const now = new Date('2026-09-06T12:00:00.000Z');

  try {
    const subscriberId = await seedPendingToken(
      fixture.database,
      token,
      new Date('2026-09-13T12:00:00.000Z'),
    );

    assert.equal(
      await consumeThinVerificationToken(fixture.database, token, now),
      'verified',
    );
    // A replayed token is a no-op that reports success, never an error.
    assert.equal(
      await consumeThinVerificationToken(fixture.database, token, now),
      'already',
    );

    const subscriber = await fixture.database.readOne<{
      status: string;
      verified_at: Date | null;
    }>({
      text: 'SELECT status, verified_at FROM subscriber WHERE id = $1',
      values: [subscriberId],
    });
    assert.equal(subscriber?.status, 'verified');
    assert.notEqual(subscriber?.verified_at, null);
  } finally {
    await fixture.dispose();
  }
});

test('/verify treats an expired, unknown or empty token as invalid, with the clock injected', async () => {
  const fixture = await createDatabaseFixture();
  const token = 'expired-verify-token';

  try {
    await seedPendingToken(
      fixture.database,
      token,
      new Date('2026-09-06T12:00:00.000Z'),
    );

    // One second past expiry, under the injected clock.
    assert.equal(
      await consumeThinVerificationToken(
        fixture.database,
        token,
        new Date('2026-09-06T12:00:01.000Z'),
      ),
      'invalid',
    );
    assert.equal(
      await consumeThinVerificationToken(
        fixture.database,
        'no-such-token',
        new Date('2026-09-06T12:00:00.000Z'),
      ),
      'invalid',
    );
    assert.equal(
      await consumeThinVerificationToken(
        fixture.database,
        '',
        new Date('2026-09-06T12:00:00.000Z'),
      ),
      'invalid',
    );

    // The expired token never flipped the subscriber to verified.
    const subscriber = await fixture.database.readOne<{ status: string }>({
      text: 'SELECT status FROM subscriber',
    });
    assert.equal(subscriber?.status, 'pending');
  } finally {
    await fixture.dispose();
  }
});
