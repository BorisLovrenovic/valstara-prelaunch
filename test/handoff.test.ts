import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import fc from 'fast-check';

import { runMigrations } from '../src/server/db/migration.ts';
import {
  assertCutoverEligible,
  voidLegacyBonusBatch,
} from '../src/server/db/handoff.ts';
import {
  createPool,
  type DatabasePool,
  type SqlStatement,
} from '../src/server/db/pool.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import { recordHandoffFreeze } from '../src/server/subscriber/handoff-freeze.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import {
  createRehearsalTables,
  countRehearsalRows,
} from '../src/server/db/handoff-rehearsal.ts';
import {
  importRehearsalBatch,
  rehearsalBatchSize,
} from '../src/server/db/handoff-rehearsal.ts';
import {
  accessWindowForReferrals,
  computeCouponLadder,
  couponExpiresAt,
  couponLadder,
  type AccessWindow,
} from '../src/server/referral/config.ts';
import type { ReferralRewardConfiguration } from '../src/server/referral/rewards.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createReferralVoidService } from '../src/server/referral/void.ts';
import {
  exportHandoff,
  type HandoffRecord,
} from '../src/server/subscriber/handoff.ts';
import {
  importRehearsal,
  parseHandoffRecord,
} from '../src/server/subscriber/handoff-rehearsal.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const launch = new Date('2027-03-15T10:00:00.000Z');
// Five years after the configured public-launch date (E11.7-03).
const couponExpiry = '2032-09-01T00:00:00.000Z';

test('the named freeze audit requires signups closed and records its mode', async () => {
  const f = await fixture();
  try {
    const flags = createFlagService(f.app);
    await flags.set('signup.enabled', true, 'operator');
    await assert.rejects(
      recordHandoffFreeze(f.app, 'operator', 'operational'),
      /Close signups/u,
    );
    await flags.set('signup.enabled', false, 'operator');
    await recordHandoffFreeze(f.app, 'operator', 'operational');
    const audit = await f.owner.readOne<{
      actor: string;
      detail: { mode: string };
    }>({
      text: `SELECT actor,detail FROM audit_log WHERE action='handoff.frozen'`,
    });
    assert.equal(audit?.actor, 'operator');
    assert.equal(audit?.detail.mode, 'operational');
  } finally {
    await f.dispose();
  }
});

async function fixture(): Promise<{
  owner: DatabasePool;
  app: DatabasePool;
  scratch: DatabasePool;
  dispose(): Promise<void>;
}> {
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const admin = createPool(adminUrl.toString());
  const sourceName = `valstara_e1106_source_${randomUUID().replaceAll('-', '')}`;
  const scratchName = `valstara_e1106_scratch_${randomUUID().replaceAll('-', '')}`;
  await admin.execute({ text: `CREATE DATABASE "${sourceName}"` });
  await admin.execute({ text: `CREATE DATABASE "${scratchName}"` });
  const sourceUrl = new URL(adminUrl);
  sourceUrl.pathname = `/${sourceName}`;
  const appUrl = new URL(sourceUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = `/${scratchName}`;
  const owner = createPool(sourceUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appPassword,
    release: 'e11-06-test',
  });
  const app = createPool(appUrl.toString());
  const scratch = createPool(scratchUrl.toString());
  await createRehearsalTables(scratch);
  return {
    owner,
    app,
    scratch,
    async dispose() {
      await Promise.all([app.close(), owner.close(), scratch.close()]);
      for (const name of [sourceName, scratchName]) {
        await admin.list(
          {
            text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
            values: [name],
          },
          10,
        );
        await admin.execute({ text: `DROP DATABASE "${name}"` });
      }
      await admin.close();
    },
  };
}

async function subscriber(
  owner: DatabasePool,
  email: string,
  status: string,
  wave: string | null = 'wave-1',
): Promise<string> {
  const id = randomUUID();
  await owner.execute({
    text: `INSERT INTO subscriber (id,email,email_normalised,email_domain,status,access_window,
      referral_tier,confirmed_referrals,category_preference,source,subslush_customer,
      marketing_consent_at,marketing_consent_version,marketing_consent_source)
      VALUES ($1,$2,$2,'example.test',$3,$4,1,3,ARRAY['apparel','home'],'referral',true,
      '2027-01-01T12:00:00Z','v1','signup')`,
    values: [id, email, status, wave],
  });
  if (status === 'verified') {
    await owner.execute({
      text: `INSERT INTO survey_response(id,subscriber_id,version,answers,first_answered_at)
        VALUES ($1,$2,'2026-09-08',$3::jsonb,$4)`,
      values: [
        randomUUID(),
        id,
        JSON.stringify({
          category_preference: ['apparel', 'home'],
          shopping_frequency: 'monthly',
        }),
        launch,
      ],
    });
  }
  return id;
}

async function heldDiscount(
  owner: DatabasePool,
  subscriberId: string,
): Promise<string> {
  const id = randomUUID();
  await owner.execute({
    text: `INSERT INTO milestone_award(id,subscriber_id,tier,reward_kind,state)
      VALUES ($1,$2,1,'discount','held')`,
    values: [id, subscriberId],
  });
  return id;
}

