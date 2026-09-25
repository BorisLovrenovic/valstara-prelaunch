import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createRankingIntegrityService,
  rankingBatchMaximum,
} from '../src/server/referral/ranking.ts';
import { createLeaderboardSnapshotCache } from '../src/server/leaderboard/snapshot.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

interface RankedSubscriberFixture {
  readonly id: string;
  readonly label: string;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e506_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e5-06-test',
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

async function insertSubscriber(
  database: DatabasePool,
  input: {
    readonly confirmedReferrals: number;
    readonly entries: number;
    readonly flagState?: 'dismissed' | 'open' | 'upheld';
    readonly label: string;
    readonly status?: 'disqualified' | 'pending' | 'verified';
    readonly verifiedAt: Date;
    readonly voidedEntries?: number;
  },
): Promise<RankedSubscriberFixture> {
  const id = randomUUID();
  const status = input.status ?? 'verified';
  const email = `${input.label}@ranking.example`;
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status,
        confirmed_referrals, verified_at
      )
      VALUES ($1, $2, $2, 'ranking.example', $3, $4, $5)
    `,
    values: [
      id,
      email,
      status,
      input.confirmedReferrals,
      status === 'pending' ? null : input.verifiedAt,
    ],
  });

  if (input.entries > 0) {
    await database.execute({
      text: `
        INSERT INTO giveaway_entry (
          id, subscriber_id, method, entries, rules_version
        )
        VALUES ($1, $2, 'base', $3, 'ranking-v1')
      `,
      values: [randomUUID(), id, input.entries],
    });
  }
  if ((input.voidedEntries ?? 0) > 0) {
    await database.execute({
      text: `
        INSERT INTO giveaway_entry (
          id, subscriber_id, method, entries, rules_version,
          voided_at
        )
        VALUES ($1, $2, 'referral', $3, 'ranking-v1', $4)
      `,
      values: [randomUUID(), id, input.voidedEntries, input.verifiedAt],
    });
  }

  if (input.flagState !== undefined) {
    await database.execute({
      text: `
        INSERT INTO fraud_flag (
          id, subscriber_id, kind, detail, state, reviewed_by, reviewed_at
        )
        VALUES (
          $1, $2, 'manual', '{"reason":"ranking_fixture"}'::jsonb, $3,
          CASE WHEN $3 = 'open' THEN NULL ELSE 'operator' END,
          CASE WHEN $3 = 'open' THEN NULL ELSE $4::timestamptz END
        )
      `,
      values: [randomUUID(), id, input.flagState, input.verifiedAt],
    });
  }

  return { id, label: input.label };
}

test('E5-06 excludes active flags, disqualified rows and unverified rows from display and prize rankings', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const verifiedAt = new Date('2026-09-17T08:00:00.000Z');
    const included = await insertSubscriber(fixture.database, {
      confirmedReferrals: 30,
      entries: 30,
      label: 'included',
      verifiedAt,
    });
    const dismissed = await insertSubscriber(fixture.database, {
      confirmedReferrals: 20,
      entries: 20,
      flagState: 'dismissed',
      label: 'dismissed',
      verifiedAt,
    });
    const flagged = await insertSubscriber(fixture.database, {
      confirmedReferrals: 100,
      entries: 100,
      flagState: 'open',
      label: 'flagged',
      verifiedAt,
    });
    const disqualified = await insertSubscriber(fixture.database, {
      confirmedReferrals: 90,
      entries: 90,
      label: 'disqualified',
      status: 'disqualified',
      verifiedAt,
    });
    const pending = await insertSubscriber(fixture.database, {
      confirmedReferrals: 80,
      entries: 80,
      label: 'pending',
      status: 'pending',
      verifiedAt,
    });
    const ranking = createRankingIntegrityService(fixture.applicationDatabase);

    assert.deepEqual(await ranking.leaderboardCandidates(20), [
      { confirmedReferrals: 30, rank: 1, subscriberId: included.id },
      { confirmedReferrals: 20, rank: 2, subscriberId: dismissed.id },
    ]);
    assert.deepEqual(await ranking.prizeCandidates(20), [
      { entries: 30, rank: 1, subscriberId: included.id },
      { entries: 20, rank: 2, subscriberId: dismissed.id },
    ]);

    const serialised = JSON.stringify({
      display: await ranking.leaderboardCandidates(20),
      prize: await ranking.prizeCandidates(20),
    });
    for (const excluded of [flagged, disqualified, pending]) {
      assert.doesNotMatch(serialised, new RegExp(excluded.id, 'u'));
      assert.doesNotMatch(serialised, new RegExp(excluded.label, 'u'));
    }
    assert.doesNotMatch(serialised, /excluded|flag|disqualif/iu);
  } finally {
    await fixture.dispose();
  }
});

test('E5-06 ranks after exclusion with contiguous positions and real source counts', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const firstVerified = new Date('2026-09-17T08:00:00.000Z');
    const laterVerified = new Date('2026-09-17T09:00:00.000Z');
    const first = await insertSubscriber(fixture.database, {
      confirmedReferrals: 7,
      entries: 3,
      label: 'first',
      verifiedAt: firstVerified,
      voidedEntries: 500,
    });
    await insertSubscriber(fixture.database, {
      confirmedReferrals: 99,
      entries: 99,
      flagState: 'open',
      label: 'excluded-gap',
      verifiedAt: firstVerified,
    });
    const second = await insertSubscriber(fixture.database, {
      confirmedReferrals: 7,
      entries: 2,
      label: 'second',
      verifiedAt: laterVerified,
    });
    const third = await insertSubscriber(fixture.database, {
      confirmedReferrals: 1,
      entries: 1,
      label: 'third',
      verifiedAt: laterVerified,
    });
    const ranking = createRankingIntegrityService(fixture.applicationDatabase);

    assert.deepEqual(await ranking.leaderboardCandidates(20), [
      { confirmedReferrals: 7, rank: 1, subscriberId: first.id },
      { confirmedReferrals: 7, rank: 2, subscriberId: second.id },
      { confirmedReferrals: 1, rank: 3, subscriberId: third.id },
    ]);
    assert.deepEqual(await ranking.prizeCandidates(20), [
      { entries: 3, rank: 1, subscriberId: first.id },
      { entries: 2, rank: 2, subscriberId: second.id },
      { entries: 1, rank: 3, subscriberId: third.id },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('E5-06 ranking queries require a positive capped limit', async () => {
  const ranking = createRankingIntegrityService({} as DatabasePool);
  await assert.rejects(ranking.leaderboardCandidates(0), RangeError);
  await assert.rejects(
    ranking.prizeCandidates(rankingBatchMaximum + 1),
    RangeError,
  );
});

test('E6-01 snapshots only verified ranked rows, anonymises them, and preserves deterministic ties', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const firstVerified = new Date('2026-09-20T08:00:00.000Z');
    const laterVerified = new Date('2026-09-20T09:00:00.000Z');
    const first = await insertSubscriber(fixture.database, {
      confirmedReferrals: 9,
      entries: 0,
      label: 'snapshot-first',
      verifiedAt: firstVerified,
    });
    const second = await insertSubscriber(fixture.database, {
      confirmedReferrals: 9,
      entries: 0,
      label: 'snapshot-second',
      verifiedAt: laterVerified,
    });
    const pending = await insertSubscriber(fixture.database, {
      confirmedReferrals: 99,
      entries: 0,
      label: 'snapshot-pending',
      status: 'pending',
      verifiedAt: laterVerified,
    });
    const expired = await insertSubscriber(fixture.database, {
      confirmedReferrals: 98,
      entries: 0,
      label: 'snapshot-expired',
      status: 'pending',
      verifiedAt: laterVerified,
    });
    await fixture.database.execute({
      text: "UPDATE subscriber SET status = 'expired' WHERE id = $1",
      values: [expired.id],
    });
    const snapshot = createLeaderboardSnapshotCache(
      createRankingIntegrityService(fixture.applicationDatabase),
      { now: () => new Date('2026-09-20T10:00:00.000Z') },
    );

    const firstRefresh = await snapshot.refresh();
    const secondRefresh = await snapshot.refresh();

    assert.deepEqual(firstRefresh, secondRefresh);
    assert.deepEqual(
      firstRefresh.entries.map(({ confirmedReferrals, rank }) => ({
        confirmedReferrals,
        rank,
      })),
      [
        { confirmedReferrals: 9, rank: 1 },
        { confirmedReferrals: 9, rank: 2 },
      ],
    );
    assert.deepEqual(
      firstRefresh.entries.map((entry) => Object.keys(entry).sort()),
      [
        ['confirmedReferrals', 'displayHandle', 'rank'],
        ['confirmedReferrals', 'displayHandle', 'rank'],
      ],
    );
    const serialised = JSON.stringify(firstRefresh);
    for (const subscriber of [first, second, pending, expired]) {
      assert.doesNotMatch(serialised, new RegExp(subscriber.id, 'u'));
      assert.doesNotMatch(serialised, new RegExp(subscriber.label, 'u'));
    }
    assert.doesNotMatch(
      serialised,
      /email|country|referral.code|verified_at/iu,
    );
  } finally {
    await fixture.dispose();
  }
});
