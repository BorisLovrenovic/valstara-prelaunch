import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  milestoneReachedAtConfirmation,
  milestoneTiers,
  type MilestoneTier,
} from '../src/server/referral/config.ts';
import {
  createReferralService,
  milestoneBackfillMaximumLimit,
} from '../src/server/referral/service.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-13T12:00:00.000Z');
const enabledTierTwo: MilestoneTier = {
  ...milestoneTiers[1]!,
  enabled: true,
};
const ladderWithTierTwo = [milestoneTiers[0]!, enabledTierTwo] as const;

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

async function seedConfirmedEdge(
  database: DatabasePool,
  referrerId: string,
): Promise<void> {
  const referredId = await insertVerifiedSubscriber(database);
  await database.execute({
    text: `
      INSERT INTO referral_edge (
        id, referrer_id, referred_id, state, reward_state, confirmed_at
      )
      VALUES ($1, $2, $3, 'confirmed', 'settled', $4)
    `,
    values: [randomUUID(), referrerId, referredId, now],
  });
}

async function confirmNextEdge(
  database: DatabasePool,
  referrerId: string,
  tiers: readonly MilestoneTier[],
): Promise<void> {
  const referredId = await insertVerifiedSubscriber(database);
  await database.execute({
    text: `
      INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
      VALUES ($1, $2, $3, 'attributed', 'none')
    `,
    values: [randomUUID(), referrerId, referredId],
  });
  await createReferralService(database, { tiers }).confirm(referredId, now);
}

test('the configured ladder awards only on the confirmation that reaches a threshold', () => {
  assert.equal(milestoneTiers[0]?.enabled, true);
  assert.equal(milestoneTiers[1]?.enabled, false);
  assert.equal(milestoneReachedAtConfirmation(3, milestoneTiers)?.number, 1);
  assert.equal(milestoneReachedAtConfirmation(4, milestoneTiers), null);
  assert.equal(milestoneReachedAtConfirmation(5, ladderWithTierTwo)?.number, 2);
  assert.equal(milestoneReachedAtConfirmation(6, ladderWithTierTwo), null);
});

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

test('concurrent confirmations cannot skip or duplicate a tier threshold', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertVerifiedSubscriber(fixture.database);
    await seedConfirmedEdge(fixture.database, referrerId);
    const referredIds = await Promise.all([
      insertVerifiedSubscriber(fixture.database),
      insertVerifiedSubscriber(fixture.database),
    ]);
    for (const referredId of referredIds) {
      await fixture.database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state
          ) VALUES ($1, $2, $3, 'attributed', 'none')
        `,
        values: [randomUUID(), referrerId, referredId],
      });
    }

    const referral = createReferralService(fixture.database);
    await Promise.all(
      referredIds.map((referredId) => referral.confirm(referredId, now)),
    );

    assert.deepEqual(
      await fixture.database.readOne({
        text: 'SELECT confirmed_referrals, referral_tier FROM subscriber WHERE id = $1',
        values: [referrerId],
      }),
      { confirmed_referrals: 3, referral_tier: 1 },
    );
    assert.equal(
      (
        await fixture.database.readOne<{ count: string }>({
          text: `
            SELECT COUNT(*)::text AS count
            FROM milestone_award
            WHERE subscriber_id = $1 AND tier = 1
          `,
          values: [referrerId],
        })
      )?.count,
      '3',
    );
  } finally {
    await fixture.dispose();
  }
});

test('enabling a tier does not reward subscribers who already passed it without an audited backfill', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertVerifiedSubscriber(fixture.database);
    await fixture.database.execute({
      text: `
        UPDATE subscriber
        SET referral_tier = 1, confirmed_referrals = 5, access_window = 'wave-2'
        WHERE id = $1
      `,
      values: [referrerId],
    });
    await fixture.database.execute({
      text: `
        INSERT INTO milestone_award (
          id, subscriber_id, tier, reward_kind, state, awarded_at
        ) VALUES ($1, $2, 1, 'wave_upgrade', 'settled', $3)
      `,
      values: [randomUUID(), referrerId, now],
    });
    for (let index = 0; index < 5; index += 1) {
      await seedConfirmedEdge(fixture.database, referrerId);
    }

    await confirmNextEdge(fixture.database, referrerId, ladderWithTierTwo);

    assert.equal(
      await fixture.database.readOne({
        text: 'SELECT id FROM milestone_award WHERE subscriber_id = $1 AND tier = 2',
        values: [referrerId],
      }),
      null,
    );

    const referral = createReferralService(fixture.database, {
      tiers: ladderWithTierTwo,
    });
    assert.deepEqual(await referral.backfillTier(2, 'operator-1', 10, now), {
      awarded: 1,
      checked: 1,
    });

    const awards = await fixture.database.list<{
      reward_kind: string;
      state: string;
    }>(
      {
        text: `
          SELECT reward_kind, state
          FROM milestone_award
          WHERE subscriber_id = $1 AND tier = 2
          ORDER BY reward_kind
        `,
        values: [referrerId],
      },
      3,
    );
    assert.deepEqual(awards, [
      { reward_kind: 'discount', state: 'held' },
      { reward_kind: 'entries', state: 'held' },
      { reward_kind: 'wave_upgrade', state: 'settled' },
    ]);
    assert.deepEqual(
      await fixture.database.readOne({
        text: 'SELECT referral_tier, access_window FROM subscriber WHERE id = $1',
        values: [referrerId],
      }),
      { access_window: 'wave-1', referral_tier: 2 },
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `
          SELECT actor, detail
          FROM audit_log
          WHERE action = 'referral.access_window_promoted'
        `,
      }),
      {
        actor: 'operator-1',
        detail: {
          fromTier: 1,
          fromWindow: 'wave-2',
          toTier: 2,
          toWindow: 'wave-1',
        },
      },
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `
          SELECT actor, detail
          FROM audit_log
          WHERE action = 'referral.milestone_backfilled'
        `,
      }),
      {
        actor: 'operator-1',
        detail: { awarded: 1, checked: 1, limit: 10 },
      },
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

    await confirmNextEdge(fixture.database, referrerId, ladderWithTierTwo);

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

test('milestone backfill requires an actor and enforces its batch cap', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referral = createReferralService(fixture.database, {
      tiers: ladderWithTierTwo,
    });
    await assert.rejects(
      referral.backfillTier(2, ' ', 1, now),
      /requires a human actor/u,
    );
    await assert.rejects(
      referral.backfillTier(
        2,
        'operator-1',
        milestoneBackfillMaximumLimit + 1,
        now,
      ),
      /limit must be between/u,
    );
  } finally {
    await fixture.dispose();
  }
});
