import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createReferralService } from '../src/server/referral/service.ts';

// E4-05's milestone awards. Since E11.7-03 the coupon ladder replaces the
// tiers (test/coupon-ladder.test.ts): no confirmation awards a tier and the
// tier backfill is gone. What remains here is what still holds of the table:
// its uniqueness, and `referral_tier` derived only from settled awards.

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-13T12:00:00.000Z');

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e405_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e4-05-test',
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

async function insertVerifiedSubscriber(
  database: DatabasePool,
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at
      )
      VALUES ($1, $2, $2, 'example.test', 'verified', $3)
    `,
    values: [id, `${id}@example.test`, now],
  });
  return id;
}

async function confirmNextEdge(
  database: DatabasePool,
  referrerId: string,
): Promise<void> {
  const referredId = await insertVerifiedSubscriber(database);
  await database.execute({
    text: `
      INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
      VALUES ($1, $2, $3, 'attributed', 'none')
    `,
    values: [randomUUID(), referrerId, referredId],
  });
  await createReferralService(database).confirm(referredId, now);
}

test('the database rejects a duplicate award for the same subscriber, tier, and reward kind', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertVerifiedSubscriber(fixture.database);
    const statement = {
      text: `
        INSERT INTO milestone_award (
          id, subscriber_id, tier, reward_kind, state, awarded_at
        ) VALUES ($1, $2, 1, 'wave_upgrade', 'settled', $3)
      `,
      values: [randomUUID(), subscriberId, now],
    };
    await fixture.database.execute(statement);
    await assert.rejects(
      fixture.database.execute({
        ...statement,
        values: [randomUUID(), subscriberId, now],
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505',
    );
  } finally {
    await fixture.dispose();
  }
});

test('referral_tier is derived only from settled milestone awards', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertVerifiedSubscriber(fixture.database);
    await fixture.database.execute({
      text: 'UPDATE subscriber SET referral_tier = 99 WHERE id = $1',
      values: [referrerId],
    });
    await fixture.database.execute({
      text: `
        INSERT INTO milestone_award (
          id, subscriber_id, tier, reward_kind, state, awarded_at
        ) VALUES ($1, $2, 2, 'discount', 'held', $3)
      `,
      values: [randomUUID(), referrerId, now],
    });

    await confirmNextEdge(fixture.database, referrerId);

    assert.deepEqual(
      await fixture.database.readOne({
        text: 'SELECT confirmed_referrals, referral_tier FROM subscriber WHERE id = $1',
        values: [referrerId],
      }),
      { confirmed_referrals: 1, referral_tier: 0 },
    );
  } finally {
    await fixture.dispose();
  }
});
