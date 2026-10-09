import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createSignupRoute } from '../src/pages/api/signup.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createFlagService as createBaseFlagService } from '../src/server/flags/service.ts';
import { createGiveawayAccrualService } from '../src/server/giveaway/accrue.ts';
import { createGiveawayEntryReconciliationJob } from '../src/server/giveaway/reconcile.ts';
import { currentRulesFromFiles } from '../src/server/giveaway/current-rules-file.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';

const paidQuota = {
  resend: { tier: 'paid' as const, cap: 101 },
  brevo: { tier: 'paid' as const, cap: 301 },
};
const createFlagService = (
  database: Parameters<typeof createBaseFlagService>[0],
  giveaway: Parameters<typeof createBaseFlagService>[1] = {},
) => createBaseFlagService(database, { ...giveaway, emailQuota: paidQuota });

const baseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const firstRules = {
  rulesVersion: 'VAL-GW-LAUNCH-20260925-r1',
  sha256: 'ab'.repeat(32),
};
const secondRules = {
  rulesVersion: 'VAL-GW-LAUNCH-20261015-r1',
  sha256: 'cd'.repeat(32),
};
const fixedTime = new Date('2026-10-01T12:00:00.000Z');

test('maintenance reads the published revision and hash used by Astro', async () => {
  assert.deepEqual(await currentRulesFromFiles(), {
    rulesVersion: 'VAL-GW-LAUNCH-20261009-r1',
    sha256: 'd35678f459daa99560613337a923b7f2cb5f0347fceae3d77a1ad67bc8b908e4',
  });
});

async function fixture(): Promise<{
  owner: DatabasePool;
  app: DatabasePool;
  dispose(): Promise<void>;
}> {
  const name = `valstara_e703_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appPassword,
    release: 'e7-03-test',
  });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    async dispose() {
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
  status: string,
): Promise<string> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await database.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status, verified_at)
           VALUES ($1, $2, $2, 'example.test', $3, CASE WHEN $3 = 'verified' THEN $4::timestamptz ELSE NULL END)`,
    values: [id, email, status, fixedTime],
  });
  return id;
}

async function entries(database: DatabasePool, subscriberId: string) {
  return database.list<{
    entries: number;
    method: string;
    rules_version: string;
    rules_sha256: Buffer;
    source_edge_id: string | null;
  }>(
    {
      text: `SELECT entries, method, rules_version, rules_sha256, source_edge_id::text
           FROM giveaway_entry WHERE subscriber_id = $1 ORDER BY method, rules_version`,
      values: [subscriberId],
    },
    20,
  );
}

test('flag-off and every ineligible status accrue nothing', async () => {
  const f = await fixture();
  try {
    const flags = createFlagService(f.app);
    for (const status of [
      'pending',
      'expired',
      'unsubscribed',
      'bounced',
      'disqualified',
      'verified',
    ]) {
      const id = await subscriber(f.owner, status);
      await createGiveawayAccrualService(f.app, flags, () => firstRules).accrue(
        id,
        'base',
      );
      assert.equal((await entries(f.owner, id)).length, 0, status);
    }
    assert.deepEqual(
      await createGiveawayEntryReconciliationJob(
        f.app,
        flags,
        async () => firstRules,
      ).run(10),
      { checked: 0, accrued: 0 },
    );
    await flags.set('giveaway.open', true, 'e7-03-test');
    for (const status of [
      'pending',
      'expired',
      'unsubscribed',
      'bounced',
      'disqualified',
    ]) {
      const id = await subscriber(f.owner, status);
      await createGiveawayAccrualService(f.app, flags, () => firstRules).accrue(
        id,
        'base',
      );
      assert.equal((await entries(f.owner, id)).length, 0, status);
    }
  } finally {
    await f.dispose();
  }
});

