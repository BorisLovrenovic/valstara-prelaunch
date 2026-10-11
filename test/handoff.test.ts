import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import fc from 'fast-check';

import { runMigrations } from '../src/server/db/migration.ts';
import { voidLegacyBonusBatch } from '../src/server/db/handoff.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
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
  exportHandoff,
  qualificationDeadline,
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

test('handoff exports verified unsuppressed customers, eligible held discounts and audited legacy voids', async () => {
  const f = await fixture();
  try {
    const included = await subscriber(
      f.owner,
      'included@example.test',
      'verified',
      'wave-2',
    );
    await subscriber(f.owner, 'pending@example.test', 'pending');
    await subscriber(f.owner, 'expired@example.test', 'expired');
    await subscriber(f.owner, 'disqualified@example.test', 'disqualified');
    await subscriber(f.owner, 'suppressed@example.test', 'verified');
    await f.owner.execute({
      text: `INSERT INTO suppression(email_normalised,reason,source)
      VALUES ('suppressed@example.test','manual','test')`,
    });
    const discountId = randomUUID();
    const legacyId = randomUUID();
    const settledLegacyId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO milestone_award(id,subscriber_id,tier,reward_kind,state)
        VALUES ($1,$2,1,'discount','held'),($3,$2,1,'entries','held'),
          ($4,$2,2,'entries','settled')`,
      values: [discountId, included, legacyId, settledLegacyId],
    });
    const records: HandoffRecord[] = [];
    const counts = await exportHandoff(
      f.app,
      'operator',
      launch,
      async (record) => {
        records.push(record);
      },
    );
    assert.deepEqual(counts, {
      customers: 1,
      heldDiscounts: 1,
      confirmedReferrals: 0,
      voidedIneligibleDiscounts: 0,
      voidedLegacyBonusEntries: 2,
    });
    assert.equal(records.length, 2);
    const customer = records.find((record) => record.type === 'customer');
    assert.deepEqual(customer, {
      type: 'customer',
      email: 'included@example.test',
      email_normalised: 'included@example.test',
      referral_tier: 1,
      referral_code: null,
      confirmed_referrals: 3,
      category_preference: ['apparel', 'home'],
      source: 'referral',
      marketing_consent_at: '2027-01-01T12:00:00.000Z',
      marketing_consent_version: 'v1',
      marketing_consent_source: 'signup',
      access_window: 'wave-2',
      subslush_customer: true,
      groups: ['wave-2', 'subslush-legacy'],
    });
    assert.deepEqual(
      records.find((record) => record.type === 'held_discount'),
      {
        type: 'held_discount',
        award_id: discountId,
        subscriber_id: included,
        email_normalised: 'included@example.test',
        tier: 1,
        discount_percent: 15,
        state: 'held',
        outcome: 'carried_to_storefront',
        qualification_deadline: qualificationDeadline(launch),
      },
    );
    assert.equal(qualificationDeadline(launch), '2027-06-13T10:00:00.000Z');
    assert.ok(
      records.every(
        (record) =>
          !Object.hasOwn(record, 'country') &&
          !Object.hasOwn(record, 'reward_kind'),
      ),
    );
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
    const second: HandoffRecord[] = [];
    assert.deepEqual(
      await exportHandoff(f.app, 'operator', launch, async (record) => {
        second.push(record);
      }),
      {
        customers: 1,
        heldDiscounts: 1,
        confirmedReferrals: 0,
        voidedIneligibleDiscounts: 0,
        voidedLegacyBonusEntries: 0,
      },
    );
    assert.deepEqual(second, records);

    const lines = async function* () {
      for (const record of records) yield JSON.stringify(record);
    };
    assert.deepEqual(await importRehearsal(f.scratch, lines()), {
      createdCustomers: 1,
      createdGroups: 2,
      createdDiscounts: 1,
      createdReferrals: 0,
    });
    assert.deepEqual(await importRehearsal(f.scratch, lines()), {
      createdCustomers: 0,
      createdGroups: 0,
      createdDiscounts: 0,
      createdReferrals: 0,
    });
    assert.deepEqual(await countRehearsalRows(f.scratch), {
      customers: 1,
      groups: 2,
      discounts: 1,
      referrals: 0,
    });
  } finally {
    await f.dispose();
  }
});

test('handoff import rejects missing or extra fields, a changed deadline, and bonus entries', () => {
  const customer = {
    type: 'customer',
    email: 'a@example.test',
    email_normalised: 'a@example.test',
    referral_tier: 0,
    referral_code: null,
    confirmed_referrals: 0,
    category_preference: null,
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
  const discount = {
    type: 'held_discount',
    award_id: randomUUID(),
    subscriber_id: randomUUID(),
    email_normalised: 'a@example.test',
    tier: 1,
    discount_percent: 15,
    state: 'held',
    outcome: 'carried_to_storefront',
    qualification_deadline: '2027-06-13T10:00:00.000Z',
  };
  assert.deepEqual(parseHandoffRecord(discount), discount);
  assert.throws(
    () => parseHandoffRecord({ ...discount, qualification_deadline: null }),
    TypeError,
  );
  assert.throws(
    () => parseHandoffRecord({ ...discount, discount_percent: 5 }),
    TypeError,
  );
  assert.throws(
    () => parseHandoffRecord({ ...discount, email_normalised: null }),
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
  test(`held discount owner ${scenario.label} is voided with an audited outcome and excluded`, async () => {
    const f = await fixture();
    try {
      const email = `${scenario.label.replaceAll(' ', '-')}@example.test`;
      const ownerId = await subscriber(f.owner, email, scenario.status);
      const awardId = await heldDiscount(f.owner, ownerId);
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
        launch,
        async (record) => {
          records.push(record);
        },
      );
      assert.equal(counts.voidedIneligibleDiscounts, 1);
      assert.equal(counts.heldDiscounts, 0);
      assert.deepEqual(records, []);
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

test('marketing-withdrawn verified owner retains the held discount and an audited carry outcome', async () => {
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
    const awardId = await heldDiscount(f.owner, ownerId);
    const records: HandoffRecord[] = [];
    const counts = await exportHandoff(
      f.app,
      'operator',
      launch,
      async (record) => {
        records.push(record);
      },
    );
    assert.equal(counts.heldDiscounts, 1);
    assert.equal(counts.voidedIneligibleDiscounts, 0);
    assert.equal(
      records.find((record) => record.type === 'held_discount')
        ?.email_normalised,
      'withdrawn@example.test',
    );
    assert.deepEqual(
      await f.owner.readOne({
        text: `SELECT actor,detail FROM audit_log WHERE action='handoff.discount_carried' AND subject_id=$1`,
        values: [awardId],
      }),
      {
        actor: 'operator',
        detail: {
          outcome: 'carried_to_storefront',
          qualification_deadline: qualificationDeadline(launch),
        },
      },
    );
  } finally {
    await f.dispose();
  }
});

test('erased owner has no discount or identity to export after E9-05 erasure', async () => {
  const f = await fixture();
  try {
    const ownerId = await subscriber(
      f.owner,
      'erased@example.test',
      'verified',
    );
    const awardId = await heldDiscount(f.owner, ownerId);
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
      launch,
      async (record) => {
        records.push(record);
      },
    );
    assert.equal(counts.heldDiscounts, 0);
    assert.deepEqual(records, []);
    assert.equal(
      await f.owner.readOne({
        text: 'SELECT id FROM milestone_award WHERE id=$1',
        values: [awardId],
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
      launch,
      async (record) => {
        records.push(record);
      },
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
      createdDiscounts: 0,
      createdReferrals: 0,
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
    const discount = parseHandoffRecord({
      type: 'held_discount',
      award_id: randomUUID(),
      subscriber_id: randomUUID(),
      email_normalised: 'owner@example.test',
      tier: 1,
      discount_percent: 15,
      state: 'held',
      outcome: 'carried_to_storefront',
      qualification_deadline: '2027-06-13T10:00:00.000Z',
    });
    if (discount.type !== 'held_discount')
      throw new Error('Expected a held discount fixture.');
    const customer = parseHandoffRecord({
      type: 'customer',
      email: 'owner@example.test',
      email_normalised: 'owner@example.test',
      referral_tier: 0,
      referral_code: null,
      confirmed_referrals: 0,
      category_preference: null,
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
          ...discount,
          award_id: randomUUID(),
          email_normalised: 'outside@example.test',
        },
      ]),
      /foreign key constraint/u,
    );
    assert.deepEqual(await importRehearsalBatch(f.scratch, [discount]), {
      createdCustomers: 0,
      createdGroups: 0,
      createdDiscounts: 1,
      createdReferrals: 0,
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
      importRehearsalBatch(f.scratch, [
        { ...discount, qualification_deadline: '2027-06-14T10:00:00.000Z' },
      ]),
      /conflicting data/u,
    );
    assert.deepEqual(await countRehearsalRows(f.scratch), {
      customers: 1,
      groups: 1,
      discounts: 1,
      referrals: 0,
    });
    await assert.rejects(
      importRehearsalBatch(
        f.scratch,
        Array.from({ length: rehearsalBatchSize + 1 }, () => discount),
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
    let emitted = 0;
    const counts = await exportHandoff(
      f.app,
      'operator',
      launch,
      async (record) => {
        assert.equal(record.type, 'customer');
        emitted += 1;
      },
    );
    assert.equal(emitted, 1001);
    assert.deepEqual(counts, {
      customers: 1001,
      heldDiscounts: 0,
      confirmedReferrals: 0,
      voidedIneligibleDiscounts: 0,
      voidedLegacyBonusEntries: 0,
    });
  } finally {
    await f.dispose();
  }
});

test('seeded property: double import adds no customer, group or deadline-bearing discount on replay', async () => {
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
              type: 'held_discount',
              award_id: `00000000-0000-4000-8000-${String(caseNumber).padStart(12, '0')}`,
              subscriber_id: '11111111-1111-4111-8111-111111111111',
              email_normalised: `case${caseNumber}-${numbers[0]}@example.test`,
              tier: 1,
              discount_percent: 15,
              state: 'held',
              outcome: 'carried_to_storefront',
              qualification_deadline: '2027-06-13T10:00:00.000Z',
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
          assert.equal(first.createdDiscounts, 1);
          assert.equal(first.createdReferrals, 0);
          assert.deepEqual(second, {
            createdCustomers: 0,
            createdGroups: 0,
            createdDiscounts: 0,
            createdReferrals: 0,
          });
        },
      ),
      { seed: 20_261_011, numRuns: 20 },
    );
  } finally {
    await f.dispose();
  }
});
