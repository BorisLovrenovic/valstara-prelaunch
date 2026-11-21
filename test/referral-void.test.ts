import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import type { ChainInfo, RandomnessBeacon } from 'drand-client';

import { createAuditService } from '../src/server/audit/service.ts';
import { openAdminExportSnapshot } from '../src/server/db/admin-export.ts';
import { createGiveawayDrawRepository } from '../src/server/db/giveaway-draw.ts';
import { createGiveawayEntryRepository } from '../src/server/db/giveaway-entry.ts';
import { openHandoffSnapshot } from '../src/server/db/handoff.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createReferralRepository } from '../src/server/db/referral.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { createTopTwentyReviewGate } from '../src/server/fraud/top-twenty-review.ts';
import { createDrawService } from '../src/server/giveaway/draw.ts';
import { createSharedLeaderboardSnapshotStore } from '../src/server/leaderboard/persisted.ts';
import { createRankingIntegrityService } from '../src/server/referral/ranking.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import {
  createReferralVoidService,
  normaliseReferralVoidReason,
  ReferralVoidInputError,
  ReferralVoidRefusedError,
} from '../src/server/referral/void.ts';

import { seedGiveawayEntryRows } from './helpers/giveaway-entry-rows.ts';

const now = new Date('2026-10-20T12:00:00.000Z');
const periodStart = new Date('2026-10-01T00:00:00.000Z');
const periodEnd = new Date('2027-03-02T00:00:00.000Z');
const actor = 'admin.operator';

interface Fixture {
  readonly owner: DatabasePool;
  readonly app: DatabasePool;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const name = `valstara_e1172_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(databaseUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appUrl.password,
    release: 'e11-7-02-test',
  });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    async close() {
      await app.close();
      await owner.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [name],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${name}"` });
      await admin.close();
    },
  };
}