async function heldCoupon(
  owner: DatabasePool,
  subscriberId: string,
  couponNumber = 1,
  percent: number | null = 5,
  state: 'held' | 'void' = 'held',
): Promise<string> {
  const id = randomUUID();
  await owner.execute({
    text: `INSERT INTO referral_coupon
      (id,subscriber_id,coupon_number,percent,state,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    values: [id, subscriberId, couponNumber, percent, state, launch],
  });
  return id;
}

async function carryAudit(
  owner: DatabasePool,
  couponId: string,
): Promise<unknown> {
  return owner.readOne({
    text: `SELECT actor,subject_type,detail FROM audit_log
      WHERE action='handoff.coupon_carried' AND subject_id=$1`,
    values: [couponId],
  });
}

async function referralEdge(
  owner: DatabasePool,
  referrerId: string,
  referredId: string,
  state: 'confirmed' | 'attributed' = 'confirmed',
): Promise<void> {
  await owner.execute({
    text: `INSERT INTO referral_edge(id,referrer_id,referred_id,state,reward_state)
      VALUES ($1,$2,$3,$4,$5)`,
    values: [
      randomUUID(),
      referrerId,
      referredId,
      state,
      state === 'confirmed' ? 'settled' : 'none',
    ],
  });
}

/**
 * Confirmed referrals that earn a fixture's coupons, because the handoff first
 * recomputes every verified subscriber's coupons from their edges (D-047).
 * Each friend verified and then left the waitlist, so the edge counts for the
 * referrer while the friend is outside the export set and its referral pairs.
 */
async function departedFriends(
  owner: DatabasePool,
  referrerId: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const friendId = await subscriber(
      owner,
      `departed-${index}-${referrerId}@example.test`,
      'unsubscribed',
    );
    await referralEdge(owner, referrerId, friendId);
  }
}

test('handoff exports v1 and v2 categories with versions and imports both twice', async () => {
  const f = await fixture();
  try {
    await subscriber(f.owner, 'survey-v1@example.test', 'verified');
    const v2Id = await subscriber(
      f.owner,
      'survey-v2@example.test',
      'verified',
    );
    await f.owner.execute({
      text: `UPDATE survey_response SET version='2026-10-19',
        answers='{"category_preference":["ai","game_keys"],"shopping_frequency":"weekly"}'::jsonb
        WHERE subscriber_id=$1`,
      values: [v2Id],
    });
    await f.owner.execute({
      text: `UPDATE subscriber SET category_preference=ARRAY['ai','game_keys'] WHERE id=$1`,
      values: [v2Id],
    });
    const records: HandoffRecord[] = [];
    await exportHandoff(
      f.app,
      'operator',
      async (record) => {
        records.push(record);
      },
      async () => {},
    );
    const customers = records.filter((record) => record.type === 'customer');
    assert.deepEqual(
      customers
        .map(({ email_normalised, category_preference, survey_version }) => ({
          email_normalised,
          category_preference,
          survey_version,
        }))
        .sort((a, b) => a.email_normalised.localeCompare(b.email_normalised)),
      [
        {
          email_normalised: 'survey-v1@example.test',
          category_preference: ['apparel', 'home'],
          survey_version: '2026-09-08',
        },
        {
          email_normalised: 'survey-v2@example.test',
          category_preference: ['ai', 'game_keys'],
          survey_version: '2026-10-19',
        },
      ],
    );
    const lines = async function* () {
      for (const record of records) yield JSON.stringify(record);
    };
    const first = await importRehearsal(f.scratch, lines());
    const second = await importRehearsal(f.scratch, lines());
    assert.equal(first.createdCustomers, 2);
    assert.equal(second.createdCustomers, 0);
    const imported = await f.scratch.list<{ payload: HandoffRecord }>(
      {
        text: 'SELECT payload FROM rehearsal_customer ORDER BY email_normalised',
      },
      2,
    );
    assert.deepEqual(
      imported.map(({ payload }) => payload),
      [...customers].sort((a, b) =>
        a.email_normalised.localeCompare(b.email_normalised),
      ),
    );
  } finally {
    await f.dispose();
  }
});

test('unexpired unsubscribe tokens export by hash with origin and import idempotently', async () => {
  const f = await fixture();
  const at = new Date('2027-03-15T10:00:00.000Z');
  try {
    const id = await subscriber(
      f.owner,
      'suppressed-token@example.test',
      'verified',
    );
    await f.owner.execute({
      text: `INSERT INTO suppression(email_normalised,reason,source)
        VALUES ('suppressed-token@example.test','manual','test')`,
    });
    const tokenId = randomUUID();
    const hash = createHash('sha256').update('never-export-plaintext').digest();
    await f.owner.execute({
      text: `INSERT INTO verification_token
        (id,subscriber_id,token_hash,purpose,expires_at)
        VALUES ($1,$2,$3,'unsubscribe',$4)`,
      values: [tokenId, id, hash, new Date('2027-06-01T00:00:00.000Z')],
    });
    await f.owner.execute({
      text: `INSERT INTO email_send
        (id,subscriber_id,template,provider,business_key,state,unsubscribe_token_id)
        VALUES ($1,$2,'weekly_campaign','brevo',$3,'sent',$4)`,
      values: [randomUUID(), id, `weekly:${id}`, tokenId],
    });
    const transactionalId = randomUUID();
    const transactionalHash = createHash('sha256')
      .update('transactional-token')
      .digest();
    await f.owner.execute({
      text: `INSERT INTO verification_token
        (id,subscriber_id,token_hash,purpose,expires_at)
        VALUES ($1,$2,$3,'unsubscribe',$4)`,
      values: [
        transactionalId,
        id,
        transactionalHash,
        new Date('2027-06-01T00:00:00.000Z'),
      ],
    });
    await f.owner.execute({
      text: `INSERT INTO email_send
        (id,subscriber_id,template,provider,business_key,state,unsubscribe_token_id)
        VALUES ($1,$2,'verification_complete','resend',$3,'sent',$4)`,
      values: [randomUUID(), id, `transactional:${id}`, transactionalId],
    });
    for (const [label, expiresAt, consumedAt] of [
      ['expired', '2027-03-14T00:00:00.000Z', null],
      ['consumed', '2027-06-01T00:00:00.000Z', '2027-03-14T00:00:00.000Z'],
    ] as const) {
      const excludedId = randomUUID();
      await f.owner.execute({
        text: `INSERT INTO verification_token
          (id,subscriber_id,token_hash,purpose,expires_at,consumed_at)
          VALUES ($1,$2,$3,'unsubscribe',$4,$5)`,
        values: [
          excludedId,
          id,
          createHash('sha256').update(label).digest(),
          new Date(expiresAt),
          consumedAt ? new Date(consumedAt) : null,
        ],
      });
      await f.owner.execute({
        text: `INSERT INTO email_send
          (id,subscriber_id,template,provider,business_key,state,unsubscribe_token_id)
          VALUES ($1,$2,'weekly_campaign','brevo',$3,'sent',$4)`,
        values: [randomUUID(), id, `${label}:${id}`, excludedId],
      });
    }
    const records: HandoffRecord[] = [];
    const counts = await exportHandoff(
      f.app,
      'operator',
      async (record) => {
        records.push(record);
      },
      async () => {},
      () => at,
    );
    assert.equal(counts.customers, 0);
    assert.equal(counts.unsubscribeTokens, 2);
    assert.deepEqual(
      records.sort((left, right) =>
        left.type === 'unsubscribe_token' && right.type === 'unsubscribe_token'
          ? left.origin_kind.localeCompare(right.origin_kind)
          : 0,
      ),
      [
        {
          type: 'unsubscribe_token',
          token_sha256: hash.toString('hex'),
          email_normalised: 'suppressed-token@example.test',
          origin_kind: 'marketing',
          expires_at: '2027-06-01T00:00:00.000Z',
        },
        {
          type: 'unsubscribe_token',
          token_sha256: transactionalHash.toString('hex'),
          email_normalised: 'suppressed-token@example.test',
          origin_kind: 'transactional',
          expires_at: '2027-06-01T00:00:00.000Z',
        },
      ],
    );
    const lines = async function* () {
      for (const record of records) yield JSON.stringify(record);
    };
    assert.equal((await importRehearsal(f.scratch, lines())).createdTokens, 2);
    assert.equal((await importRehearsal(f.scratch, lines())).createdTokens, 0);
    assert.equal((await countRehearsalRows(f.scratch)).tokens, 2);
    await assert.rejects(
      importRehearsalBatch(f.scratch, [
        {
          ...records[0]!,
          origin_kind: 'transactional',
        } as HandoffRecord,
      ]),
      /conflicting data/u,
    );
  } finally {
    await f.dispose();
  }
});

test('handoff preflight refuses an unpublished draw', async () => {
  const f = await fixture();
  try {
    await assert.rejects(assertCutoverEligible(f.app), /published draw/u);
  } finally {
    await f.dispose();
  }
});

test('handoff preflight refuses a published draw with a nonterminal award', async () => {
  const f = await fixture();
  try {
    const personId = await subscriber(
      f.owner,
      'award@example.test',
      'verified',
    );
    const drawId = randomUUID();
    const entryId = randomUUID();
    const committedAt = new Date('2027-03-14T00:00:00.000Z');
    await f.owner.execute({
      text: 'INSERT INTO giveaway_draw(id,executed_by) VALUES ($1,$2)',
      values: [drawId, 'operator'],
    });
    await f.owner.execute({
      text: `INSERT INTO giveaway_entry
        (id,subscriber_id,method,entries,rules_version,rules_sha256)
        VALUES ($1,$2,'base',1,'VAL-GW-LAUNCH-20261009-r1',$3)`,
      values: [entryId, personId, Buffer.alloc(32)],
    });
    await f.owner.execute({
      text: `INSERT INTO giveaway_draw_snapshot_row
        (draw_id,entry_id,subscriber_id,method,rules_version,rules_sha256)
        VALUES ($1,$2,$3,'base','VAL-GW-LAUNCH-20261009-r1',$4)`,
      values: [drawId, entryId, personId, Buffer.alloc(32)],
    });
    await f.owner.execute({
      text: `INSERT INTO giveaway_draw_selection
        (draw_id,position,subscriber_id,entry_id,is_winner)
        VALUES ($1,1,$2,$3,true)`,
      values: [drawId, personId, entryId],
    });
    await f.owner.execute({
      text: `UPDATE giveaway_draw SET snapshot_committed_at=$2,
        entry_snapshot_hash=$3,snapshot_count=1,prize_count=1,
        rules_version='VAL-GW-LAUNCH-20261009-r1',rules_sha256=$3,
        drand_chain_hash=$3,drand_chain_info='{}'::jsonb,
        target_round=1,target_round_at=$4 WHERE id=$1`,
      values: [
        drawId,
        committedAt,
        Buffer.alloc(32),
        new Date(committedAt.getTime() + 10 * 60_000),
      ],
    });
    await f.owner.execute({
      text: `UPDATE giveaway_draw SET state='published',seed=$2,
        seed_generated_at=$3,beacon_round=1,beacon_randomness=$4,
        beacon_signature=$4,beacon_relay_used='fixture',
        beacon_verified_relays='["one","two"]'::jsonb,
        winners=$5::jsonb,reproduced_at=$3,published_at=$3 WHERE id=$1`,
      values: [
        drawId,
        '0'.repeat(64),
        new Date(committedAt.getTime() + 20 * 60_000),
        Buffer.alloc(32),
        JSON.stringify([personId]),
      ],
    });
    const awardId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO giveaway_award
        (id,draw_id,prize_slot,entry_snapshot_hash,selection_position,
        entry_id,subscriber_id,state,notified_at,response_deadline_at)
        VALUES ($1,$2,1,$3,1,$4,$5,'notified',$6,$7)`,
      values: [
        awardId,
        drawId,
        Buffer.alloc(32),
        entryId,
        personId,
        new Date('2027-03-15T00:00:00.000Z'),
        new Date('2027-03-29T00:00:00.000Z'),
      ],
    });
    await assert.rejects(assertCutoverEligible(f.app), /terminal awards/u);
    await f.owner.execute({
      text: `UPDATE giveaway_award SET state='exhausted' WHERE id=$1`,
      values: [awardId],
    });
    await assertCutoverEligible(f.app);
  } finally {
    await f.dispose();
  }
});