test('concurrent retries write one base and one confirmed-edge entry with first rules stamp', async () => {
  const f = await fixture();
  try {
    const eventMethods: string[] = [];
    const flags = createFlagService(f.app);
    await flags.set('giveaway.open', true, 'e7-03-test');
    const referrer = await subscriber(f.owner, 'verified');
    const referred = await subscriber(f.owner, 'verified');
    const edgeId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state, confirmed_at)
             VALUES ($1, $2, $3, 'confirmed', 'settled', $4)`,
      values: [edgeId, referrer, referred, fixedTime],
    });
    const run = async () => {
      const service = createGiveawayAccrualService(
        f.app,
        flags,
        () => firstRules,
        undefined,
        () => fixedTime,
        undefined,
        (method) => eventMethods.push(method),
      );
      await service.accrue(referred, 'base');
      await service.accrue(referrer, 'referral', edgeId);
    };
    await Promise.all(Array.from({ length: 8 }, run));
    const referredEntries = await entries(f.owner, referred);
    const referrerEntries = await entries(f.owner, referrer);
    assert.equal(referredEntries.length, 1);
    assert.equal(referrerEntries.length, 1);
    assert.equal(referredEntries[0].method, 'base');
    assert.equal(referrerEntries[0].method, 'referral');
    assert.equal(referredEntries[0].entries, 1);
    assert.equal(referrerEntries[0].entries, 1);
    assert.equal(referrerEntries[0].source_edge_id, edgeId);
    assert.deepEqual(eventMethods.sort(), ['base', 'referral']);
    for (const entry of [...referredEntries, ...referrerEntries]) {
      assert.equal(entry.rules_version, firstRules.rulesVersion);
      assert.equal(entry.rules_sha256.toString('hex'), firstRules.sha256);
    }
    const stamps = await f.owner.list<{
      id: string;
      giveaway_rules_version: string;
    }>(
      {
        text: `SELECT id::text, giveaway_rules_version FROM subscriber WHERE id IN ($1, $2)`,
        values: [referrer, referred],
      },
      2,
    );
    assert.equal(stamps.length, 2);
    assert.ok(
      stamps.every(
        (row) => row.giveaway_rules_version === firstRules.rulesVersion,
      ),
    );
    await assert.rejects(
      f.owner.execute({
        text: `UPDATE subscriber SET giveaway_rules_version = $2 WHERE id = $1`,
        values: [referrer, secondRules.rulesVersion],
      }),
      /giveaway_rules_version is write-once/u,
    );

    // A new confirmed edge accrues under the new revision, but older rows and
    // the first-entry stamp stay unchanged.
    const secondReferred = await subscriber(f.owner, 'verified');
    const secondEdgeId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state, confirmed_at)
             VALUES ($1, $2, $3, 'confirmed', 'settled', $4)`,
      values: [secondEdgeId, referrer, secondReferred, fixedTime],
    });
    const revisedService = createGiveawayAccrualService(
      f.app,
      flags,
      () => secondRules,
    );
    await revisedService.accrue(referrer, 'referral', secondEdgeId);
    await revisedService.accrue(referrer, 'referral', edgeId);
    const revised = await entries(f.owner, referrer);
    assert.deepEqual(
      revised.map((row) => row.rules_version),
      [firstRules.rulesVersion, secondRules.rulesVersion],
    );
    assert.deepEqual(
      revised.map((row) => row.rules_sha256.toString('hex')),
      [firstRules.sha256, secondRules.sha256],
    );
    const stamp = await f.owner.readOne<{ giveaway_rules_version: string }>({
      text: 'SELECT giveaway_rules_version FROM subscriber WHERE id = $1',
      values: [referrer],
    });
    assert.equal(stamp?.giveaway_rules_version, firstRules.rulesVersion);
  } finally {
    await f.dispose();
  }
});

