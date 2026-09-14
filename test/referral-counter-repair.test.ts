import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import fc from 'fast-check';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createReferralCounterRepairJob } from '../src/server/referral/counter-repair.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';

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
  const databaseName = `valstara_e409_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = 'valstara_app';
  applicationUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e4-09-test',
  });
  const applicationDatabase = createPool(applicationUrl.toString());

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
  values: {
    readonly confirmedReferrals?: number;
    readonly referralTier?: number;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, referral_code,
        confirmed_referrals, referral_tier, verified_at
      ) VALUES ($1, $2, $2, 'example.test', 'verified', $3, $4, $5, $6)
    `,
    values: [
      id,
      `${id}@example.test`,
      `REF${id.replaceAll('-', '').slice(0, 9).toUpperCase()}`,
      values.confirmedReferrals ?? 0,
      values.referralTier ?? 0,
      now,
    ],
  });
  return id;
}

async function seedReferralGraph(
  database: DatabasePool,
  countsAndTiers: readonly { readonly count: number; readonly tier: number }[],
): Promise<readonly string[]> {
  const referrers: string[] = [];
  for (const { count, tier } of countsAndTiers) {
    const referrerId = await insertVerifiedSubscriber(database, {
      confirmedReferrals: 997,
      referralTier: 997,
    });
    referrers.push(referrerId);
    for (let index = 0; index < count; index += 1) {
      const referredId = await insertVerifiedSubscriber(database);
      await database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state, confirmed_at
          ) VALUES ($1, $2, $3, 'confirmed', 'settled', $4)
        `,
        values: [randomUUID(), referrerId, referredId, now],
      });
    }
    if (tier > 0) {
      await database.execute({
        text: `
          INSERT INTO milestone_award (
            id, subscriber_id, tier, reward_kind, state, awarded_at
          ) VALUES ($1, $2, $3, 'wave_upgrade', 'settled', $4)
        `,
        values: [randomUUID(), referrerId, tier, now],
      });
    }
  }
  return referrers;
}

async function counterAndTier(
  database: DatabasePool,
  subscriberId: string,
): Promise<{
  readonly confirmed_referrals: number;
  readonly referral_tier: number;
}> {
  const row = await database.readOne<{
    confirmed_referrals: number;
    referral_tier: number;
  }>({
    text: 'SELECT confirmed_referrals, referral_tier FROM subscriber WHERE id = $1',
    values: [subscriberId],
  });
  if (row === null) {
    throw new Error('Expected repaired subscriber to exist.');
  }
  return row;
}

test('a seeded referral-graph property repairs derived counters once and is idempotent', async () => {
  const fixture = await createDatabaseFixture();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            count: fc.integer({ min: 0, max: 6 }),
            tier: fc.integer({ min: 0, max: 4 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (graph) => {
          const referrers = await seedReferralGraph(fixture.database, graph);
          const alerts: unknown[] = [];
          const repair = createReferralCounterRepairJob(
            fixture.applicationDatabase,
            {
              alert(alert) {
                alerts.push(alert);
              },
              clock: () => now,
            },
          );

          const first = await repair.run(1_000);
          assert.equal(first.checked >= graph.length, true);
          assert.equal(first.corrected, graph.length);
          for (const [index, referrerId] of referrers.entries()) {
            assert.deepEqual(
              await counterAndTier(fixture.database, referrerId),
              {
                confirmed_referrals: graph[index]?.count,
                referral_tier: graph[index]?.tier,
              },
            );
          }
          assert.equal(alerts.length, 1);
          assert.equal(
            (alerts[0] as { readonly severity: string }).severity,
            'P2',
          );

          const second = await repair.run(1_000);
          assert.equal(second.corrected, 0);
          assert.equal(alerts.length, 1);
        },
      ),
      { numRuns: 20, seed: 4_090_914 },
    );
  } finally {
    await fixture.dispose();
  }
});

test('a corrupted counter is restored, its correction count is audited, and a P2 alert fires', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const [referrerId] = await seedReferralGraph(fixture.database, [
      { count: 2, tier: 1 },
    ]);
    assert.notEqual(referrerId, undefined);
    const alerts: unknown[] = [];
    const result = await createReferralCounterRepairJob(
      fixture.applicationDatabase,
      {
        alert(alert) {
          alerts.push(alert);
        },
        clock: () => now,
      },
    ).run(10);

    assert.deepEqual(result, { checked: 3, corrected: 1 });
    assert.deepEqual(await counterAndTier(fixture.database, referrerId), {
      confirmed_referrals: 2,
      referral_tier: 1,
    });
    assert.deepEqual(alerts, [
      {
        detail: { checked: 3, corrected: 1 },
        event: 'referral_counters_corrected',
        occurredAt: now,
        severity: 'P2',
      },
    ]);
    assert.deepEqual(
      await fixture.database.readOne<{
        readonly detail: { readonly corrected: number };
      }>({
        text: `
          SELECT detail
          FROM audit_log
          WHERE action = 'referral.counters_repaired'
          ORDER BY at DESC
        `,
      }),
      { detail: { checked: 3, corrected: 1, limit: 10 } },
    );
  } finally {
    await fixture.dispose();
  }
});

test('counter repair honours its batch cap', async () => {
  const fixture = await createDatabaseFixture();
  try {
    await seedReferralGraph(fixture.database, [
      { count: 0, tier: 0 },
      { count: 0, tier: 0 },
    ]);
    const repair = createReferralCounterRepairJob(fixture.applicationDatabase, {
      alert: async () => undefined,
    });

    assert.deepEqual(await repair.run(1), { checked: 1, corrected: 1 });
    await assert.rejects(repair.run(1_001), /no greater than 1000/u);
  } finally {
    await fixture.dispose();
  }
});

test('a real database signup can attribute a referral while counter repair runs', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertVerifiedSubscriber(fixture.database);
    const referrerCode = (
      await fixture.database.readOne<{ readonly referral_code: string }>({
        text: 'SELECT referral_code FROM subscriber WHERE id = $1',
        values: [referrerId],
      })
    )?.referral_code;
    assert.notEqual(referrerCode, undefined);
    const signup = createSignupService(fixture.applicationDatabase, {
      raiseFraudFlag: async () => undefined,
      screenEmailDomain: async () => ({ flags: [] }),
      attributeReferral: (referredId, code, allowAttribution) =>
        createReferralService(fixture.applicationDatabase).attribute(
          referredId,
          code,
          allowAttribution,
        ),
      isReferralEnabled: async () => true,
      sendVerificationMail: async () => undefined,
    });
    const repair = createReferralCounterRepairJob(fixture.applicationDatabase, {
      alert: async () => undefined,
      clock: () => now,
    });

    const [, outcome] = await Promise.all([
      repair.run(1_000),
      signup({
        country: 'SE',
        email: 'concurrent-referral@example.test',
        referralCode: referrerCode,
        verificationUrl: () => 'https://valstara.com/verify',
      }),
    ]);

    assert.equal(outcome.kind, 'created');
    assert.deepEqual(
      await fixture.database.readOne<{ readonly referrer_id: string }>({
        text: 'SELECT referrer_id FROM referral_edge WHERE referred_id = $1',
        values: [outcome.subscriber.id],
      }),
      { referrer_id: referrerId },
    );
  } finally {
    await fixture.dispose();
  }
});