test('handoff exports verified unsuppressed customers, eligible held coupons and audited legacy voids', async () => {
  const f = await fixture();
  try {
    const included = await subscriber(
      f.owner,
      'included@example.test',
      'verified',
      'wave-2',
    );
    // 21 confirmed referrals earn coupon 1 at 30% and coupon 2 at 5%.
    await departedFriends(f.owner, included, 21);
    await subscriber(f.owner, 'pending@example.test', 'pending');
    await subscriber(f.owner, 'expired@example.test', 'expired');
    await subscriber(f.owner, 'disqualified@example.test', 'disqualified');
    await subscriber(f.owner, 'suppressed@example.test', 'verified');
    await f.owner.execute({
      text: `INSERT INTO suppression(email_normalised,reason,source)
      VALUES ('suppressed@example.test','manual','test')`,
    });
    // A retired held discount (E11.7-03): kept, never exported.
    const discountId = randomUUID();
    const legacyId = randomUUID();
    const settledLegacyId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO milestone_award(id,subscriber_id,tier,reward_kind,state)
        VALUES ($1,$2,1,'discount','held'),
          ($3,$2,1,'entries','held'),($4,$2,2,'entries','settled')`,
      values: [discountId, included, legacyId, settledLegacyId],
    });
    const couponId = await heldCoupon(f.owner, included, 1, 30);
    const secondCouponId = await heldCoupon(f.owner, included, 2, 5);
    const voidCouponId = await heldCoupon(f.owner, included, 3, null, 'void');
    const records: HandoffRecord[] = [];
    const counts = await exportHandoff(
      f.app,
      'operator',
      async (record) => {
        records.push(record);
      },
      async () => {},
    );
    assert.deepEqual(counts, {
      customers: 1,
      heldCoupons: 2,
      confirmedReferrals: 0,
      unsubscribeTokens: 0,
      voidedIneligibleDiscounts: 0,
      voidedLegacyBonusEntries: 2,
      recomputedRewards: 0,
    });
    assert.equal(records.length, 3);
    const customer = records.find((record) => record.type === 'customer');
    assert.deepEqual(customer, {
      type: 'customer',
      email: 'included@example.test',
      email_normalised: 'included@example.test',
      // Recomputed before export: no settled award, 21 confirmed edges.
      referral_tier: 0,
      referral_code: null,
      confirmed_referrals: 21,
      category_preference: ['apparel', 'home'],
      survey_version: '2026-09-08',
      source: 'referral',
      marketing_consent_at: '2027-01-01T12:00:00.000Z',
      marketing_consent_version: 'v1',
      marketing_consent_source: 'signup',
      access_window: 'wave-2',
      subslush_customer: true,
      groups: ['wave-2', 'subslush-legacy'],
    });
    assert.deepEqual(
      records
        .filter((record) => record.type === 'held_coupon')
        .sort((left, right) => left.coupon_id.localeCompare(right.coupon_id)),
      [
        {
          type: 'held_coupon',
          coupon_id: couponId,
          subscriber_id: included,
          email_normalised: 'included@example.test',
          coupon_number: 1,
          percent: 30,
          state: 'held',
          outcome: 'carried_to_storefront',
          expires_at: couponExpiry,
        },
        {
          type: 'held_coupon',
          coupon_id: secondCouponId,
          subscriber_id: included,
          email_normalised: 'included@example.test',
          coupon_number: 2,
          percent: 5,
          state: 'held',
          outcome: 'carried_to_storefront',
          expires_at: couponExpiry,
        },
      ].sort((left, right) => left.coupon_id.localeCompare(right.coupon_id)),
    );
    assert.equal(couponExpiresAt().toISOString(), couponExpiry);
    assert.ok(
      records.every(
        (record) =>
          !Object.hasOwn(record, 'country') &&
          !Object.hasOwn(record, 'reward_kind') &&
          (record.type as string) !== 'held_discount' &&
          !Object.hasOwn(record, 'qualification_deadline'),
      ),
    );
    const run = await f.owner.readOne<{
      detail: Record<string, unknown>;
    }>({
      text: `SELECT detail FROM audit_log WHERE action='export.run' AND subject_type='handoff'`,
    });
    assert.equal(run?.detail.held_coupon_count, 2);
    assert.equal(run?.detail.coupon_expires_at, couponExpiry);
    assert.ok(!Object.hasOwn(run?.detail ?? {}, 'qualification_deadline'));
    assert.deepEqual(
      await f.owner.readOne({
        text: 'SELECT state FROM milestone_award WHERE id=$1',
        values: [legacyId],
      }),
      { state: 'void' },
    );
    assert.deepEqual(
      await f.owner.readOne({
        text: 'SELECT state FROM milestone_award WHERE id=$1',
        values: [settledLegacyId],
      }),
      { state: 'void' },
    );
    assert.deepEqual(
      await f.owner.readOne({
        text: 'SELECT state FROM milestone_award WHERE id=$1',
        values: [discountId],
      }),
      { state: 'held' },
    );
    const voidAudit = await f.owner.readOne<{
      actor: string;
      detail: { reason: string };
    }>({
      text: "SELECT actor,detail FROM audit_log WHERE action='handoff.bonus_entries_voided' AND subject_id=$1",
      values: [legacyId],
    });
    assert.equal(voidAudit?.actor, 'operator');
    assert.equal(
      voidAudit?.detail.reason,
      'bonus_entries_unqualifiable_under_published_rules',
    );
    for (const id of [couponId, secondCouponId]) {
      assert.deepEqual(await carryAudit(f.owner, id), {
        actor: 'operator',
        subject_type: 'referral_coupon',
        detail: {
          outcome: 'carried_to_storefront',
          expires_at: couponExpiry,
        },
      });
    }
    assert.equal(await carryAudit(f.owner, voidCouponId), null);
    assert.equal(
      await f.owner.readOne({
        text: `SELECT id FROM audit_log WHERE action='handoff.discount_carried' AND subject_id=$1`,
        values: [discountId],
      }),
      null,
    );
    const second: HandoffRecord[] = [];
    assert.deepEqual(
      await exportHandoff(
        f.app,
        'operator',
        async (record) => {
          second.push(record);
        },
        async () => {},
      ),
      {
        customers: 1,
        heldCoupons: 2,
        confirmedReferrals: 0,
        unsubscribeTokens: 0,
        voidedIneligibleDiscounts: 0,
        voidedLegacyBonusEntries: 0,
        recomputedRewards: 0,
      },
    );
    assert.deepEqual(second, records);

    const lines = async function* () {
      for (const record of records) yield JSON.stringify(record);
    };
    assert.deepEqual(await importRehearsal(f.scratch, lines()), {
      createdCustomers: 1,
      createdGroups: 2,
      createdCoupons: 2,
      createdReferrals: 0,
      createdTokens: 0,
    });
    assert.deepEqual(await importRehearsal(f.scratch, lines()), {
      createdCustomers: 0,
      createdGroups: 0,
      createdCoupons: 0,
      createdReferrals: 0,
      createdTokens: 0,
    });
    assert.deepEqual(await countRehearsalRows(f.scratch), {
      customers: 1,
      groups: 2,
      coupons: 2,
      referrals: 0,
      tokens: 0,
    });
  } finally {
    await f.dispose();
  }
});

test('the export fields: coupons recomputed by real confirmations are carried held with percent and computed expiry', async () => {
  const f = await fixture();
  try {
    const referrerId = await subscriber(
      f.owner,
      'ladder@example.test',
      'verified',
    );
    const referral = createReferralService(f.app);
    const referredIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const referredId = await subscriber(
        f.owner,
        `friend-${index}@example.test`,
        'verified',
      );
      await referralEdge(f.owner, referrerId, referredId, 'attributed');
      await referral.confirm(referredId, launch);
      referredIds.push(referredId);
    }
    const exportCoupons = async () => {
      const records: HandoffRecord[] = [];
      const counts = await exportHandoff(
        f.app,
        'operator',
        async (record) => {
          records.push(record);
        },
        async () => {},
      );
      return {
        counts,
        coupons: records
          .filter((record) => record.type === 'held_coupon')
          .map((record) =>
            Object.fromEntries(
              Object.entries(record).filter(([key]) => key !== 'coupon_id'),
            ),
          )
          .sort(
            (left, right) =>
              Number(left.coupon_number) - Number(right.coupon_number),
          ),
      };
    };
    const fields = (couponNumber: number, percent: number) => ({
      type: 'held_coupon',
      subscriber_id: referrerId,
      email_normalised: 'ladder@example.test',
      coupon_number: couponNumber,
      percent,
      state: 'held',
      outcome: 'carried_to_storefront',
      expires_at: couponExpiry,
    });

    // 21 confirmed referrals: coupon 1 at 30% and coupon 2 at 5%.
    const first = await exportCoupons();
    assert.equal(first.counts.heldCoupons, 2);
    assert.equal(first.counts.confirmedReferrals, 21);
    assert.deepEqual(first.coupons, [fields(1, 30), fields(2, 5)]);

    // A void below coupon 2's unlock leaves it void, and a void coupon is
    // never carried.
    await createReferralVoidService(f.app, () => launch).voidReferral(
      referredIds[0]!,
      'Duplicate household',
      'founder',
    );
    const second = await exportCoupons();
    assert.equal(second.counts.heldCoupons, 1);
    assert.deepEqual(second.coupons, [fields(1, 30)]);
    assert.deepEqual(
      await f.owner.list(
        {
          text: `SELECT coupon_number, percent, state FROM referral_coupon
            WHERE subscriber_id=$1 ORDER BY coupon_number`,
          values: [referrerId],
        },
        5,
      ),
      [
        { coupon_number: 1, percent: 30, state: 'held' },
        { coupon_number: 2, percent: null, state: 'void' },
      ],
    );
  } finally {
    await f.dispose();
  }
});

test('failed handoff output does not audit a carried coupon', async () => {
  const f = await fixture();
  try {
    const ownerId = await subscriber(f.owner, 'owner@example.test', 'verified');
    const referredId = await subscriber(
      f.owner,
      'referred@example.test',
      'verified',
    );
    const couponId = await heldCoupon(f.owner, ownerId);
    await referralEdge(f.owner, ownerId, referredId);
    // Three confirmed referrals earn the 5% coupon.
    await departedFriends(f.owner, ownerId, 2);
    await assert.rejects(
      exportHandoff(
        f.app,
        'operator',
        async (record) => {
          if (record.type === 'confirmed_referral')
            throw new Error('write failed');
        },
        async () => {},
      ),
      /write failed/u,
    );
    assert.equal(await carryAudit(f.owner, couponId), null);
    await assert.rejects(
      exportHandoff(
        f.app,
        'operator',
        async () => {},
        async () => {
          throw new Error('finish failed');
        },
      ),
      /finish failed/u,
    );
    assert.equal(await carryAudit(f.owner, couponId), null);
  } finally {
    await f.dispose();
  }
});

test('handoff import rejects missing or extra fields, a changed expiry, retired discounts and bonus entries', () => {
  const customer = {
    type: 'customer',
    email: 'a@example.test',
    email_normalised: 'a@example.test',
    referral_tier: 0,
    referral_code: null,
    confirmed_referrals: 0,
    category_preference: null,
    survey_version: null,
    source: null,
    marketing_consent_at: null,
    marketing_consent_version: null,
    marketing_consent_source: null,
    access_window: 'wave-1',
    subslush_customer: false,
    groups: ['wave-1'],
  };
  assert.deepEqual(parseHandoffRecord(customer), customer);
  assert.throws(
    () => parseHandoffRecord({ ...customer, survey_version: undefined }),
    TypeError,
  );
  assert.throws(
    () =>
      parseHandoffRecord({
        ...customer,
        category_preference: ['apparel'],
        survey_version: '2026-10-19',
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseHandoffRecord({
        ...customer,
        category_preference: ['game_keys'],
        survey_version: '2026-09-08',
      }),
    TypeError,
  );
  assert.throws(
    () => parseHandoffRecord({ ...customer, country: 'SE' }),
    TypeError,
  );
  assert.throws(
    () => parseHandoffRecord({ ...customer, groups: [] }),
    TypeError,
  );
  assert.throws(
    () =>
      parseHandoffRecord({
        ...customer,
        marketing_consent_at: '2027-01-01T00:00:00.000Z',
      }),
    TypeError,
  );
  assert.throws(
    () => parseHandoffRecord({ type: 'held_bonus_entries' }),
    TypeError,
  );
  const coupon = {
    type: 'held_coupon',
    coupon_id: randomUUID(),
    subscriber_id: randomUUID(),
    email_normalised: 'a@example.test',
    coupon_number: 1,
    percent: 30,
    state: 'held',
    outcome: 'carried_to_storefront',
    expires_at: couponExpiry,
  };
  assert.deepEqual(parseHandoffRecord(coupon), coupon);
  for (const changed of [
    { expires_at: null },
    // A changed expiry, including the retired 90-day deadline shape.
    { expires_at: '2027-06-13T10:00:00.000Z' },
    { expires_at: '2032-09-01T00:00:00Z' },
    { percent: 0 },
    { percent: 101 },
    { percent: 5.5 },
    { coupon_number: 0 },
    { state: 'settled' },
    { state: 'void' },
    { outcome: 'settled' },
    { email_normalised: null },
    { coupon_id: 'not-a-uuid' },
    { qualification_deadline: '2027-06-13T10:00:00.000Z' },
  ]) {
    assert.throws(
      () => parseHandoffRecord({ ...coupon, ...changed }),
      TypeError,
      JSON.stringify(changed),
    );
  }
  const missingExpiry: Partial<typeof coupon> = { ...coupon };
  delete missingExpiry.expires_at;
  assert.throws(() => parseHandoffRecord(missingExpiry), TypeError);
  // The retired milestone discount is no longer a handoff record (E11.7-03).
  assert.throws(
    () =>
      parseHandoffRecord({
        type: 'held_discount',
        award_id: randomUUID(),
        subscriber_id: randomUUID(),
        email_normalised: 'a@example.test',
        tier: 1,
        discount_percent: 15,
        state: 'held',
        outcome: 'carried_to_storefront',
        qualification_deadline: '2027-06-13T10:00:00.000Z',
      }),
    TypeError,
  );
  const referral = {
    type: 'confirmed_referral',
    referrer_email_normalised: 'a@example.test',
    referred_email_normalised: 'b@example.test',
  };
  assert.deepEqual(parseHandoffRecord(referral), referral);
  assert.throws(
    () => parseHandoffRecord({ ...referral, extra: true }),
    TypeError,
  );
});

for (const scenario of [
  {
    label: 'disqualified',
    status: 'disqualified',
    suppressed: false,
    reason: 'owner_disqualified',
  },
  {
    label: 'suppressed',
    status: 'verified',
    suppressed: true,
    reason: 'owner_not_in_handoff',
  },
  {
    label: 'left the waitlist',
    status: 'unsubscribed',
    suppressed: false,
    reason: 'owner_not_in_handoff',
  },
] as const) {
  test(`held coupon owner ${scenario.label} is excluded, and a held discount is voided with an audited outcome`, async () => {
    const f = await fixture();
    try {
      const email = `${scenario.label.replaceAll(' ', '-')}@example.test`;
      const ownerId = await subscriber(f.owner, email, scenario.status);
      const awardId = await heldDiscount(f.owner, ownerId);
      // Six confirmed referrals earn the 10% coupon.
      await departedFriends(f.owner, ownerId, 6);
      const couponId = await heldCoupon(f.owner, ownerId, 1, 10);
      if (scenario.suppressed) {
        await f.owner.execute({
          text: `INSERT INTO suppression(email_normalised,reason,source) VALUES ($1,'manual','test')`,
          values: [email],
        });
      }
      const records: HandoffRecord[] = [];
      const counts = await exportHandoff(
        f.app,
        'operator',
        async (record) => {
          records.push(record);
        },
        async () => {},
      );
      assert.equal(counts.voidedIneligibleDiscounts, 1);
      assert.equal(counts.heldCoupons, 0);
      assert.deepEqual(records, []);
      // Outside the export set, the coupon is neither carried nor audited.
      assert.equal(await carryAudit(f.owner, couponId), null);
      assert.deepEqual(
        await f.owner.readOne({
          text: 'SELECT state FROM milestone_award WHERE id=$1',
          values: [awardId],
        }),
        { state: 'void' },
      );
      assert.deepEqual(
        await f.owner.readOne({
          text: `SELECT actor,detail FROM audit_log WHERE action='handoff.discount_voided' AND subject_id=$1`,
          values: [awardId],
        }),
        { actor: 'operator', detail: { reason: scenario.reason } },
      );
    } finally {
      await f.dispose();
    }
  });
}

test('marketing-withdrawn verified owner retains the held coupon and an audited carry outcome', async () => {
  const f = await fixture();
  try {
    const ownerId = await subscriber(
      f.owner,
      'withdrawn@example.test',
      'verified',
    );
    await f.owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at=NULL,marketing_consent_version=NULL,marketing_consent_source=NULL WHERE id=$1`,
      values: [ownerId],
    });
    // Three confirmed referrals earn the 5% coupon.
    await departedFriends(f.owner, ownerId, 3);
    const couponId = await heldCoupon(f.owner, ownerId);
    const records: HandoffRecord[] = [];
    const counts = await exportHandoff(
      f.app,
      'operator',
      async (record) => {
        records.push(record);
      },
      async () => {},
    );
    assert.equal(counts.heldCoupons, 1);
    assert.equal(counts.voidedIneligibleDiscounts, 0);
    assert.equal(
      records.find((record) => record.type === 'held_coupon')?.email_normalised,
      'withdrawn@example.test',
    );
    assert.deepEqual(await carryAudit(f.owner, couponId), {
      actor: 'operator',
      subject_type: 'referral_coupon',
      detail: {
        outcome: 'carried_to_storefront',
        expires_at: couponExpiry,
      },
    });
  } finally {
    await f.dispose();
  }
});