test('a direct signup without referral, purchase or marketing consent earns one base entry after verification', async () => {
  const f = await fixture();
  try {
    let verificationUrl: string | null = null;
    const signup = createSignupService(f.app, {
      clock: () => fixedTime,
      raiseFraudFlag: async () => undefined,
      screenEmailDomain: async () => ({ flags: [] }),
      async sendVerificationMail(mail) {
        verificationUrl = mail.verificationUrl;
      },
    });
    const route = createSignupRoute({
      isSignupEnabled: async () => true,
      verifyTurnstile: async () => 'verified',
      consumeIpRateLimit: async () => 'ok',
      signup,
      flagChallengeTimeout: async () => undefined,
      ipPrefixPepper: 'e7-04-test-pepper',
      monotonicClock: () => 0,
      sleep: async () => undefined,
    });
    const request = new Request('https://valstara.test/api/signup', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'free-entry@example.test',
        turnstile_token: 'e7-04-test-challenge',
      }),
    });
    const response = await route({
      clientAddress: '203.0.113.10',
      request,
    } as never);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'pending');
    const pending = await f.owner.readOne<{ id: string; status: string }>({
      text: `SELECT id::text, status FROM subscriber
             WHERE email_normalised = 'free-entry@example.test'`,
    });
    assert.equal(pending?.status, 'pending');
    assert.ok(pending);
    const subscriberId = pending.id;
    assert.deepEqual(await entries(f.owner, subscriberId), []);
    assert.ok(verificationUrl);
    const token = new URL(verificationUrl).searchParams.get('token');
    assert.ok(token);

    const flags = createFlagService(f.app);
    await flags.set('giveaway.open', true, 'e7-04-test');
    const complete = createVerificationCompletionService(f.app, {
      clock: () => fixedTime,
      giveaway: { flags, currentRules: () => firstRules },
    });
    assert.equal((await complete(token)).outcome, 'verified');
    const record = await f.owner.readOne<{
      marketing_consent_at: Date | null;
      referred_by_id: string | null;
      status: string;
    }>({
      text: `SELECT marketing_consent_at, referred_by_id::text, status
             FROM subscriber WHERE id = $1`,
      values: [subscriberId],
    });
    assert.equal(record?.status, 'verified');
    assert.equal(record?.marketing_consent_at, null);
    assert.equal(record?.referred_by_id, null);
    const ledger = await entries(f.owner, subscriberId);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.method, 'base');
    assert.equal(ledger[0]?.entries, 1);
    assert.equal(ledger[0]?.source_edge_id, null);
    assert.equal((await complete(token)).outcome, 'already');
    assert.equal((await entries(f.owner, subscriberId)).length, 1);
  } finally {
    await f.dispose();
  }
});

test('the validated database constraint rejects non-unit rows, including pre-existing rows', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, 'verified');
    const insert = (value: number) =>
      f.owner.execute({
        text: `INSERT INTO giveaway_entry
                 (id, subscriber_id, method, entries, rules_version, rules_sha256)
               VALUES ($1, $2, 'base', $3, $4, $5)`,
        values: [
          randomUUID(),
          id,
          value,
          firstRules.rulesVersion,
          Buffer.from(firstRules.sha256, 'hex'),
        ],
      });
    await assert.rejects(insert(2), {
      code: '23514',
      constraint: 'giveaway_entry_one_unit',
    });
    await assert.rejects(
      f.owner.execute({
        text: `INSERT INTO giveaway_entry
                 (id, subscriber_id, method, entries, rules_version, rules_sha256)
               VALUES ($1, $2, 'amoe', 1, $3, $4)`,
        values: [
          randomUUID(),
          id,
          firstRules.rulesVersion,
          Buffer.from(firstRules.sha256, 'hex'),
        ],
      }),
      { code: '23514', constraint: 'giveaway_entry_method_check' },
    );
    await f.owner.execute({
      text: 'ALTER TABLE giveaway_entry DROP CONSTRAINT giveaway_entry_one_unit',
    });
    await insert(2);
    const migration = await readFile(
      new URL(
        '../src/server/db/migrations/0026-giveaway-entry-one-unit.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await assert.rejects(f.owner.execute({ text: migration }), {
      code: '23514',
      constraint: 'giveaway_entry_one_unit',
    });
    await f.owner.execute({
      text: 'UPDATE giveaway_entry SET entries = 1 WHERE subscriber_id = $1',
      values: [id],
    });
    await f.owner.execute({ text: migration });
    const constraint = await f.owner.readOne<{ convalidated: boolean }>({
      text: `SELECT convalidated FROM pg_constraint
             WHERE conname = 'giveaway_entry_one_unit'`,
    });
    assert.equal(constraint?.convalidated, true);
  } finally {
    await f.dispose();
  }
});

