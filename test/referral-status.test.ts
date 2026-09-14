import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { computeReferralStatus } from '../src/server/referral/status.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-14T12:00:00.000Z');

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e408_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationDatabaseUrl = new URL(databaseUrl);
  applicationDatabaseUrl.username = 'valstara_app';
  applicationDatabaseUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e4-08-test',
  });
  const applicationDatabase = createPool(applicationDatabaseUrl.toString());

  return {
    applicationDatabase,
    database,
    async dispose() {
      await applicationDatabase.close();
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

async function insertSubscriber(
  database: DatabasePool,
  status: 'pending' | 'verified',
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, referral_code,
        confirmed_referrals, referral_tier, verified_at
      ) VALUES ($1, $2, $2, 'example.test', $3, $4, $5, $6, $7)
    `,
    values: [
      id,
      `${id}@example.test`,
      status,
      status === 'verified' ? 'ABCDEF234567' : null,
      status === 'verified' ? 12 : 0,
      status === 'verified' ? 99 : 0,
      status === 'verified' ? now : null,
    ],
  });
  return id;
}

test('the shared computation preserves the exact count and derives reward status once', () => {
  assert.deepEqual(
    computeReferralStatus(12, 'ABCDEF234567', [
      { reward_kind: 'wave_upgrade', state: 'settled', tier: 1 },
      { reward_kind: 'discount', state: 'held', tier: 7 },
      { reward_kind: 'entries', state: 'held', tier: 7 },
    ]),
    {
      confirmedReferrals: 12,
      referralLink: 'https://valstara.com/?ref=ABCDEF234567',
      rewards: [
        { kind: 'wave_upgrade', state: 'settled', tier: 1 },
        { kind: 'discount', state: 'held', tier: 7 },
        { kind: 'entries', state: 'held', tier: 7 },
      ],
      tier: 1,
    },
  );
});

test('status returns the exact stored count, a settled-only tier, and each active reward state', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'verified');
    await fixture.database.execute({
      text: `
        INSERT INTO milestone_award (
          id, subscriber_id, tier, reward_kind, state, awarded_at
        ) VALUES
          ($1, $2, 1, 'wave_upgrade', 'settled', $3),
          ($4, $2, 7, 'discount', 'held', $3),
          ($5, $2, 7, 'entries', 'held', $3),
          ($6, $2, 9, 'merch', 'void', $3)
      `,
      values: [
        randomUUID(),
        subscriberId,
        now,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    });

    const status = await createReferralService(
      fixture.applicationDatabase,
    ).status(subscriberId);

    assert.deepEqual(status, {
      confirmedReferrals: 12,
      referralLink: 'https://valstara.com/?ref=ABCDEF234567',
      rewards: [
        { kind: 'wave_upgrade', state: 'settled', tier: 1 },
        { kind: 'discount', state: 'held', tier: 7 },
        { kind: 'entries', state: 'held', tier: 7 },
      ],
      tier: 1,
    });
  } finally {
    await fixture.dispose();
  }
});

test('referral flag off leaves existing earned status readable', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'verified');
    await fixture.database.execute({
      text: `
        INSERT INTO campaign_flag (key, enabled, updated_by)
        VALUES ('referral.enabled', false, 'operator-1')
      `,
    });
    assert.equal(
      await createFlagService(fixture.applicationDatabase).isEnabled(
        'referral.enabled',
      ),
      false,
    );

    assert.equal(
      (
        await createReferralService(fixture.applicationDatabase).status(
          subscriberId,
        )
      ).confirmedReferrals,
      12,
    );
  } finally {
    await fixture.dispose();
  }
});

test('status refuses to expose an unverified subscriber', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'pending');

    await assert.rejects(
      createReferralService(fixture.applicationDatabase).status(subscriberId),
      /requires a verified subscriber/u,
    );
  } finally {
    await fixture.dispose();
  }
});