test('erased owner has no coupon or identity to export after E9-05 erasure', async () => {
  const f = await fixture();
  try {
    const ownerId = await subscriber(
      f.owner,
      'erased@example.test',
      'verified',
    );
    const awardId = await heldDiscount(f.owner, ownerId);
    const couponId = await heldCoupon(f.owner, ownerId);
    await withTransaction(f.owner, async (connection) => {
      await connection.execute({
        text: `INSERT INTO dsr_erasure(subscriber_id,requested_at,next_attempt_at)
          VALUES ($1,'2027-01-01T00:00:00Z','2027-01-01T00:00:00Z')`,
        values: [ownerId],
      });
      await connection.execute({
        text: `UPDATE subscriber SET status='erasure_pending',marketing_consent_at=NULL,marketing_consent_version=NULL,marketing_consent_source=NULL WHERE id=$1`,
        values: [ownerId],
      });
      await connection.execute({
        text: `DELETE FROM milestone_award WHERE id=$1`,
        values: [awardId],
      });
      await connection.execute({
        text: `DELETE FROM referral_coupon WHERE id=$1`,
        values: [couponId],
      });
      await connection.readOne({
        text: 'SELECT erase_subscriber_identity($1)',
        values: [ownerId],
      });
      await connection.execute({
        text: `INSERT INTO erasure_ledger(subscriber_id,erased_at) VALUES ($1,'2027-01-02T00:00:00Z')`,
        values: [ownerId],
      });
      await connection.execute({
        text: `UPDATE dsr_erasure SET completed_at='2027-01-02T00:00:00Z' WHERE subscriber_id=$1`,
        values: [ownerId],
      });
    });
    const records: HandoffRecord[] = [];
    const counts = await exportHandoff(
      f.app,
      'operator',
      async (record) => {
        records.push(record);
      },
      async () => {},
    );
    assert.equal(counts.heldCoupons, 0);
    assert.deepEqual(records, []);
    assert.equal(
      await f.owner.readOne({
        text: 'SELECT id FROM milestone_award WHERE id=$1',
        values: [awardId],
      }),
      null,
    );
    assert.equal(
      await f.owner.readOne({
        text: 'SELECT id FROM referral_coupon WHERE id=$1',
        values: [couponId],
      }),
      null,
    );
  } finally {
    await f.dispose();
  }
});