test('an unconfirmed or foreign edge cannot earn a referral entry; malformed rules fail closed', async () => {
  const f = await fixture();
  try {
    const flags = createFlagService(f.app);
    await flags.set('giveaway.open', true, 'e7-03-test');
    const referrer = await subscriber(f.owner, 'verified');
    const other = await subscriber(f.owner, 'verified');
    const referred = await subscriber(f.owner, 'verified');
    const edgeId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
             VALUES ($1, $2, $3, 'attributed', 'none')`,
      values: [edgeId, other, referred],
    });
    const service = createGiveawayAccrualService(
      f.app,
      flags,
      () => firstRules,
    );
    await service.accrue(referrer, 'referral', edgeId);
    assert.equal((await entries(f.owner, referrer)).length, 0);
    await f.owner.execute({
      text: `UPDATE referral_edge SET state = 'confirmed', reward_state = 'settled'
             WHERE id = $1`,
      values: [edgeId],
    });
    await service.accrue(referrer, 'referral', edgeId);
    assert.equal((await entries(f.owner, referrer)).length, 0);
    await assert.rejects(
      createGiveawayAccrualService(f.app, flags, () => ({
        ...firstRules,
        sha256: 'invalid',
      })).accrue(referrer, 'base'),
      /rules hash is invalid/u,
    );
    assert.equal((await entries(f.owner, referrer)).length, 0);
    await assert.rejects(service.accrue(referrer, 'referral'), TypeError);
    await assert.rejects(
      f.owner.execute({
        text: `INSERT INTO giveaway_entry
                 (id, subscriber_id, method, entries, rules_version, rules_sha256)
               VALUES ($1, $2, 'base', 1, $3, decode('ab', 'hex'))`,
        values: [randomUUID(), referrer, firstRules.rulesVersion],
      }),
      { code: '23514' },
    );
  } finally {
    await f.dispose();
  }
});

test('verification transaction credits the verified person and their referrer once', async () => {
  const f = await fixture();
  try {
    const eventMethods: string[] = [];
    const flags = createFlagService(f.app);
    await flags.set('giveaway.open', true, 'e7-03-test');
    const referrer = await subscriber(f.owner, 'verified');
    const referred = await subscriber(f.owner, 'pending');
    const edgeId = randomUUID();
    const tokenId = randomUUID();
    const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET!);
    await f.owner.execute({
      text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
             VALUES ($1, $2, $3, 'attributed', 'none')`,
      values: [edgeId, referrer, referred],
    });
    await f.owner.execute({
      text: `INSERT INTO verification_token
               (id, subscriber_id, token_hash, purpose, expires_at)
             VALUES ($1, $2, $3, 'verify', $4)`,
      values: [
        tokenId,
        referred,
        createHash('sha256').update(token).digest(),
        new Date('2026-10-02T12:00:00.000Z'),
      ],
    });
    const complete = createVerificationCompletionService(f.app, {
      clock: () => fixedTime,
      giveaway: { flags, currentRules: () => firstRules },
      onCommitted: ({ giveawayMethods }) =>
        eventMethods.push(...giveawayMethods),
    });
    assert.equal((await complete(token)).outcome, 'verified');
    assert.equal((await complete(token)).outcome, 'already');
    assert.equal((await entries(f.owner, referred)).length, 1);
    assert.equal((await entries(f.owner, referrer)).length, 1);
    assert.deepEqual(eventMethods.sort(), ['base', 'referral']);
    const edge = await f.owner.readOne<{ state: string }>({
      text: 'SELECT state FROM referral_edge WHERE id = $1',
      values: [edgeId],
    });
    assert.equal(edge?.state, 'confirmed');

    await flags.set('giveaway.open', false, 'e7-03-test');
    const later = await subscriber(f.owner, 'pending');
    const laterTokenId = randomUUID();
    const laterToken = deriveEmailToken(
      laterTokenId,
      process.env.EMAIL_TOKEN_SECRET!,
    );
    await f.owner.execute({
      text: `INSERT INTO verification_token
               (id, subscriber_id, token_hash, purpose, expires_at)
             VALUES ($1, $2, $3, 'verify', $4)`,
      values: [
        laterTokenId,
        later,
        createHash('sha256').update(laterToken).digest(),
        new Date('2026-10-02T12:00:00.000Z'),
      ],
    });
    assert.equal((await complete(laterToken)).outcome, 'verified');
    assert.equal((await entries(f.owner, later)).length, 0);
    await flags.set('giveaway.open', true, 'e7-03-test');
    assert.equal((await entries(f.owner, later)).length, 1);
  } finally {
    await f.dispose();
  }
});