async function subscriber(
  database: DatabasePool,
  options: {
    readonly code?: boolean;
    readonly status?: string;
    readonly verifiedAt?: Date;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const code = options.code
    ? `V${id.replaceAll('-', '').slice(0, 11).toUpperCase()}`
    : null;
  await database.execute({
    text: `INSERT INTO subscriber
             (id, email, email_normalised, email_domain, status, referral_code,
              verified_at)
           VALUES ($1, $2, $2, 'void.test', $3, $4, $5)`,
    values: [
      id,
      `${id}@void.test`,
      options.status ?? 'verified',
      code,
      options.verifiedAt ?? new Date('2026-10-05T00:00:00.000Z'),
    ],
  });
  return id;
}

async function edge(
  database: DatabasePool,
  referrerId: string,
  referredId: string,
  state: 'attributed' | 'confirmed' | 'rejected' = 'confirmed',
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `INSERT INTO referral_edge
             (id, referrer_id, referred_id, state, reward_state, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
    values: [
      id,
      referrerId,
      referredId,
      state,
      state === 'confirmed' ? 'settled' : 'none',
      state === 'confirmed' ? new Date('2026-10-06T00:00:00.000Z') : null,
    ],
  });
  return id;
}

async function entry(
  database: DatabasePool,
  subscriberId: string,
  sourceEdgeId: string | null,
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `INSERT INTO giveaway_entry
             (id, subscriber_id, method, entries, rules_version, rules_sha256,
              source_edge_id)
           VALUES ($1, $2, $3, 1, 'fixture-v1', decode(repeat('ab', 32), 'hex'), $4)`,
    values: [
      id,
      subscriberId,
      sourceEdgeId === null ? 'base' : 'referral',
      sourceEdgeId,
    ],
  });
  return id;
}

/** A referrer with confirmed edges, each with its referral entry. */
async function referrerWith(
  database: DatabasePool,
  confirmed: number,
  verifiedAt?: Date,
): Promise<{ referrerId: string; referredIds: string[]; edgeIds: string[] }> {
  const referrerId = await subscriber(database, { code: true, verifiedAt });
  await entry(database, referrerId, null);
  const referredIds: string[] = [];
  const edgeIds: string[] = [];
  for (let index = 0; index < confirmed; index += 1) {
    const referredId = await subscriber(database);
    const edgeId = await edge(database, referrerId, referredId);
    await entry(database, referrerId, edgeId);
    referredIds.push(referredId);
    edgeIds.push(edgeId);
  }
  return { referrerId, referredIds, edgeIds };
}

function displayHandle(id: string): string {
  return createHash('sha256').update(id).digest('base64url').slice(0, 12);
}

/** Every consumer of the confirmed count, and of the entry ledger. */
async function measure(f: Fixture, referrerId: string) {
  const referral = createReferralService(f.app);
  const ranking = createRankingIntegrityService(f.app);
  const counter = await f.app.readOne<{ confirmed_referrals: number }>({
    text: 'SELECT confirmed_referrals FROM subscriber WHERE id = $1',
    values: [referrerId],
  });
  const status = await referral.status(referrerId);
  const leaderboard = (await ranking.leaderboardCandidates(1_000)).find(
    (candidate) => candidate.subscriberId === referrerId,
  );
  const snapshot = await createSharedLeaderboardSnapshotStore(
    f.app,
    ranking,
    () => now,
  ).refresh();
  const snapshotEntry = snapshot.entries.find(
    (candidate) => candidate.displayHandle === displayHandle(referrerId),
  );
  const prize = (await ranking.prizeCandidates(1_000)).find(
    (candidate) => candidate.subscriberId === referrerId,
  );
  const handoff = await openHandoffSnapshot(f.app);
  let handoffPairs: number;
  let handoffCount: number;
  let handoffCustomerCount: number | undefined;
  try {
    handoffCount = handoff.referralCount;
    handoffPairs = (await handoff.referrals(null)).length;
    handoffCustomerCount = (await handoff.customers(null)).find(
      (row) => row.id === referrerId,
    )?.confirmed_referrals;
  } finally {
    await handoff.close();
  }
  const exportSnapshot = await openAdminExportSnapshot(f.app);
  let exportCount: number | undefined;
  try {
    exportCount = (await exportSnapshot.page(null, 500)).find(
      (row) => row.id === referrerId,
    )?.confirmed_referrals;
  } finally {
    await exportSnapshot.close();
  }
  const ledger = (
    await createGiveawayDrawRepository(f.app).ledgerPage(null)
  ).filter((row) => row.subscriber_id === referrerId).length;
  const entitlements = (
    await createGiveawayEntryRepository(f.app).missingEntitlements(
      periodStart,
      periodEnd,
      100,
    )
  ).length;
  const backfill = (
    await createReferralRepository(f.app).findMilestoneBackfillCandidateIds(
      1,
      3,
      100,
    )
  ).includes(referrerId);
  const repair = await referral.recomputeCounters(1_000);
  return {
    counter: counter?.confirmed_referrals,
    status: status.confirmedReferrals,
    statusEntries: status.giveawayEntries,
    ownRank: status.ownRank,
    leaderboard: leaderboard && {
      score: leaderboard.confirmedReferrals,
      rank: leaderboard.rank,
    },
    snapshot: snapshotEntry && {
      score: snapshotEntry.confirmedReferrals,
      rank: snapshotEntry.rank,
    },
    prizeEntries: prize?.entries,
    handoffCount,
    handoffPairs,
    handoffCustomerCount,
    exportCount,
    ledger,
    entitlements,
    backfill,
    repairCorrections: repair.corrected,
  };
}

test('a void removes one referral from every count, and an un-void restores each one exactly', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  // B verified first, so it wins a tie: the void moves A below B.
  const b = await referrerWith(
    f.owner,
    2,
    new Date('2026-10-02T00:00:00.000Z'),
  );
  const a = await referrerWith(f.owner, 3);
  await createReferralService(f.app).recomputeCounters(1_000);
  const service = createReferralVoidService(f.app, () => now);

  const before = await measure(f, a.referrerId);
  assert.deepEqual(
    {
      counter: before.counter,
      leaderboard: before.leaderboard,
      snapshot: before.snapshot,
      prizeEntries: before.prizeEntries,
      handoffPairs: before.handoffPairs,
      backfill: before.backfill,
      repairCorrections: before.repairCorrections,
    },
    {
      counter: 3,
      leaderboard: { score: 3, rank: 1 },
      snapshot: { score: 3, rank: 1 },
      prizeEntries: 4,
      handoffPairs: 5,
      backfill: true,
      repairCorrections: 0,
    },
  );

  const voided = await service.voidReferral(
    a.referredIds[0]!,
    'Same household, confirmed by the founder',
    actor,
  );
  assert.equal(voided.referrerConfirmedReferrals, 2);
  assert.equal(voided.giveawayEntry, 'voided');
  const during = await measure(f, a.referrerId);
  assert.deepEqual(during, {
    ...before,
    counter: 2,
    status: 2,
    statusEntries: before.statusEntries - 1,
    ownRank: 2,
    leaderboard: { score: 2, rank: 2 },
    snapshot: { score: 2, rank: 2 },
    prizeEntries: 3,
    handoffCount: before.handoffCount - 1,
    handoffPairs: before.handoffPairs - 1,
    handoffCustomerCount: 2,
    exportCount: 2,
    ledger: before.ledger - 1,
    backfill: false,
    // The counter was recomputed in the void transaction; repair finds
    // nothing to correct, and so raises no alert.
    repairCorrections: 0,
  });

  // The voided edge is kept with its reason, actor and time.
  const kept = await f.owner.readOne<{
    state: string;
    voided_at: Date;
    void_reason: string;
    voided_by: string;
  }>({
    text: 'SELECT state, voided_at, void_reason, voided_by FROM referral_edge WHERE id = $1',
    values: [a.edgeIds[0]],
  });
  assert.deepEqual(kept, {
    state: 'confirmed',
    voided_at: now,
    void_reason: 'Same household, confirmed by the founder',
    voided_by: actor,
  });

  // Counter repair, run over a corrupted counter, restores the non-voided
  // count rather than the raw confirmed count.
  await f.owner.execute({
    text: 'UPDATE subscriber SET confirmed_referrals = 3 WHERE id = $1',
    values: [a.referrerId],
  });
  assert.equal(
    (await createReferralService(f.app).recomputeCounters(1_000)).corrected,
    1,
  );
  assert.equal((await measure(f, a.referrerId)).counter, 2);

  const restored = await service.unvoidReferral(
    a.referredIds[0]!,
    'Founder re-checked: two different people',
    actor,
  );
  assert.equal(restored.referrerConfirmedReferrals, 3);
  assert.equal(restored.giveawayEntry, 'restored');
  assert.deepEqual(await measure(f, a.referrerId), before);
  // The other referrer is untouched throughout.
  assert.equal((await measure(f, b.referrerId)).counter, 2);
});

test('a void needs a reason and a human actor, in the service and in the database', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await referrerWith(f.owner, 1);
  const service = createReferralVoidService(f.app, () => now);
  const referredId = a.referredIds[0]!;

  for (const reason of [
    '',
    '   ',
    'x'.repeat(201),
    'two\nlines',
    'Same person as someone@example.test',
    'Signed up from 203.0.113.7',
  ]) {
    await assert.rejects(
      service.voidReferral(referredId, reason, actor),
      ReferralVoidInputError,
      JSON.stringify(reason),
    );
    await assert.rejects(
      service.unvoidReferral(referredId, reason, actor),
      ReferralVoidInputError,
    );
  }
  assert.equal(normaliseReferralVoidReason('  Bulk signups  '), 'Bulk signups');
  assert.equal(normaliseReferralVoidReason('x'.repeat(200)).length, 200);
  for (const badActor of ['', ' ', 'system:referral-confirmation']) {
    await assert.rejects(
      service.voidReferral(referredId, 'Bulk signups', badActor),
      ReferralVoidInputError,
    );
  }
  await assert.rejects(
    service.voidReferral('not-a-uuid', 'Bulk signups', actor),
    ReferralVoidInputError,
  );

  // The database refuses a void without a reason or a human actor, even from
  // the application role writing the columns directly.
  for (const [reason, by] of [
    [null, actor],
    ['  ', actor],
    ['Bulk signups', null],
    ['Bulk signups', 'system:sweep'],
    ['x'.repeat(201), actor],
  ] as const) {
    await assert.rejects(
      f.app.execute({
        text: `UPDATE referral_edge SET voided_at = $2, void_reason = $3,
                 voided_by = $4 WHERE id = $1`,
        values: [a.edgeIds[0], now, reason, by],
      }),
      /referral_edge_void_recorded/u,
    );
  }
  await assert.rejects(
    f.app.execute({
      text: `UPDATE referral_edge SET void_reason = 'stray' WHERE id = $1`,
      values: [a.edgeIds[0]],
    }),
    /referral_edge_void_recorded/u,
  );
  // An entry marked as voided by a referral void must actually be void.
  await assert.rejects(
    f.app.execute({
      text: `UPDATE giveaway_entry SET voided_by_referral_void = true
             WHERE source_edge_id = $1`,
      values: [a.edgeIds[0]],
    }),
    /giveaway_entry_referral_void_shape/u,
  );
  const untouched = await f.owner.readOne<{ voided_at: Date | null }>({
    text: 'SELECT voided_at FROM referral_edge WHERE id = $1',
    values: [a.edgeIds[0]],
  });
  assert.equal(untouched?.voided_at, null);
});

test('every void and un-void writes the audit log with before and after values; a refusal writes nothing', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await referrerWith(f.owner, 2);
  await createReferralService(f.app).recomputeCounters(1_000);
  const service = createReferralVoidService(f.app, () => now);
  const referredId = a.referredIds[1]!;

  await service.voidReferral(referredId, 'Bulk signups', actor);
  await assert.rejects(
    service.voidReferral(referredId, 'Bulk signups', actor),
    (error: unknown) =>
      error instanceof ReferralVoidRefusedError &&
      error.refusal === 'already_voided',
  );
  await service.unvoidReferral(referredId, 'Cleared on appeal', actor);
  await assert.rejects(
    service.unvoidReferral(referredId, 'Cleared on appeal', actor),
    (error: unknown) =>
      error instanceof ReferralVoidRefusedError &&
      error.refusal === 'not_voided',
  );

  const audit = createAuditService(f.app);
  const records = await audit.query({ subjectId: a.edgeIds[1] }, 10);
  assert.deepEqual(
    [...records]
      .sort((left, right) => left.at.getTime() - right.at.getTime())
      .map((record) => ({
        action: record.action,
        actor: record.actor,
        subjectType: record.subjectType,
        detail: record.detail,
      })),
    [
      {
        action: 'referral.voided',
        actor,
        subjectType: 'referral_edge',
        detail: {
          reason: 'Bulk signups',
          referrer_id: a.referrerId,
          referred_id: referredId,
          draw_snapshot_committed: false,
          giveaway_entry: 'voided',
          before: {
            voided_at: null,
            void_reason: null,
            voided_by: null,
            referrer_confirmed_referrals: 2,
            giveaway_entry_voided: false,
          },
          after: {
            voided_at: now.toISOString(),
            void_reason: 'Bulk signups',
            voided_by: actor,
            referrer_confirmed_referrals: 1,
            giveaway_entry_voided: true,
          },
        },
      },
      {
        action: 'referral.unvoided',
        actor,
        subjectType: 'referral_edge',
        detail: {
          reason: 'Cleared on appeal',
          referrer_id: a.referrerId,
          referred_id: referredId,
          draw_snapshot_committed: false,
          giveaway_entry: 'restored',
          before: {
            voided_at: now.toISOString(),
            void_reason: 'Bulk signups',
            voided_by: actor,
            referrer_confirmed_referrals: 1,
            giveaway_entry_voided: true,
          },
          after: {
            voided_at: null,
            void_reason: null,
            voided_by: null,
            referrer_confirmed_referrals: 2,
            giveaway_entry_voided: false,
          },
        },
      },
    ],
  );
});

test('a referral that cannot be changed is refused without any write', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const service = createReferralVoidService(f.app, () => now);
  const refusal = (expected: string) => (error: unknown) =>
    error instanceof ReferralVoidRefusedError && error.refusal === expected;

  await assert.rejects(
    service.voidReferral(randomUUID(), 'Bulk signups', actor),
    refusal('not_found'),
  );
  const unreferred = await subscriber(f.owner);
  await assert.rejects(
    service.voidReferral(unreferred, 'Bulk signups', actor),
    refusal('not_found'),
  );

  const rejected = await subscriber(f.owner, { code: true });
  const rejectedReferred = await subscriber(f.owner);
  await edge(f.owner, rejected, rejectedReferred, 'rejected');
  await assert.rejects(
    service.voidReferral(rejectedReferred, 'Bulk signups', actor),
    refusal('not_changeable'),
  );

  for (const status of ['disqualified', 'erasure_pending']) {
    const a = await referrerWith(f.owner, 1);
    // A pending erasure and its durable request must commit together.
    await withTransaction(f.owner, async (connection) => {
      if (status === 'erasure_pending')
        await connection.execute({
          text: `INSERT INTO dsr_erasure (subscriber_id, requested_at, next_attempt_at)
                 VALUES ($1, $2, $2)`,
          values: [a.referrerId, now],
        });
      await connection.execute({
        text: 'UPDATE subscriber SET status = $2 WHERE id = $1',
        values: [a.referrerId, status],
      });
    });
    await assert.rejects(
      service.voidReferral(a.referredIds[0]!, 'Bulk signups', actor),
      refusal('not_changeable'),
      status,
    );
  }

  const voidedRows = await f.owner.readOne<{ count: number }>({
    text: `SELECT
             (SELECT count(*) FROM referral_edge WHERE voided_at IS NOT NULL)
           + (SELECT count(*) FROM giveaway_entry WHERE voided_by_referral_void)
           + (SELECT count(*) FROM audit_log WHERE action LIKE 'referral.%void%')
             AS count`,
  });
  assert.equal(Number(voidedRows?.count), 0);
});

test('before the draw snapshot is committed, a void voids the entry and an un-void restores it', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await referrerWith(f.owner, 2);
  const service = createReferralVoidService(f.app, () => now);
  const entries = createGiveawayEntryRepository(f.app);

  await service.voidReferral(a.referredIds[0]!, 'Bulk signups', actor);
  const voidedEntry = await f.owner.readOne<{
    voided_at: Date | null;
    voided_by_referral_void: boolean;
  }>({
    text: `SELECT voided_at, voided_by_referral_void FROM giveaway_entry
           WHERE source_edge_id = $1`,
    values: [a.edgeIds[0]],
  });
  assert.deepEqual(voidedEntry, {
    voided_at: now,
    voided_by_referral_void: true,
  });
  // A voided edge neither keeps nor re-earns an entry.
  assert.equal(await entries.confirmedEdgeFor(a.referredIds[0]!), null);
  assert.equal(
    await entries.confirmedEdgeBelongsTo(
      a.edgeIds[0]!,
      a.referrerId,
      periodStart,
      periodEnd,
    ),
    false,
  );

  await service.unvoidReferral(a.referredIds[0]!, 'Cleared', actor);
  const restoredEntry = await f.owner.readOne<{
    voided_at: Date | null;
    voided_by_referral_void: boolean;
  }>({
    text: `SELECT voided_at, voided_by_referral_void FROM giveaway_entry
           WHERE source_edge_id = $1`,
    values: [a.edgeIds[0]],
  });
  assert.deepEqual(restoredEntry, {
    voided_at: null,
    voided_by_referral_void: false,
  });

  // An entry another decision voided is left as it was, and is not restored.
  await f.owner.execute({
    text: `UPDATE giveaway_entry SET voided_at = $2 WHERE source_edge_id = $1`,
    values: [a.edgeIds[1], new Date('2026-10-10T00:00:00.000Z')],
  });
  assert.equal(
    (await service.voidReferral(a.referredIds[1]!, 'Bulk signups', actor))
      .giveawayEntry,
    'unchanged',
  );
  assert.equal(
    (await service.unvoidReferral(a.referredIds[1]!, 'Cleared', actor))
      .giveawayEntry,
    'unchanged',
  );
  const stillVoided = await f.owner.readOne<{ voided_at: Date | null }>({
    text: 'SELECT voided_at FROM giveaway_entry WHERE source_edge_id = $1',
    values: [a.edgeIds[1]],
  });
  assert.deepEqual(
    stillVoided?.voided_at,
    new Date('2026-10-10T00:00:00.000Z'),
  );

  // A confirmed edge voided before its entry accrued is not an entitlement
  // while voided, and becomes one again on un-void, for the reconciliation.
  const referredId = await subscriber(f.owner);
  const edgeId = await edge(f.owner, a.referrerId, referredId);
  const missing = async () =>
    (await entries.missingEntitlements(periodStart, periodEnd, 100))
      .filter((row) => row.method === 'referral')
      .map((row) => row.sourceEdgeId);
  assert.deepEqual(await missing(), [edgeId]);
  assert.equal(
    (await service.voidReferral(referredId, 'Bulk signups', actor))
      .giveawayEntry,
    'none',
  );
  assert.deepEqual(await missing(), []);
  await service.unvoidReferral(referredId, 'Cleared', actor);
  assert.deepEqual(await missing(), [edgeId]);
});

const chainInfo: ChainInfo = {
  public_key:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: { beaconID: 'quicknet' },
};
const beacon: RandomnessBeacon = {
  round: 101,
  randomness:
    '966d0eee13f38469fa8a5f8d06f1d9c4cc65c96d18730510109b681f4c0296f0',
  signature:
    '8e4812d08192220e1f7822bae97d7a2f196c73c421927c28d39257b3792b986674e4395323c78dc2a93041e3fc1eaa22',
};
const commitAt = new Date(chainInfo.genesis_time * 1000);

test('after the draw snapshot is committed, a void changes nothing in the draw, which still reproduces and publishes', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const entrants: string[] = [];
  for (const [label, count] of [
    ['one', 4],
    ['two', 3],
    ['three', 2],
  ] as const) {
    const id = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
             VALUES ($1, $2, $2, 'draw.test', 'verified')`,
      values: [id, `${label}@draw.test`],
    });
    await seedGiveawayEntryRows(f.owner, id, count);
    entrants.push(id);
  }
  const edgesOfOne = await f.owner.list<{ id: string; referred_id: string }>(
    {
      text: `SELECT id::text, referred_id::text FROM referral_edge
             WHERE referrer_id = $1 ORDER BY id`,
      values: [entrants[0]],
    },
    10,
  );
  const service = createReferralVoidService(f.app, () => now);

  // Voided before commitment: its entry leaves the snapshot.
  const early = edgesOfOne[0]!;
  assert.equal(
    (await service.voidReferral(early.referred_id, 'Bulk signups', actor))
      .giveawayEntry,
    'voided',
  );

  await createTopTwentyReviewGate(f.app).reviewCurrentTopTwenty(
    entrants.map((subscriberId) => ({ subscriberId, outcome: 'cleared' })),
    'operator',
  );
  const clock = { value: commitAt };
  const draws = createDrawService(
    f.app,
    { isEnabled: async () => true },
    { send: async () => undefined },
    {
      clock: () => clock.value,
      config: {
        chainHash: chainInfo.hash,
        publicKey: chainInfo.public_key,
        relays: ['https://relay-one.test', 'https://relay-two.test'],
      },
      currentRules: async () => ({
        prizeCount: 2,
        rulesVersion: 'fixture-v1',
        rulesSha256: 'ab'.repeat(32),
        bundleContentsListed: true,
      }),
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/info')) return Response.json(chainInfo);
        if (url.endsWith('/public/latest'))
          return Response.json({ ...beacon, round: 100 });
        return Response.json(beacon);
      },
      periodStart,
      drawOpensAt: commitAt,
      reconcile: async () => undefined,
    },
  );
  const commitment = await draws.executeDraw('operator');
  const evidence = async () => ({
    draw: await f.owner.readOne<{
      entry_snapshot_hash: Buffer;
      snapshot_count: number;
    }>({
      text: 'SELECT entry_snapshot_hash, snapshot_count FROM giveaway_draw WHERE id = $1',
      values: [commitment.id],
    }),
    rows: await f.owner.list<{ entry_id: string }>(
      {
        text: `SELECT entry_id::text FROM giveaway_draw_snapshot_row
               WHERE draw_id = $1 ORDER BY entry_id`,
        values: [commitment.id],
      },
      100,
    ),
    ledger: await f.owner.list<{ id: string; voided_at: Date | null }>(
      {
        text: 'SELECT id::text, voided_at FROM giveaway_entry ORDER BY id',
      },
      100,
    ),
  });
  const committed = await evidence();
  assert.equal(Number(committed.draw?.snapshot_count), 8);

  // Voided after commitment: the edge is voided, the giveaway is not touched.
  const late = edgesOfOne[1]!;
  const afterVoid = await service.voidReferral(
    late.referred_id,
    'Bulk signups',
    actor,
  );
  assert.equal(afterVoid.giveawayEntry, 'draw_committed');
  assert.equal(afterVoid.referrerConfirmedReferrals, 1);
  // Un-voiding the early edge after commitment leaves its entry voided too.
  assert.equal(
    (await service.unvoidReferral(early.referred_id, 'Cleared', actor))
      .giveawayEntry,
    'draw_committed',
  );
  assert.deepEqual(await evidence(), committed);

  clock.value = new Date(commitment.targetRoundAt.getTime() + 1_000);
  assert.equal(await draws.advancePending(), true);
  assert.equal(await draws.reproduceDraw(commitment.id), true);
  const published = await f.owner.readOne<{ state: string }>({
    text: 'SELECT state FROM giveaway_draw WHERE id = $1',
    values: [commitment.id],
  });
  assert.equal(published?.state, 'published');
});

