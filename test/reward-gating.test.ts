import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import fc from 'fast-check';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import type { RewardClassifications } from '../src/server/referral/config.ts';
import {
  milestoneRewardClassifications,
  milestoneTiers,
} from '../src/server/referral/config.ts';
import {
  prelaunchRewardTransitions,
  rewardStateAtConfirmation,
} from '../src/server/referral/reward-state.ts';
import { createReferralService } from '../src/server/referral/service.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-13T12:00:00.000Z');

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e406_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e4-06-test',
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

async function insertAttributedEdge(
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

test('every pre-launch transition into settled requires a cheap confirmation', () => {
  const settlingTransitions = prelaunchRewardTransitions.filter(
    (transition) => transition.to === 'settled',
  );

  assert.deepEqual(settlingTransitions, [
    {
      classification: 'cheap',
      from: 'none',
      source: 'confirmation',
      to: 'settled',
    },
  ]);
  assert.equal(rewardStateAtConfirmation('cheap'), 'settled');
  assert.equal(rewardStateAtConfirmation('high_value'), 'held');
  assert.deepEqual(Object.keys(milestoneRewardClassifications).sort(), [
    'discount',
    'wave_upgrade',
  ]);
  assert.ok(
    milestoneTiers.every((tier) => !Object.hasOwn(tier, 'bonusEntries')),
  );
});

test('confirmation applies the configured cheap and high-value classifications', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertVerifiedSubscriber(fixture.database);
    for (let index = 0; index < 3; index += 1) {
      await insertAttributedEdge(fixture.database, referrerId);
    }

    const awards = await fixture.database.list<{
      reward_kind: string;
      state: string;
    }>(
      {
        text: `
          SELECT reward_kind, state
          FROM milestone_award
          WHERE subscriber_id = $1
          ORDER BY reward_kind
        `,
        values: [referrerId],
      },
      2,
    );
    assert.deepEqual(awards, [
      { reward_kind: 'discount', state: 'held' },
      { reward_kind: 'wave_upgrade', state: 'settled' },
    ]);

    const configuredClassifications: RewardClassifications = {
      discount: 'cheap',
      wave_upgrade: 'cheap',
    };
    const configuredReferrerId = await insertVerifiedSubscriber(
      fixture.database,
    );
    for (let index = 0; index < 3; index += 1) {
      const referredId = await insertVerifiedSubscriber(fixture.database);
      await fixture.database.execute({
        text: `
          INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
          VALUES ($1, $2, $3, 'attributed', 'none')
        `,
        values: [randomUUID(), configuredReferrerId, referredId],
      });
      await createReferralService(fixture.database, {
        rewardClassifications: configuredClassifications,
      }).confirm(referredId, now);
    }
    const configuredAwards = await fixture.database.list<{ state: string }>(
      {
        text: `
          SELECT state
          FROM milestone_award
          WHERE subscriber_id = $1
        `,
        values: [configuredReferrerId],
      },
      2,
    );
    assert.deepEqual(configuredAwards, [
      { state: 'settled' },
      { state: 'settled' },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('a seeded referral-graph property keeps high-value awards out of settled without an order signal', async () => {
  const fixture = await createDatabaseFixture();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 3, max: 7 }), {
          maxLength: 3,
          minLength: 1,
        }),
        async (confirmationCounts) => {
          const referrerIds: string[] = [];
          for (const confirmationCount of confirmationCounts) {
            const referrerId = await insertVerifiedSubscriber(fixture.database);
            referrerIds.push(referrerId);
            for (let index = 0; index < confirmationCount; index += 1) {
              await insertAttributedEdge(fixture.database, referrerId);
            }
          }

          const highValueAwards = await fixture.database.list<{
            reward_kind: string;
            state: string;
          }>(
            {
              text: `
                SELECT reward_kind, state
                FROM milestone_award
                WHERE subscriber_id = ANY($1::uuid[])
                  AND reward_kind = 'discount'
              `,
              values: [referrerIds],
            },
            confirmationCounts.length,
          );
          assert.equal(highValueAwards.length, confirmationCounts.length);
          assert.ok(highValueAwards.every((award) => award.state === 'held'));
        },
      ),
      { numRuns: 20, seed: 20_260_913 },
    );
  } finally {
    await fixture.dispose();
  }
});
