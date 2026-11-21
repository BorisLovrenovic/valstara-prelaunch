import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  computeCouponLadder,
  couponExpiresAt,
  couponLadder,
  type AccessWindow,
} from '../src/server/referral/config.ts';
import {
  couponTransition,
  couponTransitions,
  prelaunchRewardTransitions,
} from '../src/server/referral/reward-state.ts';
import type { ReferralRewardConfiguration } from '../src/server/referral/rewards.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createReferralVoidService } from '../src/server/referral/void.ts';

// E11.7-03: the coupon ladder and wave 1 replace the milestone tiers. Every
// database test runs against a real, freshly migrated database, with runtime
// calls made as the least-privilege application role.

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const ladderMigration = '0061-coupon-ladder.sql';
const migrationDirectory = fileURLToPath(
  new URL('../src/server/db/migrations/', import.meta.url),
);
const now = new Date('2026-11-21T12:00:00.000Z');
const founder = 'admin.operator';

interface Fixture {
  readonly app: DatabasePool;
  readonly owner: DatabasePool;
  dispose(): Promise<void>;
}

async function createFixture(
  beforeLadder?: (owner: DatabasePool) => Promise<void>,
): Promise<Fixture> {
  const databaseName = `valstara_e11703_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const owner = createPool(databaseUrl.toString());

  if (beforeLadder !== undefined) {
    // Migrate to the release before the ladder, seed, then apply it and every
    // later migration.
    const directory = await mkdtemp(join(tmpdir(), 'valstara-e11703-'));
    try {
      await cp(migrationDirectory, directory, {
        filter: (source) => {
          const name = basename(source);
          return !name.endsWith('.sql') || name < ladderMigration;
        },
        recursive: true,
      });
      await runMigrations(owner, {
        applicationRolePassword,
        directory,
        release: 'e11-7-03-before',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
    await beforeLadder(owner);
  }
  await runMigrations(owner, {
    applicationRolePassword,
    release: 'e11-7-03-test',
  });

  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = applicationRolePassword;
  const app = createPool(appUrl.toString());
  return {
    app,
    owner,
    async dispose() {
      await app.close();
      await owner.close();
      await admin.execute({
        text: `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      });
      await admin.close();
    },
  };
}