test('flag-on reconciliation restores missed entries, audits counts, and reruns without duplicates', async () => {
  const f = await fixture();
  try {
    const eventMethods: string[] = [];
    const referrer = await subscriber(f.owner, 'verified');
    const referred = await subscriber(f.owner, 'verified');
    const edgeId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO referral_edge
               (id, referrer_id, referred_id, state, reward_state, confirmed_at)
             VALUES ($1, $2, $3, 'confirmed', 'settled', $4)`,
      values: [edgeId, referrer, referred, fixedTime],
    });
    const flags = createFlagService(f.app, {
      currentRules: async () => firstRules,
      onGiveawayEntry: (method) => eventMethods.push(method),
    });
    const service = createGiveawayAccrualService(
      f.app,
      flags,
      () => firstRules,
    );
    await service.accrue(referrer, 'base');
    assert.equal((await entries(f.owner, referrer)).length, 0);

    await flags.set('giveaway.open', true, 'e7-03-test');
    assert.equal((await entries(f.owner, referrer)).length, 2);
    assert.equal((await entries(f.owner, referred)).length, 1);
    assert.deepEqual(eventMethods.sort(), ['base', 'base', 'referral']);
    const job = createGiveawayEntryReconciliationJob(
      f.app,
      flags,
      async () => secondRules,
      undefined,
      () => fixedTime,
      (method) => eventMethods.push(method),
    );
    assert.deepEqual(await job.run(10), { checked: 0, accrued: 0 });
    assert.equal((await entries(f.owner, referrer)).length, 2);
    const laterMissed = await subscriber(f.owner, 'verified');
    assert.deepEqual(await job.run(10), { checked: 1, accrued: 1 });
    assert.deepEqual(eventMethods.sort(), ['base', 'base', 'base', 'referral']);
    const laterRows = await entries(f.owner, laterMissed);
    assert.equal(laterRows[0]?.rules_version, secondRules.rulesVersion);
    assert.equal(
      laterRows[0]?.rules_sha256.toString('hex'),
      secondRules.sha256,
    );
    const firstStamp = await f.owner.readOne<{
      giveaway_rules_version: string;
    }>({
      text: 'SELECT giveaway_rules_version FROM subscriber WHERE id = $1',
      values: [laterMissed],
    });
    assert.equal(firstStamp?.giveaway_rules_version, secondRules.rulesVersion);
    const audits = await f.owner.list<{
      detail: { checked: number; accrued: number };
    }>(
      {
        text: `SELECT detail FROM audit_log
             WHERE action = 'giveaway.entries_backfilled' ORDER BY at, id`,
      },
      10,
    );
    assert.equal(audits.length, 3);
    assert.deepEqual(
      audits.map((row) => row.detail.accrued),
      [3, 0, 1],
    );
    assert.equal(audits[0].detail.checked, 3);
  } finally {
    await f.dispose();
  }
});

test('a later waitlist launch excludes earlier verification from direct and backfilled entries', async () => {
  const f = await fixture();
  try {
    const periodStart = new Date('2026-10-02T00:00:00.000Z');
    const beforeLaunch = await subscriber(f.owner, 'verified');
    const afterLaunch = await subscriber(f.owner, 'verified');
    await f.owner.execute({
      text: 'UPDATE subscriber SET verified_at = $2 WHERE id = $1',
      values: [afterLaunch, new Date('2026-10-02T12:00:00.000Z')],
    });
    const flags = createFlagService(f.app, {
      currentRules: async () => firstRules,
      periodStart,
    });
    await flags.set('giveaway.open', true, 'e7-03-test');
    const service = createGiveawayAccrualService(
      f.app,
      flags,
      () => firstRules,
      periodStart,
    );
    assert.equal(await service.accrue(beforeLaunch, 'base'), false);
    assert.equal((await entries(f.owner, beforeLaunch)).length, 0);
    assert.equal((await entries(f.owner, afterLaunch)).length, 1);
    assert.deepEqual(
      await createGiveawayEntryReconciliationJob(
        f.app,
        flags,
        async () => firstRules,
        periodStart,
      ).run(10),
      { checked: 0, accrued: 0 },
    );
  } finally {
    await f.dispose();
  }
});

test('reconciliation caps each run and excludes post-close and disqualified people', async () => {
  const f = await fixture();
  try {
    const entitled = await subscriber(f.owner, 'verified');
    const second = await subscriber(f.owner, 'verified');
    const disqualified = await subscriber(f.owner, 'disqualified');
    const late = await subscriber(f.owner, 'verified');
    const lateEdgeReferred = await subscriber(f.owner, 'verified');
    const lateEdgeId = randomUUID();
    await f.owner.execute({
      text: `UPDATE subscriber SET verified_at = $2 WHERE id = $1`,
      values: [lateEdgeReferred, new Date('2027-03-02T00:00:00.000Z')],
    });
    await f.owner.execute({
      text: `INSERT INTO referral_edge
               (id, referrer_id, referred_id, state, reward_state, confirmed_at)
             VALUES ($1, $2, $3, 'confirmed', 'settled', $4)`,
      values: [
        lateEdgeId,
        entitled,
        lateEdgeReferred,
        new Date('2027-03-02T00:00:00.000Z'),
      ],
    });
    await f.owner.execute({
      text: `UPDATE subscriber SET verified_at = $2 WHERE id = $1`,
      values: [disqualified, fixedTime],
    });
    await f.owner.execute({
      text: `UPDATE subscriber SET verified_at = $2 WHERE id = $1`,
      values: [late, new Date('2027-03-02T00:00:00.000Z')],
    });
    const flags = createFlagService(f.app, {
      currentRules: async () => firstRules,
    });
    // The initial enable drains the ledger; remove its test entries
    // with the owner role to exercise the job's per-run cap on a fresh gap.
    await flags.set('giveaway.open', true, 'e7-03-test');
    await f.owner.execute({ text: 'DELETE FROM giveaway_entry' });
    const job = createGiveawayEntryReconciliationJob(
      f.app,
      flags,
      async () => firstRules,
    );
    assert.deepEqual(await job.run(1), { checked: 1, accrued: 1 });
    assert.equal(
      (await entries(f.owner, entitled)).length +
        (await entries(f.owner, second)).length,
      1,
    );
    assert.deepEqual(await job.run(1), { checked: 1, accrued: 1 });
    assert.deepEqual(await job.run(1), { checked: 0, accrued: 0 });
    assert.equal((await entries(f.owner, disqualified)).length, 0);
    assert.equal((await entries(f.owner, late)).length, 0);
    assert.equal(
      (await entries(f.owner, entitled)).some(
        (entry) => entry.source_edge_id === lateEdgeId,
      ),
      false,
    );
    assert.equal(
      await createGiveawayAccrualService(f.app, flags, () => firstRules).accrue(
        entitled,
        'referral',
        lateEdgeId,
      ),
      false,
    );
    await assert.rejects(job.run(1_001), RangeError);
    const afterClose = createGiveawayEntryReconciliationJob(
      f.app,
      flags,
      async () => firstRules,
    );
    assert.deepEqual(await afterClose.run(1), { checked: 0, accrued: 0 });
    assert.equal(
      await createGiveawayAccrualService(f.app, flags, () => firstRules).accrue(
        late,
        'base',
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});