test('confirmed referral links include only pairs whose two people are exported and import idempotently', async () => {
  const f = await fixture();
  try {
    const referrer = await subscriber(
      f.owner,
      'referrer@example.test',
      'verified',
    );
    const referred = await subscriber(
      f.owner,
      'referred@example.test',
      'verified',
    );
    const pending = await subscriber(
      f.owner,
      'pending@example.test',
      'pending',
    );
    const suppressed = await subscriber(
      f.owner,
      'suppressed@example.test',
      'verified',
    );
    const attributed = await subscriber(
      f.owner,
      'attributed@example.test',
      'verified',
    );
    await f.owner.execute({
      text: `INSERT INTO suppression(email_normalised,reason,source) VALUES ('suppressed@example.test','manual','test')`,
    });
    await referralEdge(f.owner, referrer, referred);
    await referralEdge(f.owner, referrer, pending);
    await referralEdge(f.owner, referrer, suppressed);
    await referralEdge(f.owner, referrer, attributed, 'attributed');
    const records: HandoffRecord[] = [];
    const counts = await exportHandoff(
      f.app,
      'operator',
      async (record) => {
        records.push(record);
      },
      async () => {},
    );
    assert.equal(counts.confirmedReferrals, 1);
    assert.deepEqual(
      records.filter((record) => record.type === 'confirmed_referral'),
      [
        {
          type: 'confirmed_referral',
          referrer_email_normalised: 'referrer@example.test',
          referred_email_normalised: 'referred@example.test',
        },
      ],
    );
    const lines = async function* () {
      for (const record of records) yield JSON.stringify(record);
    };
    const first = await importRehearsal(f.scratch, lines());
    assert.equal(first.createdReferrals, 1);
    assert.deepEqual(await importRehearsal(f.scratch, lines()), {
      createdCustomers: 0,
      createdGroups: 0,
      createdCoupons: 0,
      createdReferrals: 0,
      createdTokens: 0,
    });
    assert.equal((await countRehearsalRows(f.scratch)).referrals, 1);
  } finally {
    await f.dispose();
  }
});