test('concurrent voids of one referral record exactly one void, and a void racing a confirmation keeps the count exact', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await referrerWith(f.owner, 2);
  await createReferralService(f.app).recomputeCounters(1_000);
  const service = createReferralVoidService(f.app, () => now);

  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      service.voidReferral(a.referredIds[0]!, 'Bulk signups', actor),
    ),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      assert.ok(outcome.reason instanceof ReferralVoidRefusedError);
      assert.equal(outcome.reason.refusal, 'already_voided');
    }
  }
  const audits = await f.owner.readOne<{ count: number }>({
    text: `SELECT count(*)::int AS count FROM audit_log WHERE action = 'referral.voided'`,
  });
  assert.equal(audits?.count, 1);

  // Concurrent confirmations of new referrals while another edge is voided.
  const pending: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const referredId = await subscriber(f.owner);
    await edge(f.owner, a.referrerId, referredId, 'attributed');
    pending.push(referredId);
  }
  const referral = createReferralService(f.app, {
    milestoneEmail: async () => false,
  });
  await Promise.all([
    ...pending.map((referredId) => referral.confirm(referredId, now)),
    service.voidReferral(a.referredIds[1]!, 'Bulk signups', actor),
  ]);
  const counts = await f.owner.readOne<{ cached: number; edges: number }>({
    text: `SELECT
             (SELECT confirmed_referrals FROM subscriber WHERE id = $1) AS cached,
             (SELECT count(*)::int FROM referral_edge WHERE referrer_id = $1
                AND state = 'confirmed' AND voided_at IS NULL) AS edges`,
    values: [a.referrerId],
  });
  assert.deepEqual(counts, { cached: 4, edges: 4 });
  assert.equal(
    (await createReferralService(f.app).recomputeCounters(1_000)).corrected,
    0,
  );
});
