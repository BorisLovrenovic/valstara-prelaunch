import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import fc from 'fast-check';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  computeCouponLadder,
  couponLadder,
  milestoneTiers,
} from '../src/server/referral/config.ts';
import {
  couponTransitions,
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
  // The high-value reward is now the coupon ladder (E11.7-03), and none of
  // its transitions reaches `settled`.
  assert.ok(
    couponTransitions.every(
      (transition) => (transition.to as string) !== 'settled',
    ),
  );
  // No configured reward is a draw entry: the retired tiers carry none, and
  // the ladder holds only percents.
  assert.ok(
    milestoneTiers.every((tier) => !Object.hasOwn(tier, 'bonusEntries')),
  );
  assert.ok(!Object.hasOwn(couponLadder, 'bonusEntries'));
});

test('confirmation settles only the cheap edge reward and holds every coupon', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertVerifiedSubscriber(fixture.database);
    for (let index = 0; index < 6; index += 1) {
      await insertAttributedEdge(fixture.database, referrerId);
    }

    const edges = await fixture.database.list<{ reward_state: string }>(
      {
        text: `SELECT DISTINCT reward_state FROM referral_edge WHERE referrer_id = $1`,
        values: [referrerId],
      },
      5,
    );
    assert.deepEqual(edges, [{ reward_state: 'settled' }]);
    const coupons = await fixture.database.list<{
      percent: number;
      state: string;
    }>(
      {
        text: `SELECT percent, state FROM referral_coupon WHERE subscriber_id = $1`,
        values: [referrerId],
      },
      5,
    );
    assert.deepEqual(coupons, [{ percent: 10, state: 'held' }]);
    const awards = await fixture.database.readOne<{ count: number }>({
      text: 'SELECT count(*)::int AS count FROM milestone_award WHERE subscriber_id = $1',
      values: [referrerId],
    });
    assert.equal(awards?.count, 0);
  } finally {
    await fixture.dispose();
  }
});

test('a seeded referral-graph property keeps every coupon held, never settled, without an order signal', async () => {
  const fixture = await createDatabaseFixture();
  try {
    await fc.assert(
      fc.asyncProperty(
        // Up to coupon 3's unlock at 39, so every coupon is generated.
        fc.array(fc.integer({ min: 3, max: 42 }), {
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

          const coupons = await fixture.database.list<{ state: string }>(
            {
              text: `
                SELECT state
                FROM referral_coupon
                WHERE subscriber_id = ANY($1::uuid[])
              `,
              values: [referrerIds],
            },
            confirmationCounts.length * couponLadder.unlocks.length,
          );
          assert.equal(
            coupons.length,
            confirmationCounts.reduce(
              (total, count) => total + computeCouponLadder(count).length,
              0,
            ),
          );
          assert.ok(coupons.every((coupon) => coupon.state === 'held'));
          const awards = await fixture.database.readOne<{ count: number }>({
            text: `SELECT count(*)::int AS count FROM milestone_award
                   WHERE subscriber_id = ANY($1::uuid[])`,
            values: [referrerIds],
          });
          assert.equal(awards?.count, 0);
        },
      ),
      { numRuns: 20, seed: 20_260_913 },
    );
  } finally {
    await fixture.dispose();
  }
});