test('a failed legacy-void audit rolls the award transition back', async () => {
  const f = await fixture();
  try {
    const ownerId = await subscriber(f.owner, 'owner@example.test', 'verified');
    const awardId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO milestone_award(id,subscriber_id,tier,reward_kind,state)
        VALUES ($1,$2,1,'entries','held')`,
      values: [awardId, ownerId],
    });
    await assert.rejects(
      voidLegacyBonusBatch(f.app, async () => {
        throw new Error('audit unavailable');
      }),
      /audit unavailable/u,
    );
    assert.deepEqual(
      await f.owner.readOne({
        text: 'SELECT state FROM milestone_award WHERE id=$1',
        values: [awardId],
      }),
      { state: 'held' },
    );
  } finally {
    await f.dispose();
  }
});

test('scratch import rejects a conflicting idempotency key and enforces the batch cap', async () => {
  const f = await fixture();
  try {
    const coupon = parseHandoffRecord({
      type: 'held_coupon',
      coupon_id: randomUUID(),
      subscriber_id: randomUUID(),
      email_normalised: 'owner@example.test',
      coupon_number: 1,
      percent: 15,
      state: 'held',
      outcome: 'carried_to_storefront',
      expires_at: couponExpiry,
    });
    if (coupon.type !== 'held_coupon')
      throw new Error('Expected a held coupon fixture.');
    const customer = parseHandoffRecord({
      type: 'customer',
      email: 'owner@example.test',
      email_normalised: 'owner@example.test',
      referral_tier: 0,
      referral_code: null,
      confirmed_referrals: 0,
      category_preference: null,
      survey_version: null,
      source: null,
      marketing_consent_at: null,
      marketing_consent_version: null,
      marketing_consent_source: null,
      access_window: 'wave-1',
      subslush_customer: false,
      groups: ['wave-1'],
    });
    await importRehearsalBatch(f.scratch, [customer]);
    await assert.rejects(
      importRehearsalBatch(f.scratch, [
        {
          ...coupon,
          coupon_id: randomUUID(),
          email_normalised: 'outside@example.test',
        },
      ]),
      /foreign key constraint/u,
    );
    assert.deepEqual(await importRehearsalBatch(f.scratch, [coupon]), {
      createdCustomers: 0,
      createdGroups: 0,
      createdCoupons: 1,
      createdReferrals: 0,
      createdTokens: 0,
    });
    await assert.rejects(
      importRehearsalBatch(f.scratch, [
        {
          type: 'confirmed_referral',
          referrer_email_normalised: 'owner@example.test',
          referred_email_normalised: 'outside@example.test',
        },
      ]),
      /foreign key constraint/u,
    );
    await assert.rejects(
      importRehearsalBatch(f.scratch, [{ ...coupon, percent: 20 }]),
      /conflicting data/u,
    );
    await assert.rejects(
      importRehearsalBatch(f.scratch, [
        { ...coupon, expires_at: '2032-09-02T00:00:00.000Z' },
      ]),
      /conflicting data/u,
    );
    // One coupon per owner and coupon number, whatever its ID.
    await assert.rejects(
      importRehearsalBatch(f.scratch, [{ ...coupon, coupon_id: randomUUID() }]),
      /unique constraint/u,
    );
    assert.deepEqual(await countRehearsalRows(f.scratch), {
      customers: 1,
      groups: 1,
      coupons: 1,
      referrals: 0,
      tokens: 0,
    });
    await assert.rejects(
      importRehearsalBatch(
        f.scratch,
        Array.from({ length: rehearsalBatchSize + 1 }, () => coupon),
      ),
      RangeError,
    );
  } finally {
    await f.dispose();
  }
});

test('handoff pages over more than one capped batch', async () => {
  const f = await fixture();
  try {
    await f.owner.execute({
      text: `INSERT INTO subscriber(id,email,email_normalised,email_domain,status,access_window)
        SELECT md5(n::text)::uuid, 'bulk-'||n||'@example.test', 'bulk-'||n||'@example.test',
          'example.test','verified','wave-4' FROM generate_series(1,1001) n`,
    });
    await f.owner.execute({
      text: `INSERT INTO referral_coupon(id,subscriber_id,coupon_number,percent,state,created_at,updated_at)
        SELECT gen_random_uuid(), md5(n::text)::uuid, 1, 5, 'held', $1, $1
        FROM generate_series(1,1001) n`,
      values: [launch],
    });
    // Three confirmed referrals each, from friends who left the waitlist, earn
    // every 5% coupon in the recompute before export (D-047).
    await f.owner.execute({
      text: `INSERT INTO subscriber(id,email,email_normalised,email_domain,status)
        SELECT md5('friend-'||n)::uuid, 'friend-'||n||'@example.test', 'friend-'||n||'@example.test',
          'example.test','unsubscribed' FROM generate_series(1,3003) n`,
    });
    await f.owner.execute({
      text: `INSERT INTO referral_edge(id,referrer_id,referred_id,state,reward_state)
        SELECT gen_random_uuid(), md5(((n+2)/3)::text)::uuid, md5('friend-'||n)::uuid,
          'confirmed','settled' FROM generate_series(1,3003) n`,
    });
    const emitted = { customer: 0, held_coupon: 0 };
    const counts = await exportHandoff(
      f.app,
      'operator',
      async (record) => {
        assert.ok(record.type === 'customer' || record.type === 'held_coupon');
        emitted[record.type] += 1;
      },
      async () => {},
    );
    assert.deepEqual(emitted, { customer: 1001, held_coupon: 1001 });
    const carried = await f.owner.readOne<{ count: number }>({
      text: `SELECT count(*)::int AS count FROM audit_log WHERE action='handoff.coupon_carried'`,
    });
    assert.equal(carried?.count, 1001);
    assert.deepEqual(counts, {
      customers: 1001,
      heldCoupons: 1001,
      confirmedReferrals: 0,
      unsubscribeTokens: 0,
      voidedIneligibleDiscounts: 0,
      voidedLegacyBonusEntries: 0,
      recomputedRewards: 0,
    });
  } finally {
    await f.dispose();
  }
});

/**
 * The pool, passed through, recording each batch the handoff recompute locks:
 * the limit it asked for and the rows it got.
 */
function observeRecomputeBatches(
  database: DatabasePool,
  batches: { limit: number; rows: number }[],
): DatabasePool {
  const recomputeLock =
    /FROM subscriber\s+WHERE status = 'verified'[\s\S]*FOR UPDATE/u;
  return new Proxy(database, {
    get(target, key) {
      if (key === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(inner, innerKey) {
              if (innerKey === 'list')
                return async (statement: SqlStatement, limit: number) => {
                  const rows = await inner.list(statement, limit);
                  if (recomputeLock.test(statement.text))
                    batches.push({ limit, rows: rows.length });
                  return rows;
                };
              const value: unknown = Reflect.get(inner, innerKey, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('the handoff recompute: a changed ladder reaches every verified subscriber before export, in audited batches of at most 1,000', async () => {
  const f = await fixture();
  try {
    // The lowest and highest IDs, so one referrer is in the first batch and
    // the other is beyond it.
    const first = '00000000-0000-4000-8000-000000000001';
    const beyond = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const verified = async (id: string, window: AccessWindow) =>
      f.owner.execute({
        text: `INSERT INTO subscriber(id,email,email_normalised,email_domain,status,
            verified_at,verification_order_window,access_window)
          VALUES ($1,$2,$2,'example.test','verified',$3,$4,$4)`,
        values: [id, `${id}@example.test`, launch, window],
      });
    // The first referrer holds a first-1,000 place, the other does not.
    await verified(first, 'wave-1');
    await verified(beyond, 'wave-3');
    await f.owner.execute({
      text: `INSERT INTO subscriber(id,email,email_normalised,email_domain,status,
          verified_at,verification_order_window,access_window)
        SELECT md5('member-'||n)::uuid, 'member-'||n||'@example.test',
          'member-'||n||'@example.test','example.test','verified',$1,'wave-4','wave-4'
        FROM generate_series(1,1000) n`,
      values: [launch],
    });
    // Confirmations under the configured ladder.
    const referral = createReferralService(f.app);
    const confirmFriends = async (referrerId: string, count: number) => {
      for (let index = 0; index < count; index += 1) {
        const friendId = randomUUID();
        await verified(friendId, 'wave-4');
        await referralEdge(f.owner, referrerId, friendId, 'attributed');
        await referral.confirm(friendId, launch);
      }
    };
    await confirmFriends(first, 21);
    await confirmFriends(beyond, 4);
    const storedCoupons = async (id: string) =>
      f.owner.list(
        {
          text: `SELECT coupon_number AS number, percent, state FROM referral_coupon
            WHERE subscriber_id=$1 ORDER BY coupon_number`,
          values: [id],
        },
        10,
      );
    assert.deepEqual(await storedCoupons(first), [
      { number: 1, percent: 30, state: 'held' },
      { number: 2, percent: 5, state: 'held' },
    ]);
    assert.deepEqual(await storedCoupons(beyond), [
      { number: 1, percent: 5, state: 'held' },
    ]);
    const population = await f.owner.list<{
      id: string;
      email_normalised: string;
      verification_order_window: AccessWindow;
      confirmed: number;
    }>(
      {
        text: `SELECT s.id::text, s.email_normalised, s.verification_order_window,
            (SELECT count(*)::int FROM referral_edge e WHERE e.referrer_id = s.id
              AND e.state = 'confirmed' AND e.voided_at IS NULL) AS confirmed
          FROM subscriber s WHERE s.status = 'verified' ORDER BY s.id`,
      },
      2_000,
    );
    assert.equal(population.length, 1_027);
    assert.equal(population.at(-1)?.id, beyond);
    assert.equal(population[0]?.id, first);

    // The founder changes the ladder and the wave-1 count after those
    // confirmations; no confirmation, void or repair follows.
    const tuned: ReferralRewardConfiguration = {
      ladder: {
        ...couponLadder,
        unlocks: [2, 4, 6],
        stepReferrals: 1,
        stepPercent: 10,
        maximumPercent: 20,
      },
      waveOneReferrals: 25,
    };
    const batches: { limit: number; rows: number }[] = [];
    const records: HandoffRecord[] = [];
    const counts = await exportHandoff(
      observeRecomputeBatches(f.app, batches),
      'operator',
      async (record) => {
        records.push(record);
      },
      async () => {},
      () => launch,
      tuned,
    );

    // Every verified subscriber, in batches of at most 1,000.
    assert.ok(batches.length >= 2, 'more than one batch');
    assert.ok(
      batches.every(({ limit, rows }) => limit <= 1_000 && rows <= 1_000),
      'no batch exceeds 1,000',
    );
    assert.equal(
      batches.reduce((total, { rows }) => total + rows, 0),
      population.length,
    );

    // Every exported wave group and coupon follows the changed ladder.
    const customers = new Map(
      records.flatMap((record) =>
        record.type === 'customer'
          ? [[record.email_normalised, record] as const]
          : [],
      ),
    );
    const coupons = new Map<string, { number: number; percent: number }[]>();
    for (const record of records) {
      if (record.type !== 'held_coupon') continue;
      assert.equal(
        record.expires_at,
        couponExpiresAt(tuned.ladder).toISOString(),
      );
      const owned = coupons.get(record.subscriber_id) ?? [];
      owned.push({ number: record.coupon_number, percent: record.percent });
      coupons.set(record.subscriber_id, owned);
    }
    assert.equal(customers.size, population.length);
    for (const member of population) {
      const window = accessWindowForReferrals(
        member.verification_order_window,
        member.confirmed,
        tuned.waveOneReferrals,
      );
      const customer = customers.get(member.email_normalised);
      assert.equal(customer?.access_window, window, member.id);
      assert.deepEqual(customer?.groups, [window], member.id);
      assert.deepEqual(
        (coupons.get(member.id) ?? []).sort(
          (left, right) => left.number - right.number,
        ),
        computeCouponLadder(member.confirmed, tuned.ladder).map(
          ({ number, percent }) => ({ number, percent }),
        ),
        member.id,
      );
    }
    assert.deepEqual(coupons.get(first), [
      { number: 1, percent: 20 },
      { number: 2, percent: 20 },
      { number: 3, percent: 20 },
    ]);
    assert.deepEqual(customers.get(`${first}@example.test`)?.groups, [
      'wave-1',
    ]);
    assert.deepEqual(coupons.get(beyond), [
      { number: 1, percent: 20 },
      { number: 2, percent: 10 },
    ]);
    assert.deepEqual(customers.get(`${beyond}@example.test`)?.groups, [
      'wave-3',
    ]);

    // Each changed subscriber is audited with the actor and both states.
    assert.equal(counts.recomputedRewards, 2);
    const audits = await f.owner.list<{
      subject_id: string;
      actor: string;
      subject_type: string;
      detail: unknown;
    }>(
      {
        text: `SELECT subject_id, actor, subject_type, detail FROM audit_log
          WHERE action='handoff.rewards_recomputed' ORDER BY subject_id`,
      },
      10,
    );
    assert.deepEqual(audits, [
      {
        subject_id: first,
        actor: 'operator',
        subject_type: 'subscriber',
        detail: {
          before: {
            coupons: [
              { number: 1, percent: 30, state: 'held' },
              { number: 2, percent: 5, state: 'held' },
            ],
            access_window: 'wave-1',
          },
          after: {
            coupons: [
              { number: 1, percent: 20, state: 'held' },
              { number: 2, percent: 20, state: 'held' },
              { number: 3, percent: 20, state: 'held' },
            ],
            access_window: 'wave-1',
          },
        },
      },
      {
        subject_id: beyond,
        actor: 'operator',
        subject_type: 'subscriber',
        detail: {
          before: {
            coupons: [{ number: 1, percent: 5, state: 'held' }],
            access_window: 'wave-1',
          },
          after: {
            coupons: [
              { number: 1, percent: 20, state: 'held' },
              { number: 2, percent: 10, state: 'held' },
            ],
            access_window: 'wave-3',
          },
        },
      },
    ]);
  } finally {
    await f.dispose();
  }
});

test('seeded property: double import adds no customer, group or expiry-bearing coupon on replay', async () => {
  const f = await fixture();
  let caseNumber = 0;
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.boolean(),
        async (numbers, subslush) => {
          caseNumber += 1;
          const records: HandoffRecord[] = numbers.map((number) =>
            parseHandoffRecord({
              type: 'customer',
              email: `case${caseNumber}-${number}@example.test`,
              email_normalised: `case${caseNumber}-${number}@example.test`,
              referral_tier: 0,
              referral_code: null,
              confirmed_referrals: 0,
              category_preference: null,
              survey_version: null,
              source: null,
              marketing_consent_at: null,
              marketing_consent_version: null,
              marketing_consent_source: null,
              access_window: 'wave-4',
              subslush_customer: subslush,
              groups: subslush ? ['wave-4', 'subslush-legacy'] : ['wave-4'],
            }),
          );
          records.push(
            parseHandoffRecord({
              type: 'held_coupon',
              coupon_id: `00000000-0000-4000-8000-${String(caseNumber).padStart(12, '0')}`,
              subscriber_id: '11111111-1111-4111-8111-111111111111',
              email_normalised: `case${caseNumber}-${numbers[0]}@example.test`,
              coupon_number: 1,
              percent: 15,
              state: 'held',
              outcome: 'carried_to_storefront',
              expires_at: couponExpiry,
            }),
          );
          const lines = async function* () {
            for (const record of records) yield JSON.stringify(record);
          };
          const first = await importRehearsal(f.scratch, lines());
          const second = await importRehearsal(f.scratch, lines());
          assert.equal(first.createdCustomers, numbers.length);
          assert.equal(
            first.createdGroups,
            numbers.length * (subslush ? 2 : 1),
          );
          assert.equal(first.createdCoupons, 1);
          assert.equal(first.createdReferrals, 0);
          assert.deepEqual(second, {
            createdCustomers: 0,
            createdGroups: 0,
            createdCoupons: 0,
            createdReferrals: 0,
            createdTokens: 0,
          });
        },
      ),
      { seed: 20_261_011, numRuns: 20 },
    );
  } finally {
    await f.dispose();
  }
});