/** A verified member whose verification order gave them `window`. */
async function member(
  owner: DatabasePool,
  window: AccessWindow | null = 'wave-3',
): Promise<string> {
  const id = randomUUID();
  await owner.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at,
        verification_order_window, access_window
      )
      VALUES ($1, $2, $2, 'example.test', 'verified', $3, $4, $4)
    `,
    values: [id, `${id}@example.test`, now, window],
  });
  return id;
}

/** A verified friend with an attributed edge to the referrer. */
async function pendingFriend(
  owner: DatabasePool,
  referrerId: string,
): Promise<string> {
  const friendId = await member(owner, 'wave-4');
  await owner.execute({
    text: `
      INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
      VALUES ($1, $2, $3, 'attributed', 'none')
    `,
    values: [randomUUID(), referrerId, friendId],
  });
  return friendId;
}

async function confirmFriends(
  f: Fixture,
  referrerId: string,
  count: number,
  rewards?: ReferralRewardConfiguration,
): Promise<string[]> {
  const service = createReferralService(f.app, { rewards });
  const friends: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const friendId = await pendingFriend(f.owner, referrerId);
    await service.confirm(friendId, now);
    friends.push(friendId);
  }
  return friends;
}

interface StoredLadder {
  readonly confirmed: number;
  readonly window: string | null;
  readonly coupons: readonly {
    readonly number: number;
    readonly percent: number | null;
    readonly state: string;
  }[];
}

async function stored(
  database: DatabasePool,
  subscriberId: string,
): Promise<StoredLadder> {
  const row = await database.readOne<{
    confirmed_referrals: number;
    access_window: string | null;
  }>({
    text: 'SELECT confirmed_referrals, access_window FROM subscriber WHERE id = $1',
    values: [subscriberId],
  });
  const coupons = await database.list<{
    number: number;
    percent: number | null;
    state: string;
  }>(
    {
      text: `SELECT coupon_number AS number, percent, state
             FROM referral_coupon WHERE subscriber_id = $1
             ORDER BY coupon_number`,
      values: [subscriberId],
    },
    10,
  );
  return {
    confirmed: row?.confirmed_referrals ?? -1,
    window: row?.access_window ?? null,
    coupons,
  };
}

function held(...percents: number[]) {
  return percents.map((percent, index) => ({
    number: index + 1,
    percent,
    state: 'held',
  }));
}

test('the transition enumeration: no coupon transition reaches settled, and the database refuses one', async () => {
  // Every transition a coupon can make here, enumerated as E4-06's test
  // enumerates the reward transitions into `settled`.
  assert.deepEqual(couponTransitions, [
    { from: 'none', source: 'recompute', to: 'held' },
    { from: 'held', source: 'recompute', to: 'held' },
    { from: 'held', source: 'recompute', to: 'void' },
    { from: 'void', source: 'recompute', to: 'held' },
  ]);
  assert.ok(
    couponTransitions.every(
      (transition) => (transition.to as string) !== 'settled',
    ),
  );
  for (const from of ['none', 'held', 'void'] as const) {
    assert.throws(() => couponTransition(from, 'settled'), /not allowed/u);
  }
  assert.throws(() => couponTransition('none', 'void'), /not allowed/u);
  // The reward transitions into `settled` are still only the cheap
  // confirmation reward (E4-06), so no coupon reaches it by that path either.
  assert.deepEqual(
    prelaunchRewardTransitions.filter(
      (transition) => transition.to === 'settled',
    ),
    [
      {
        classification: 'cheap',
        from: 'none',
        source: 'confirmation',
        to: 'settled',
      },
    ],
  );

  // In the application, only the coupon repository writes coupon state;
  // erasure deletes rows.
  const sources: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (/\.(?:ts|mjs|astro)$/u.test(entry.name)) sources.push(path);
    }
  }
  await collect(fileURLToPath(new URL('../src/', import.meta.url)));
  const writers: string[] = [];
  for (const path of sources) {
    const text = await readFile(path, 'utf8');
    if (/(?:INSERT INTO|UPDATE)\s+referral_coupon\b/u.test(text)) {
      writers.push(path.slice(path.lastIndexOf('/src/') + 1));
    }
  }
  assert.deepEqual(writers.sort(), ['src/server/db/referral-coupon.ts']);
  const repository = await readFile(
    new URL('../src/server/db/referral-coupon.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(repository, /'settled'/u);

  const f = await createFixture();
  try {
    const referrerId = await member(f.owner);
    await confirmFriends(f, referrerId, 3);
    // The application role can neither store nor move a coupon to settled.
    await assert.rejects(
      f.app.execute({
        text: `UPDATE referral_coupon SET state = 'settled' WHERE subscriber_id = $1`,
        values: [referrerId],
      }),
      /check constraint/u,
    );
    await assert.rejects(
      f.app.execute({
        text: `INSERT INTO referral_coupon (id, subscriber_id, coupon_number, percent, state, created_at, updated_at)
               VALUES ($1, $2, 2, 5, 'settled', $3, $3)`,
        values: [randomUUID(), referrerId, now],
      }),
      /check constraint/u,
    );
    // A settled row with no percent passes the percent-shape check, so only
    // the state check can refuse it.
    await assert.rejects(
      f.app.execute({
        text: `UPDATE referral_coupon SET state = 'settled', percent = NULL WHERE subscriber_id = $1`,
        values: [referrerId],
      }),
      /violates check constraint "referral_coupon_state_check"/u,
    );
    await assert.rejects(
      f.app.execute({
        text: `INSERT INTO referral_coupon (id, subscriber_id, coupon_number, percent, state, created_at, updated_at)
               VALUES ($1, $2, 2, NULL, 'settled', $3, $3)`,
        values: [randomUUID(), referrerId, now],
      }),
      /violates check constraint "referral_coupon_state_check"/u,
    );
    // Nor can it change a coupon's owner or number.
    await assert.rejects(
      f.app.execute({
        text: 'UPDATE referral_coupon SET coupon_number = 9 WHERE subscriber_id = $1',
        values: [referrerId],
      }),
      /permission denied/u,
    );
    assert.deepEqual((await stored(f.owner, referrerId)).coupons, held(5));
  } finally {
    await f.dispose();
  }
});

test("the founder's table cases", () => {
  const percents = (count: number) =>
    computeCouponLadder(count).map((coupon) => coupon.percent);
  assert.deepEqual(percents(0), []);
  assert.deepEqual(percents(2), []);
  assert.deepEqual(percents(3), [5]);
  assert.deepEqual(percents(5), [5]);
  assert.deepEqual(percents(6), [10]);
  assert.deepEqual(percents(18), [30]);
  assert.deepEqual(percents(20), [30]);
  assert.deepEqual(percents(21), [30, 5]);
  assert.deepEqual(percents(36), [30, 30]);
  assert.deepEqual(percents(38), [30, 30]);
  assert.deepEqual(percents(39), [30, 30, 5]);
  assert.deepEqual(percents(54), [30, 30, 30]);
  // The ladder ends after coupon 3 reaches 30%.
  assert.deepEqual(computeCouponLadder(60), computeCouponLadder(54));
  assert.deepEqual(computeCouponLadder(39), [
    { number: 1, percent: 30 },
    { number: 2, percent: 30 },
    { number: 3, percent: 5 },
  ]);
  // Five years after the configured public launch, 2027-10-01.
  assert.equal(couponLadder.publicLaunchDate, '2027-10-01');
  assert.equal(couponExpiresAt().toISOString(), '2032-10-01T00:00:00.000Z');
  assert.throws(() => computeCouponLadder(-1), /non-negative/u);
  assert.throws(
    () => computeCouponLadder(3, { ...couponLadder, unlocks: [21, 3] }),
    /increasing/u,
  );
});

test('the seeded property test: coupons and wave always equal the ladder from the current non-voided count', async () => {
  const f = await createFixture();
  try {
    const referral = createReferralService(f.app);
    const voids = createReferralVoidService(f.app, () => now);
    // Voids and un-voids are as likely as confirmations, so the count moves
    // back and forth across a threshold rather than only climbing.
    const command = fc.oneof(
      { arbitrary: fc.constant({ kind: 'confirm' as const }), weight: 4 },
      {
        arbitrary: fc.record({
          kind: fc.constant('void' as const),
          pick: fc.nat(),
        }),
        weight: 3,
      },
      {
        arbitrary: fc.record({
          kind: fc.constant('unvoid' as const),
          pick: fc.nat(),
        }),
        weight: 3,
      },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<AccessWindow>('wave-1', 'wave-2', 'wave-4'),
        // A run starts from any count up to coupon 3's unlock, so every
        // threshold — 3 for coupon 1 and wave 1, 21 and 39 — is crossed.
        fc.integer({ min: 0, max: 42 }),
        fc.array(command, { minLength: 1, maxLength: 30 }),
        async (window, start, generated) => {
          const referrerId = await member(f.owner, window);
          const active: string[] = [];
          const voided: string[] = [];
          let highestUnlocked = 0;
          const commands = [
            ...Array.from({ length: start }, () => ({
              kind: 'confirm' as const,
            })),
            ...generated,
          ];
          for (const step of commands) {
            if (step.kind === 'confirm') {
              const friendId = await pendingFriend(f.owner, referrerId);
              await referral.confirm(friendId, now);
              active.push(friendId);
            } else if (step.kind === 'void' && active.length > 0) {
              const [friendId] = active.splice(step.pick % active.length, 1);
              await voids.voidReferral(friendId!, 'Property run', founder);
              voided.push(friendId!);
            } else if (step.kind === 'unvoid' && voided.length > 0) {
              const [friendId] = voided.splice(step.pick % voided.length, 1);
              await voids.unvoidReferral(friendId!, 'Property run', founder);
              active.push(friendId!);
            }

            const count = active.length;
            const ladder = computeCouponLadder(count);
            highestUnlocked = Math.max(highestUnlocked, ladder.length);
            const actual = await stored(f.app, referrerId);
            assert.equal(actual.confirmed, count);
            assert.deepEqual(
              actual.coupons,
              Array.from({ length: highestUnlocked }, (_value, index) => {
                const earned = ladder[index];
                return earned === undefined
                  ? { number: index + 1, percent: null, state: 'void' }
                  : {
                      number: index + 1,
                      percent: earned.percent,
                      state: 'held',
                    };
              }),
            );
            assert.equal(
              actual.window,
              window === 'wave-1' || count >= 3 ? 'wave-1' : window,
            );
          }
        },
      ),
      { numRuns: 30, seed: 20_261_121 },
    );
  } finally {
    await f.dispose();
  }
});

test('void-driven decrease and restore: a void lowers or voids a coupon and drops wave 1 below 3; an un-void restores both', async () => {
  const f = await createFixture();
  try {
    const voids = createReferralVoidService(f.app, () => now);

    // At exactly 3: coupon 1 at 5% and wave 1. One void takes both away.
    const three = await member(f.owner, 'wave-3');
    const threeFriends = await confirmFriends(f, three, 3);
    assert.deepEqual(await stored(f.owner, three), {
      confirmed: 3,
      window: 'wave-1',
      coupons: held(5),
    });
    await voids.voidReferral(threeFriends[0]!, 'Same household', founder);
    assert.deepEqual(await stored(f.owner, three), {
      confirmed: 2,
      window: 'wave-3',
      coupons: [{ number: 1, percent: null, state: 'void' }],
    });
    await voids.unvoidReferral(threeFriends[0]!, 'Cleared on appeal', founder);
    assert.deepEqual(await stored(f.owner, three), {
      confirmed: 3,
      window: 'wave-1',
      coupons: held(5),
    });
    // Each wave change is audited with the founder as the actor.
    const waveAudits = await f.owner.list<{ actor: string; detail: unknown }>(
      {
        text: `SELECT actor, detail FROM audit_log
               WHERE action = 'referral.access_window_recalculated' AND subject_id = $1
               ORDER BY at, id`,
        values: [three],
      },
      10,
    );
    assert.deepEqual(waveAudits, [
      {
        actor: 'system:referral-confirmation',
        detail: {
          confirmedReferrals: 3,
          fromWindow: 'wave-3',
          toWindow: 'wave-1',
          verificationOrderWindow: 'wave-3',
        },
      },
      {
        actor: founder,
        detail: {
          confirmedReferrals: 2,
          fromWindow: 'wave-1',
          toWindow: 'wave-3',
          verificationOrderWindow: 'wave-3',
        },
      },
      {
        actor: founder,
        detail: {
          confirmedReferrals: 3,
          fromWindow: 'wave-3',
          toWindow: 'wave-1',
          verificationOrderWindow: 'wave-3',
        },
      },
    ]);

    // At 6: a void lowers coupon 1 a step, and an un-void raises it back.
    const six = await member(f.owner, 'wave-2');
    const sixFriends = await confirmFriends(f, six, 6);
    assert.deepEqual((await stored(f.owner, six)).coupons, held(10));
    await voids.voidReferral(sixFriends[5]!, 'Bulk signups', founder);
    assert.deepEqual((await stored(f.owner, six)).coupons, held(5));
    await voids.unvoidReferral(sixFriends[5]!, 'Cleared on appeal', founder);
    assert.deepEqual((await stored(f.owner, six)).coupons, held(10));

    // At 21: a void takes coupon 2 back to void; coupon 1 stays at 30%. The
    // void's audit records the referrer's ladder before and after.
    const many = await member(f.owner, 'wave-4');
    const manyFriends = await confirmFriends(f, many, 21);
    assert.deepEqual((await stored(f.owner, many)).coupons, held(30, 5));
    await voids.voidReferral(manyFriends[0]!, 'Duplicate person', founder);
    assert.deepEqual((await stored(f.owner, many)).coupons, [
      { number: 1, percent: 30, state: 'held' },
      { number: 2, percent: null, state: 'void' },
    ]);
    const voidAudit = await f.owner.readOne<{
      detail: {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
    }>({
      text: `SELECT detail FROM audit_log WHERE action = 'referral.voided'
             AND detail->>'referred_id' = $1`,
      values: [manyFriends[0]],
    });
    assert.deepEqual(voidAudit?.detail.before.referrer_coupons, held(30, 5));
    assert.deepEqual(voidAudit?.detail.after.referrer_coupons, [
      { number: 1, percent: 30, state: 'held' },
      { number: 2, percent: null, state: 'void' },
    ]);
    assert.equal(voidAudit?.detail.before.referrer_access_window, 'wave-1');
    assert.equal(voidAudit?.detail.after.referrer_access_window, 'wave-1');
    await voids.unvoidReferral(manyFriends[0]!, 'Cleared on appeal', founder);
    assert.deepEqual(await stored(f.owner, many), {
      confirmed: 21,
      window: 'wave-1',
      coupons: held(30, 5),
    });
  } finally {
    await f.dispose();
  }
});

test('wave 1 at the threshold, and the first-1,000 place is never lost', async () => {
  const f = await createFixture();
  try {
    const voids = createReferralVoidService(f.app, () => now);
    const referrerId = await member(f.owner, 'wave-4');
    const friends = await confirmFriends(f, referrerId, 2);
    assert.equal((await stored(f.owner, referrerId)).window, 'wave-4');
    friends.push(...(await confirmFriends(f, referrerId, 1)));
    assert.equal((await stored(f.owner, referrerId)).window, 'wave-1');

    // One of the first 1,000 is in wave 1 with no referrals, and voiding every
    // referral they have does not remove it.
    const early = await member(f.owner, 'wave-1');
    const earlyFriends = await confirmFriends(f, early, 3);
    for (const friendId of earlyFriends) {
      await voids.voidReferral(friendId, 'Bulk signups', founder);
    }
    assert.deepEqual(await stored(f.owner, early), {
      confirmed: 0,
      window: 'wave-1',
      coupons: [{ number: 1, percent: null, state: 'void' }],
    });

    // The recorded window is write-once, so no later write can take the
    // first-1,000 place away either.
    await assert.rejects(
      f.app.execute({
        text: `UPDATE subscriber SET verification_order_window = 'wave-2' WHERE id = $1`,
        values: [early],
      }),
      /write-once/u,
    );
  } finally {
    await f.dispose();
  }
});

test('concurrent confirmations for one referrer recompute one consistent ladder', async () => {
  const f = await createFixture();
  try {
    const referrerId = await member(f.owner, 'wave-3');
    const friends: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      friends.push(await pendingFriend(f.owner, referrerId));
    }
    await Promise.all(
      friends.map((friendId) =>
        createReferralService(f.app).confirm(friendId, now),
      ),
    );
    assert.deepEqual(await stored(f.owner, referrerId), {
      confirmed: 21,
      window: 'wave-1',
      coupons: held(30, 5),
    });
  } finally {
    await f.dispose();
  }
});

test('the daily repair recomputes drifted coupons and wave, and reports each correction', async () => {
  const f = await createFixture();
  try {
    const referrerId = await member(f.owner, 'wave-3');
    await confirmFriends(f, referrerId, 6);
    const repair = createReferralService(f.app);
    assert.equal((await repair.recomputeCounters(1_000)).corrected, 0);

    await f.owner.execute({
      text: `UPDATE referral_coupon SET percent = 25 WHERE subscriber_id = $1`,
      values: [referrerId],
    });
    await f.owner.execute({
      text: `UPDATE subscriber SET access_window = 'wave-3' WHERE id = $1`,
      values: [referrerId],
    });
    assert.deepEqual(await repair.recomputeCounters(1_000), {
      checked: 1 + 6,
      corrected: 1,
    });
    assert.deepEqual(await stored(f.owner, referrerId), {
      confirmed: 6,
      window: 'wave-1',
      coupons: held(10),
    });
    assert.equal((await repair.recomputeCounters(1_000)).corrected, 0);
  } finally {
    await f.dispose();
  }
});

test('retired awards: every milestone award is voided as ladder_replaced and none is deleted', async () => {
  const promoted = randomUUID();
  const untouched = randomUUID();
  const awardIds: string[] = [];
  let alreadyVoid = '';
  const fixture = await createFixture(async (owner) => {
    // Before the ladder: a member promoted from wave 3 to wave 2 by tier 1,
    // with a settled wave upgrade, a held 15% discount and three referrals.
    for (const [id, window] of [
      [promoted, 'wave-2'],
      [untouched, 'wave-2'],
    ] as const) {
      await owner.execute({
        text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
                 verified_at, access_window, referral_tier, confirmed_referrals)
               VALUES ($1, $2, $2, 'example.test', 'verified', $3, $4, $5, $6)`,
        values: [
          id,
          `${id}@example.test`,
          now,
          window,
          id === promoted ? 1 : 0,
          id === promoted ? 3 : 0,
        ],
      });
    }
    await owner.execute({
      text: `INSERT INTO audit_log (id, actor, action, subject_type, subject_id, detail)
             VALUES ($1, 'system:referral-confirmation', 'referral.access_window_promoted',
               'subscriber', $2, $3::jsonb)`,
      values: [
        randomUUID(),
        promoted,
        JSON.stringify({
          fromTier: 0,
          fromWindow: 'wave-3',
          toTier: 1,
          toWindow: 'wave-2',
        }),
      ],
    });
    for (let index = 0; index < 3; index += 1) {
      const friendId = randomUUID();
      await owner.execute({
        text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status, verified_at)
               VALUES ($1, $2, $2, 'example.test', 'verified', $3)`,
        values: [friendId, `${friendId}@example.test`, now],
      });
      await owner.execute({
        text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state, confirmed_at)
               VALUES ($1, $2, $3, 'confirmed', 'settled', $4)`,
        values: [randomUUID(), promoted, friendId, now],
      });
    }
    for (const [kind, state] of [
      ['wave_upgrade', 'settled'],
      ['discount', 'held'],
    ] as const) {
      const id = randomUUID();
      awardIds.push(id);
      await owner.execute({
        text: `INSERT INTO milestone_award (id, subscriber_id, tier, reward_kind, state)
               VALUES ($1, $2, 1, $3, $4)`,
        values: [id, promoted, kind, state],
      });
    }
    alreadyVoid = randomUUID();
    await owner.execute({
      text: `INSERT INTO milestone_award (id, subscriber_id, tier, reward_kind, state)
             VALUES ($1, $2, 1, 'entries', 'void')`,
      values: [alreadyVoid, untouched],
    });
  });
  try {
    const byId = (left: { id: string }, right: { id: string }) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    const awards = await fixture.owner.list<{
      id: string;
      state: string;
      void_reason: string | null;
    }>(
      { text: 'SELECT id::text, state, void_reason FROM milestone_award' },
      10,
    );
    assert.deepEqual(
      [...awards].sort(byId),
      [
        ...awardIds.map((id) => ({
          id,
          state: 'void',
          void_reason: 'ladder_replaced',
        })),
        { id: alreadyVoid, state: 'void', void_reason: null },
      ].sort(byId),
    );
    const retired = await fixture.owner.list<{
      subject_id: string;
      detail: { before: { state: string }; reason: string };
    }>(
      {
        text: `SELECT subject_id, detail FROM audit_log
               WHERE action = 'referral.milestone_retired'`,
      },
      10,
    );
    assert.deepEqual(
      retired
        .map((row) => ({
          id: row.subject_id,
          reason: row.detail.reason,
          before: row.detail.before.state,
        }))
        .sort(byId),
      awardIds
        .map((id, index) => ({
          id,
          reason: 'ladder_replaced',
          before: index === 0 ? 'settled' : 'held',
        }))
        .sort(byId),
    );

    // The promoted member's verification-order window comes from the
    // recorded promotion, and three referrals now put them in wave 1 with
    // coupon 1 at 5%. Their tier cache is 0: no settled award remains.
    assert.deepEqual(await stored(fixture.owner, promoted), {
      confirmed: 3,
      window: 'wave-1',
      coupons: held(5),
    });
    const windows = await fixture.owner.list<{
      id: string;
      verification_order_window: string;
      referral_tier: number;
    }>(
      {
        text: `SELECT id::text, verification_order_window, referral_tier FROM subscriber
               WHERE id = ANY($1::uuid[])`,
        values: [[promoted, untouched]],
      },
      2,
    );
    assert.deepEqual(
      [...windows].sort(byId),
      [
        { id: promoted, verification_order_window: 'wave-3', referral_tier: 0 },
        {
          id: untouched,
          verification_order_window: 'wave-2',
          referral_tier: 0,
        },
      ].sort(byId),
    );
    // The backfill equals the recompute, so the first repair corrects nothing.
    assert.equal(
      (await createReferralService(fixture.app).recomputeCounters(1_000))
        .corrected,
      0,
    );

    // No path can create a milestone award any more, and a new confirmation
    // creates none.
    await assert.rejects(
      fixture.app.execute({
        text: `INSERT INTO milestone_award (id, subscriber_id, tier, reward_kind, state)
               VALUES ($1, $2, 2, 'discount', 'held')`,
        values: [randomUUID(), promoted],
      }),
      /permission denied/u,
    );
    await confirmFriends(fixture, untouched, 3);
    const count = await fixture.owner.readOne<{ count: number }>({
      text: 'SELECT count(*)::int AS count FROM milestone_award',
    });
    assert.equal(count?.count, 3);
  } finally {
    await fixture.dispose();
  }
});

