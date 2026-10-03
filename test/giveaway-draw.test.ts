import { createErasureService } from '../src/server/dsr/service.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ChainInfo, RandomnessBeacon } from 'drand-client';

import type { DrandConfiguration } from '../src/server/config.ts';
import { BeaconUnavailableError } from '../src/server/giveaway/beacon.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createTopTwentyReviewGate } from '../src/server/fraud/top-twenty-review.ts';
import { currentDrawRulesFromFiles } from '../src/server/giveaway/current-draw-rules.ts';
import {
  createDrawService,
  DrawRefusedError,
} from '../src/server/giveaway/draw.ts';
import type {
  Alert,
  AlertTransport,
} from '../src/server/verification-rate/p1-webhook.ts';

import { seedGiveawayEntryRows } from './helpers/giveaway-entry-rows.ts';

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
const drand: DrandConfiguration = {
  chainHash: chainInfo.hash,
  publicKey: chainInfo.public_key,
  relays: ['https://relay-one.test', 'https://relay-two.test'],
};
const originalCommit = new Date(chainInfo.genesis_time * 1000);

interface Fixture {
  readonly owner: DatabasePool;
  readonly app: DatabasePool;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const name = `valstara_e705_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e7-05-test',
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

async function entrant(
  database: DatabasePool,
  label: string,
  count: number,
): Promise<string> {
  const id = randomUUID();
  const email = `${label}@draw.test`;
  await database.execute({
    text: `INSERT INTO subscriber
             (id, email, email_normalised, email_domain, status)
           VALUES ($1, $2, $2, 'draw.test', 'verified')`,
    values: [id, email],
  });
  await seedGiveawayEntryRows(database, id, count);
  return id;
}

function relayRequest(state: {
  outage: boolean;
  latestRound: number;
  calls: number;
}): typeof fetch {
  return async (input) => {
    const url = String(input);
    state.calls += 1;
    if (url.endsWith('/info')) return Response.json(chainInfo);
    if (url.endsWith('/public/latest')) {
      return Response.json({ ...beacon, round: state.latestRound });
    }
    if (state.outage && url.includes('relay-two'))
      throw new Error('relay unavailable');
    return Response.json(beacon);
  };
}

async function reviewedEntrants(f: Fixture): Promise<readonly string[]> {
  const ids = await Promise.all([
    entrant(f.owner, 'one', 3),
    entrant(f.owner, 'two', 2),
    entrant(f.owner, 'three', 1),
  ]);
  const gate = createTopTwentyReviewGate(f.app);
  await gate.reviewCurrentTopTwenty(
    ids.map((subscriberId) => ({ subscriberId, outcome: 'cleared' })),
    'operator',
  );
  return ids;
}

function setup(
  f: Fixture,
  state: { outage: boolean; latestRound: number; calls: number },
  alerts: Alert[],
  now: { value: Date },
  flagEnabled = true,
  bundleContentsListed = true,
) {
  const transport: AlertTransport = {
    send: async (alert) => {
      alerts.push(alert);
    },
  };
  return createDrawService(
    f.app,
    { isEnabled: async () => flagEnabled },
    transport,
    {
      clock: () => now.value,
      config: drand,
      currentRules: async () => ({
        prizeCount: 2,
        rulesVersion: 'fixture-v1',
        rulesSha256: 'ab'.repeat(32),
        bundleContentsListed,
      }),
      fetch: relayRequest(state),
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      drawOpensAt: originalCommit,
      reconcile: async () => undefined,
    },
  );
}

test('E7-05 commits the ledger before the seed, retries a relay outage, then publishes only a reproducible draw', async () => {
  const f = await fixture();
  try {
    const ids = await reviewedEntrants(f);
    const state = { outage: true, latestRound: 100, calls: 0 };
    const alerts: Alert[] = [];
    const now = { value: originalCommit };
    const service = setup(f, state, alerts, now);
    const commitment = await service.executeDraw('operator');
    assert.equal(commitment.targetRound, 101);
    assert.equal(
      commitment.targetRoundAt.getTime() - originalCommit.getTime(),
      300_000,
    );
    const pending = await f.owner.readOne<{
      entry_snapshot_hash: Buffer;
      seed: string | null;
      snapshot_committed_at: Date;
      target_round: string;
      state: string;
    }>({
      text: 'SELECT * FROM giveaway_draw WHERE id = $1',
      values: [commitment.id],
    });
    assert.equal(pending?.seed, null);
    assert.equal(pending?.state, 'pending');
    assert.equal(Number(pending?.target_round), 101);
    assert.equal(pending?.entry_snapshot_hash.length, 32);
    await assert.rejects(service.executeDraw('operator'), DrawRefusedError);
    await assert.rejects(
      f.app.execute({
        text: `INSERT INTO giveaway_entry
               (id, subscriber_id, method, entries, rules_version, rules_sha256)
             VALUES ($1, $2, 'base', 1, 'fixture-v1', decode(repeat('ab', 32), 'hex'))`,
        values: [randomUUID(), ids[0]],
      }),
      /entries are closed/u,
    );

    now.value = new Date(commitment.targetRoundAt.getTime() + 1_000);
    assert.equal(await service.advancePending(), false);
    const stillPending = await f.owner.readOne<{
      seed: string | null;
      attempt_count: number;
      next_attempt_at: Date;
    }>({
      text: 'SELECT seed, attempt_count, next_attempt_at FROM giveaway_draw WHERE id = $1',
      values: [commitment.id],
    });
    assert.equal(stillPending?.seed, null);
    assert.equal(stillPending?.attempt_count, 1);
    assert.equal(alerts[0]?.severity, 'P1');
    assert.equal(alerts[0]?.event, 'giveaway_draw_pending');

    state.outage = false;
    now.value = new Date(stillPending!.next_attempt_at.getTime() + 1_000);
    assert.equal(await service.advancePending(), true);
    const result = await f.owner.readOne<{
      state: string;
      seed: string;
      seed_generated_at: Date;
      snapshot_committed_at: Date;
      reproduced_at: Date;
      winners: string[];
      beacon_relay_used: string;
      beacon_verified_relays: string[];
    }>({
      text: 'SELECT * FROM giveaway_draw WHERE id = $1',
      values: [commitment.id],
    });
    assert.equal(result?.state, 'published');
    assert.ok(result!.seed_generated_at > result!.snapshot_committed_at);
    assert.ok(result?.reproduced_at);
    assert.equal(result?.winners.length, 2);
    assert.equal(new Set(result?.winners).size, 2);
    assert.equal(result?.beacon_relay_used, drand.relays[0]);
    assert.deepEqual(result?.beacon_verified_relays, drand.relays);
    const selections = await f.owner.list<{
      subscriber_id: string;
      is_winner: boolean;
    }>(
      {
        text: `SELECT subscriber_id::text, is_winner
               FROM giveaway_draw_selection WHERE draw_id = $1 ORDER BY position`,
        values: [commitment.id],
      },
      10,
    );
    assert.equal(selections.length, 3);
    assert.deepEqual(
      selections.map((item) => item.is_winner),
      [true, true, false],
    );
    const callsBeforeOffline = state.calls;
    assert.equal(await service.reproduceDraw(commitment.id), true);
    assert.equal(state.calls, callsBeforeOffline);
    const offlineService = createDrawService(
      f.app,
      { isEnabled: async () => false },
      { send: async () => undefined },
      {
        config: null,
        fetch: async () => {
          throw new Error('network must remain unused');
        },
      },
    );
    assert.equal(await offlineService.reproduceDraw(commitment.id), true);
    await assert.rejects(
      f.app.execute({
        text: `UPDATE giveaway_draw_selection SET is_winner = false
             WHERE draw_id = $1 AND is_winner = true`,
        values: [commitment.id],
      }),
      /completed giveaway draw|seeded giveaway selection/u,
    );
    await f.owner.execute({
      text: 'ALTER TABLE giveaway_draw_selection DISABLE TRIGGER giveaway_draw_selection_write_once',
    });
    await f.owner.execute({
      text: `UPDATE giveaway_draw_selection SET entry_id = (
               SELECT entry_id FROM giveaway_draw_selection
               WHERE draw_id = $1 AND is_winner = true ORDER BY position LIMIT 1
             ) WHERE draw_id = $1 AND is_winner = false`,
      values: [commitment.id],
    });
    await f.owner.execute({
      text: 'ALTER TABLE giveaway_draw_selection ENABLE TRIGGER giveaway_draw_selection_write_once',
    });
    assert.equal(await service.reproduceDraw(commitment.id), false);
    assert.equal(state.calls, callsBeforeOffline);
  } finally {
    await f.close();
  }
});

test('E7-05 refuses flag-off, unannounced bundles and an unreviewed top twenty without closing entries', async () => {
  const f = await fixture();
  try {
    await entrant(f.owner, 'one', 2);
    await entrant(f.owner, 'two', 1);
    const state = { outage: false, latestRound: 100, calls: 0 };
    const alerts: Alert[] = [];
    const now = { value: originalCommit };
    const tooEarly = createDrawService(
      f.app,
      { isEnabled: async () => true },
      { send: async () => undefined },
      { clock: () => now.value, config: drand, fetch: relayRequest(state) },
    );
    await assert.rejects(tooEarly.executeDraw('operator'), /draw date/u);
    assert.equal(state.calls, 0);
    await assert.rejects(
      setup(f, state, alerts, now, false).executeDraw('operator'),
      DrawRefusedError,
    );
    await assert.rejects(
      setup(f, state, alerts, now, true, false).executeDraw('operator'),
      DrawRefusedError,
    );
    await assert.rejects(
      setup(f, state, alerts, now).executeDraw('operator'),
      /reviewed/u,
    );
    const count = await f.owner.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM giveaway_draw',
    });
    assert.equal(count?.count, '0');
  } finally {
    await f.close();
  }
});

test('E7-05 refuses a draw when the current rules list a placeholder bundle item', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'valstara-draw-rules-'));
  try {
    await reviewedEntrants(f);
    const version = 'VAL-GW-LAUNCH-20270401-r2';
    const service = createDrawService(
      f.app,
      { isEnabled: async () => true },
      { send: async () => undefined },
      {
        clock: () => originalCommit,
        config: drand,
        currentRules: () => currentDrawRulesFromFiles(directory),
        fetch: relayRequest({ outage: false, latestRound: 100, calls: 0 }),
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        drawOpensAt: originalCommit,
        reconcile: async () => undefined,
      },
    );
    for (const contents of [
      '\n  - to be announced',
      '\n  - Product A\n  - "to be announced"',
      '\n  - Product A\n\n  - to be announced',
      '\n  - Product A\n  # bundle still incomplete\n  - to be announced',
      '\n  - "to be announced" # product details pending',
      " ['to be announced']",
    ]) {
      await writeFile(
        join(directory, `${version}.md`),
        `---\nrulesVersion: ${version}\n` +
          `sha256: '${'ab'.repeat(32)}'\nprizeCount: 2\n` +
          `bundleContents:${contents}\n---\n`,
      );
      assert.equal(
        (await currentDrawRulesFromFiles(directory)).bundleContentsListed,
        false,
      );
      await assert.rejects(service.executeDraw('operator'), /bundle contents/u);
    }
    const count = await f.owner.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM giveaway_draw',
    });
    assert.equal(count?.count, '0');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.close();
  }
});

test('E7-05 keeps a committed draw pending if its top-twenty review is invalidated before publication', async () => {
  const f = await fixture();
  try {
    await reviewedEntrants(f);
    const state = { outage: false, latestRound: 100, calls: 0 };
    const alerts: Alert[] = [];
    const now = { value: originalCommit };
    const service = setup(f, state, alerts, now);
    const commitment = await service.executeDraw('operator');
    await f.owner.execute({
      text: `UPDATE top_twenty_review_batch
             SET invalidated_at = CURRENT_TIMESTAMP
             WHERE invalidated_at IS NULL`,
    });
    now.value = new Date(commitment.targetRoundAt.getTime() + 1_000);
    assert.equal(await service.advancePending(), false);
    const draw = await f.owner.readOne<{ state: string; seed: string | null }>({
      text: 'SELECT state, seed FROM giveaway_draw WHERE id = $1',
      values: [commitment.id],
    });
    assert.equal(draw?.state, 'pending');
    assert.ok(draw?.seed);
    assert.equal(alerts[0]?.detail.reason, 'top_twenty_review_required');
  } finally {
    await f.close();
  }
});

test('E7-05 never publishes a stored result whose winner designation was corrupted', async () => {
  const f = await fixture();
  try {
    await reviewedEntrants(f);
    const state = { outage: false, latestRound: 100, calls: 0 };
    const alerts: Alert[] = [];
    const now = { value: originalCommit };
    const service = setup(f, state, alerts, now);
    const commitment = await service.executeDraw('operator');
    await f.owner.execute({
      text: `CREATE FUNCTION corrupt_draw_winner() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN NEW.is_winner := false; RETURN NEW; END; $$`,
    });
    await f.owner.execute({
      text: `CREATE TRIGGER corrupt_draw_winner_before_publication
             BEFORE UPDATE OF is_winner ON giveaway_draw_selection
             FOR EACH ROW EXECUTE FUNCTION corrupt_draw_winner()`,
    });
    now.value = new Date(commitment.targetRoundAt.getTime() + 1_000);
    assert.equal(await service.advancePending(), false);
    const draw = await f.owner.readOne<{ state: string; seed: string }>({
      text: 'SELECT state, seed FROM giveaway_draw WHERE id = $1',
      values: [commitment.id],
    });
    assert.equal(draw?.state, 'pending');
    assert.ok(draw?.seed);
    assert.equal(await service.reproduceDraw(commitment.id), false);
    assert.equal(alerts[0]?.severity, 'P1');
    assert.equal(alerts[0]?.detail.reason, 'reproduction_mismatch');
  } finally {
    await f.close();
  }
});

test('E7-05 aborts a commitment if its round appears before the post-commit check, then recommits', async () => {
  const f = await fixture();
  try {
    await reviewedEntrants(f);
    const now = { value: originalCommit };
    let latestCalls = 0;
    const request: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/info')) return Response.json(chainInfo);
      if (url.endsWith('/public/latest')) {
        latestCalls += 1;
        if (latestCalls === 3) {
          now.value = new Date(originalCommit.getTime() + 3_000);
        }
        return Response.json({
          ...beacon,
          round: latestCalls >= 3 ? 101 : 100,
        });
      }
      return Response.json(beacon);
    };
    const service = createDrawService(
      f.app,
      { isEnabled: async () => true },
      { send: async () => undefined },
      {
        clock: () => now.value,
        config: drand,
        fetch: request,
        currentRules: async () => ({
          prizeCount: 2,
          rulesVersion: 'fixture-v1',
          rulesSha256: 'ab'.repeat(32),
          bundleContentsListed: true,
        }),
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        drawOpensAt: originalCommit,
        reconcile: async () => undefined,
      },
    );
    const committed = await service.executeDraw('operator');
    assert.equal(committed.targetRound, 102);
    const draws = await f.owner.list<{
      state: string;
      seed: string | null;
      target_round: string;
    }>(
      {
        text: 'SELECT state, seed, target_round::text FROM giveaway_draw ORDER BY target_round',
      },
      10,
    );
    assert.deepEqual(
      draws.map((draw) => [draw.state, draw.seed, Number(draw.target_round)]),
      [
        ['aborted', null, 101],
        ['pending', null, 102],
      ],
    );
  } finally {
    await f.close();
  }
});

test('E7-05 rolls back a preexisting round found inside the commitment transaction and recommits', async () => {
  const f = await fixture();
  try {
    await reviewedEntrants(f);
    const now = { value: originalCommit };
    let latestCalls = 0;
    const request: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/info')) return Response.json(chainInfo);
      if (url.endsWith('/public/latest')) {
        latestCalls += 1;
        if (latestCalls === 1) {
          now.value = new Date(originalCommit.getTime() + 3_000);
        }
        return Response.json({ ...beacon, round: 101 });
      }
      return Response.json(beacon);
    };
    const service = createDrawService(
      f.app,
      { isEnabled: async () => true },
      { send: async () => undefined },
      {
        clock: () => now.value,
        config: drand,
        fetch: request,
        currentRules: async () => ({
          prizeCount: 2,
          rulesVersion: 'fixture-v1',
          rulesSha256: 'ab'.repeat(32),
          bundleContentsListed: true,
        }),
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        drawOpensAt: originalCommit,
        reconcile: async () => undefined,
      },
    );
    const committed = await service.executeDraw('operator');
    assert.equal(committed.targetRound, 102);
    const draws = await f.owner.list<{ state: string; target_round: string }>(
      { text: 'SELECT state, target_round::text FROM giveaway_draw' },
      10,
    );
    assert.deepEqual(
      draws.map((draw) => [draw.state, Number(draw.target_round)]),
      [['pending', 102]],
    );
  } finally {
    await f.close();
  }
});

test('E7-05 refuses to commit when two relays cannot confirm the target is still future', async () => {
  const f = await fixture();
  try {
    await reviewedEntrants(f);
    const request: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/info')) return Response.json(chainInfo);
      if (url.includes('relay-two') && url.endsWith('/public/latest')) {
        throw new Error('latest unavailable');
      }
      return Response.json({ ...beacon, round: 100 });
    };
    const service = createDrawService(
      f.app,
      { isEnabled: async () => true },
      { send: async () => undefined },
      {
        clock: () => originalCommit,
        config: drand,
        fetch: request,
        currentRules: async () => ({
          prizeCount: 2,
          rulesVersion: 'fixture-v1',
          rulesSha256: 'ab'.repeat(32),
          bundleContentsListed: true,
        }),
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        drawOpensAt: originalCommit,
        reconcile: async () => undefined,
      },
    );
    await assert.rejects(
      service.executeDraw('operator'),
      BeaconUnavailableError,
    );
    const count = await f.owner.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM giveaway_draw',
    });
    assert.equal(count?.count, '0');
  } finally {
    await f.close();
  }
});

test('E7-05 refuses a concurrent second draw against the real database constraint', async () => {
  const f = await fixture();
  try {
    await reviewedEntrants(f);
    const state = { outage: false, latestRound: 100, calls: 0 };
    const service = setup(f, state, [], { value: originalCommit });
    const results = await Promise.allSettled([
      service.executeDraw('operator'),
      service.executeDraw('operator'),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      1,
    );
    const count = await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM giveaway_draw WHERE state <> 'aborted'`,
    });
    assert.equal(count?.count, '1');
  } finally {
    await f.close();
  }
});

test('E7-05 keeps the entry ledger closed after an aborted committed draw', async () => {
  const f = await fixture();
  try {
    const ids = await reviewedEntrants(f);
    const service = setup(
      f,
      { outage: false, latestRound: 100, calls: 0 },
      [],
      {
        value: originalCommit,
      },
    );
    const commitment = await service.executeDraw('operator');
    await f.app.execute({
      text: `UPDATE giveaway_draw SET state = 'aborted'
             WHERE id = $1 AND state = 'pending' AND seed IS NULL`,
      values: [commitment.id],
    });
    await assert.rejects(
      f.app.execute({
        text: `INSERT INTO giveaway_entry
               (id, subscriber_id, method, entries, rules_version, rules_sha256)
             VALUES ($1, $2, 'base', 1, 'fixture-v1', decode(repeat('ab', 32), 'hex'))`,
        values: [randomUUID(), ids[0]],
      }),
      /entries are closed/u,
    );
  } finally {
    await f.close();
  }
});

test('E9-05 erasure before commitment excludes entries; post-commit erasure preserves exact publication and reproduction', async () => {
  const f = await fixture();
  try {
    const ids = await reviewedEntrants(f);
    const state = { outage: false, latestRound: 100, calls: 0 };
    const alerts: Alert[] = [];
    const now = { value: originalCommit };
    const erasure = createErasureService(f.app, {
      clock: () => now.value,
      deleteContact: async () => {},
      alerts: {
        send: async (a) => {
          alerts.push(a);
        },
      },
    });
    await withTransaction(f.app, (c) => erasure.request(c, ids[0]!));
    await erasure.run();
    // Before commitment the ranking changed, so a human re-reviews the new set.
    await createTopTwentyReviewGate(f.app).reviewCurrentTopTwenty(
      ids
        .slice(1)
        .map((subscriberId) => ({ subscriberId, outcome: 'cleared' })),
      'operator',
    );
    const service = setup(f, state, alerts, now);
    const committed = await service.executeDraw('operator');
    const before = await f.owner.list(
      {
        text: 'SELECT * FROM giveaway_draw_snapshot_row WHERE draw_id=$1 ORDER BY entry_id',
        values: [committed.id],
      },
      100,
    );
    assert.ok(before.length > 0);
    assert.ok(before.every((row) => row.subscriber_id !== ids[0]));
    await withTransaction(f.app, (c) => erasure.request(c, ids[1]!));
    await erasure.run();
    assert.deepEqual(
      await f.owner.list(
        {
          text: 'SELECT * FROM giveaway_draw_snapshot_row WHERE draw_id=$1 ORDER BY entry_id',
          values: [committed.id],
        },
        100,
      ),
      before,
    );
    assert.equal(
      (
        await f.app.readOne({
          text: 'SELECT reason FROM giveaway_draw_void WHERE draw_id=$1 AND subscriber_id=$2',
          values: [committed.id, ids[1]],
        })
      )?.reason,
      'erasure',
    );
    await assert.rejects(
      f.app.execute({
        text: `INSERT INTO giveaway_draw_void(draw_id,subscriber_id,reason,voided_at,actor)
          VALUES($1,$2,'erasure',$3,'operator')`,
        values: [committed.id, ids[2], now.value],
      }),
      /recorded erasure request/,
    );
    await assert.rejects(
      f.app.execute({
        text: `INSERT INTO giveaway_draw_void(draw_id,subscriber_id,reason,voided_at,actor)
          VALUES($1,$2,'fraud',$3,'operator')`,
        values: [committed.id, ids[1], now.value],
      }),
    );
    now.value = committed.targetRoundAt;
    assert.equal(await service.advancePending(), true);
    assert.equal(await service.reproduceDraw(committed.id), true);
    await assert.rejects(
      f.app.execute({ text: 'UPDATE giveaway_draw_void SET reason=reason' }),
    );
    await assert.rejects(
      f.owner.execute({ text: 'DELETE FROM giveaway_draw_void' }),
      /append-only/,
    );
  } finally {
    await f.close();
  }
});