test('configuration change without migration: a different ladder applies through the same code and schema', async () => {
  const f = await createFixture();
  try {
    const ledger = async () =>
      (
        await f.owner.readOne<{ count: number }>({
          text: 'SELECT count(*)::int AS count FROM migration_ledger',
        })
      )?.count;
    const migrations = await ledger();
    const tuned: ReferralRewardConfiguration = {
      ladder: {
        ...couponLadder,
        unlocks: [2, 4],
        stepReferrals: 1,
        stepPercent: 10,
        maximumPercent: 20,
      },
      waveOneReferrals: 2,
    };
    const referrerId = await member(f.owner, 'wave-4');
    const friends = await confirmFriends(f, referrerId, 2, tuned);
    assert.deepEqual(await stored(f.owner, referrerId), {
      confirmed: 2,
      window: 'wave-1',
      coupons: held(10),
    });
    friends.push(...(await confirmFriends(f, referrerId, 3, tuned)));
    assert.deepEqual((await stored(f.owner, referrerId)).coupons, held(20, 20));
    await createReferralVoidService(f.app, () => now, tuned).voidReferral(
      friends[0]!,
      'Bulk signups',
      founder,
    );
    assert.deepEqual((await stored(f.owner, referrerId)).coupons, held(20, 10));

    // The configured ladder, restored, recomputes the same rows.
    await createReferralService(f.app).recomputeCounters(1_000);
    assert.deepEqual(await stored(f.owner, referrerId), {
      confirmed: 4,
      window: 'wave-1',
      coupons: [
        { number: 1, percent: 5, state: 'held' },
        { number: 2, percent: null, state: 'void' },
      ],
    });
    assert.equal(await ledger(), migrations);
  } finally {
    await f.dispose();
  }
});
