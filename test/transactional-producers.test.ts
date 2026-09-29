import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import fc from 'fast-check';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { createTransactionalEmailProducers } from '../src/server/email/producers.ts';
import { prepareDispatchMessage } from '../src/server/email/service.ts';
import { createTransactionalTemplateData } from '../src/server/email/transactional-template-data.ts';
import { createTransactionalRenderers } from '../src/server/email/transactional-templates.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import { createGiveawayAccrualService } from '../src/server/giveaway/accrue.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { presentReferralStatus } from '../src/server/referral/status-presentation.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';

const now = new Date('2026-10-01T12:00:00.000Z');
const clock = () => now;
const rules = {
  rulesVersion: 'VAL-GW-LAUNCH-20260925-r1',
  sha256: 'ab'.repeat(32),
};
const otherRules = {
  rulesVersion: 'VAL-GW-LAUNCH-20261015-r1',
  sha256: 'cd'.repeat(32),
};
const secret = process.env.EMAIL_TOKEN_SECRET!;

async function fixture() {
  const name = `valstara_e803a_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appUrl.password,
    release: 'e8-03a-test',
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
  status: 'pending' | 'verified' = 'verified',
) {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await database.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status, verified_at)
      VALUES ($1, $2, $2, 'example.test', $3,
        CASE WHEN $3 = 'verified' THEN $4::timestamptz ELSE NULL END)`,
    values: [id, email, status, now],
  });
  return id;
}

async function verifyToken(database: DatabasePool, id: string) {
  const tokenId = randomUUID();
  const token = deriveEmailToken(tokenId, secret);
  await database.execute({
    text: `INSERT INTO verification_token
      (id, subscriber_id, token_hash, purpose, expires_at)
      VALUES ($1, $2, $3, 'verify', $4)`,
    values: [
      tokenId,
      id,
      createHash('sha256').update(token).digest(),
      new Date('2026-10-08T12:00:00.000Z'),
    ],
  });
  return token;
}

async function sendRows(database: DatabasePool, id: string) {
  return database.list<{
    id: string;
    subscriber_id: string;
    template: string;
    provider: string;
    business_key: string;
    payload: Record<string, unknown>;
    unsubscribe_token_id: string;
    attempts: number;
  }>(
    {
      text: `SELECT id, subscriber_id, template, provider, business_key, payload,
      unsubscribe_token_id, attempts FROM email_send WHERE subscriber_id = $1
      ORDER BY business_key`,
      values: [id],
    },
    20,
  );
}

async function confirmedEdge(database: DatabasePool, referrerId: string) {
  const referredId = await subscriber(database);
  const edgeId = randomUUID();
  await database.execute({
    text: `INSERT INTO referral_edge
      (id, referrer_id, referred_id, state, reward_state, confirmed_at)
      VALUES ($1, $2, $3, 'confirmed', 'settled', $4)`,
    values: [edgeId, referrerId, referredId, now],
  });
  return edgeId;
}

test('each producer has one durable row under concurrent duplicate events and reference-only payloads', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner);
    const producer = createTransactionalEmailProducers(f.app, clock);
    const operations = [
      (connection: Parameters<typeof producer.welcome>[0]) =>
        producer.welcome(connection, id),
      (connection: Parameters<typeof producer.milestone>[0]) =>
        producer.milestone(connection, id, 1),
      (connection: Parameters<typeof producer.receipt>[0]) =>
        producer.receipt(connection, id, rules.rulesVersion),
    ];
    for (const operation of operations) {
      const inserted = await Promise.all(
        Array.from({ length: 6 }, () => withTransaction(f.app, operation)),
      );
      assert.equal(inserted.filter(Boolean).length, 1);
    }
    const rows = await sendRows(f.owner, id);
    assert.deepEqual(
      rows.map((row) => row.business_key),
      [
        `giveaway-receipt:${id}:${rules.rulesVersion}`,
        `milestone:${id}:1`,
        `welcome:${id}`,
      ],
    );
    assert.deepEqual(
      rows.map((row) => row.payload),
      [
        {
          rules_version: rules.rulesVersion,
          status_token_id: rows[0]?.payload.status_token_id,
        },
        { tier: 1, status_token_id: rows[1]?.payload.status_token_id },
        { status_token_id: rows[2]?.payload.status_token_id },
      ],
    );
    for (const row of rows) {
      assert.match(String(row.payload.status_token_id), /^[0-9a-f-]{36}$/u);
      const token = await f.owner.readOne<{
        purpose: string;
        subscriber_id: string;
      }>({
        text: 'SELECT purpose, subscriber_id FROM verification_token WHERE id = $1',
        values: [row.payload.status_token_id],
      });
      assert.deepEqual(token, { purpose: 'status', subscriber_id: id });
    }
    const count = await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM verification_token
        WHERE subscriber_id = $1 AND purpose = 'status'`,
      values: [id],
    });
    assert.equal(count?.count, '3');
    await assert.rejects(
      f.owner.execute({
        text: `INSERT INTO email_send
        (id, subscriber_id, template, provider, business_key, payload, state)
        VALUES ($1, $2, 'welcome', 'resend', 'bad-personal-data', $3::jsonb, 'failed')`,
        values: [
          randomUUID(),
          id,
          JSON.stringify({ email: 'person@example.test' }),
        ],
      }),
      /email_send_payload_references_only/u,
    );
  } finally {
    await f.close();
  }
});

test('seeded concurrent repeats preserve one welcome business key per subscriber', async () => {
  const f = await fixture();
  try {
    const producer = createTransactionalEmailProducers(f.app, clock);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (repeats) => {
        const id = await subscriber(f.owner);
        const inserted = await Promise.all(
          Array.from({ length: repeats }, () =>
            withTransaction(f.app, (connection) =>
              producer.welcome(connection, id),
            ),
          ),
        );
        assert.equal(inserted.filter(Boolean).length, 1);
        const rows = await sendRows(f.owner, id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.business_key, `welcome:${id}`);
      }),
      { seed: 20260928, numRuns: 6 },
    );
  } finally {
    await f.close();
  }
});

test('verification queues welcome once and renders shared status with member dashboard off', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, 'pending');
    const token = await verifyToken(f.owner, id);
    const flags = createFlagService(f.app);
    assert.equal(await flags.isEnabled('member.dashboard'), true);
    await flags.set('member.dashboard', false, 'e8-03a-test');
    const complete = createVerificationCompletionService(f.app, { clock });
    assert.equal((await complete(token)).outcome, 'verified');
    assert.equal((await complete(token)).outcome, 'already');
    const rows = await sendRows(f.owner, id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.business_key, `welcome:${id}`);
    const renderer = createTransactionalRenderers({
      baseUrl: 'http://localhost:4321',
      sendingDomain: 'send.valstara.com',
      data: createTransactionalTemplateData(f.app),
    }).get('welcome');
    assert.ok(renderer);
    const rendered = await prepareDispatchMessage({
      row: rows[0]!,
      recipient: `${id}@example.test`,
      renderer,
      baseUrl: 'http://localhost:4321',
      token: async (tokenId) => deriveEmailToken(tokenId, secret),
    });
    const status = await createReferralService(f.app, { clock }).status(id);
    const view = presentReferralStatus(status);
    for (const field of view.fields) {
      assert.ok(
        rendered.message.text.includes(`${field.label}: ${field.value}`),
      );
    }
    assert.ok(rendered.message.text.includes('/me?t='));
  } finally {
    await f.close();
  }
});

test('a newly awarded referral tier queues one renderable milestone from the live transition', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner);
    await createReferralService(f.app, { clock }).generateCode(id);
    for (let index = 0; index < 3; index += 1) {
      await confirmedEdge(f.owner, id);
    }
    const referral = createReferralService(f.app, { clock });
    assert.deepEqual(await referral.backfillTier(1, 'e8-03a-test', 10, now), {
      awarded: 1,
      checked: 1,
    });
    assert.deepEqual(await referral.backfillTier(1, 'e8-03a-test', 10, now), {
      awarded: 0,
      checked: 0,
    });
    const rows = await sendRows(f.owner, id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.business_key, `milestone:${id}:1`);
    const renderer = createTransactionalRenderers({
      baseUrl: 'http://localhost:4321',
      sendingDomain: 'send.valstara.com',
      data: createTransactionalTemplateData(f.app),
    }).get('milestone_reached');
    assert.ok(renderer);
    const rendered = await prepareDispatchMessage({
      row: rows[0]!,
      recipient: `${id}@example.test`,
      renderer,
      baseUrl: 'http://localhost:4321',
      token: async (tokenId) => deriveEmailToken(tokenId, secret),
    });
    assert.match(rendered.message.text, /Settled/u);
    assert.match(rendered.message.text, /Held/u);
  } finally {
    await f.close();
  }
});

test('first entry per rules version queues one receipt and the flag-off path queues none', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner);
    let enabled = false;
    const flags = { isEnabled: async () => enabled };
    const accrue = (current: typeof rules) =>
      createGiveawayAccrualService(f.app, flags, () => current, now, clock);
    assert.equal(await accrue(rules).accrue(id, 'base'), false);
    assert.equal((await sendRows(f.owner, id)).length, 0);
    enabled = true;
    assert.equal(await accrue(rules).accrue(id, 'base'), true);
    const firstEdge = await confirmedEdge(f.owner, id);
    assert.equal(await accrue(rules).accrue(id, 'referral', firstEdge), true);
    assert.equal(await accrue(rules).accrue(id, 'referral', firstEdge), false);
    const secondEdge = await confirmedEdge(f.owner, id);
    assert.equal(
      await accrue(otherRules).accrue(id, 'referral', secondEdge),
      true,
    );
    const rows = await sendRows(f.owner, id);
    assert.deepEqual(
      rows.map((row) => row.business_key),
      [
        `giveaway-receipt:${id}:${rules.rulesVersion}`,
        `giveaway-receipt:${id}:${otherRules.rulesVersion}`,
      ],
    );
    enabled = false;
    const thirdEdge = await confirmedEdge(f.owner, id);
    assert.equal(
      await accrue(otherRules).accrue(id, 'referral', thirdEdge),
      false,
    );
    assert.equal((await sendRows(f.owner, id)).length, 2);
  } finally {
    await f.close();
  }
});

test('enabling giveaway.open reconciles the first entry and queues its receipt once', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner);
    const flags = createFlagService(f.app, {
      currentRules: async () => rules,
      periodStart: now,
    });
    assert.equal((await sendRows(f.owner, id)).length, 0);
    await flags.set('giveaway.open', true, 'e8-03a-test');
    assert.equal((await sendRows(f.owner, id)).length, 1);
    await flags.set('giveaway.open', true, 'e8-03a-test');
    const rows = await sendRows(f.owner, id);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]?.business_key,
      `giveaway-receipt:${id}:${rules.rulesVersion}`,
    );
  } finally {
    await f.close();
  }
});

test('queue failure rolls back the status token but commits verification, tier and entry events', async () => {
  const f = await fixture();
  try {
    const failing = createTransactionalEmailProducers(f.app, clock, {
      async queue() {
        throw new Error('injected_queue_failure');
      },
    });
    const pendingId = await subscriber(f.owner, 'pending');
    const token = await verifyToken(f.owner, pendingId);
    const complete = createVerificationCompletionService(f.app, {
      clock,
      emailProducers: failing,
    });
    assert.equal((await complete(token)).outcome, 'verified');
    assert.equal((await sendRows(f.owner, pendingId)).length, 0);
    const verified = await f.owner.readOne<{ status: string }>({
      text: 'SELECT status FROM subscriber WHERE id = $1',
      values: [pendingId],
    });
    assert.equal(verified?.status, 'verified');
    const verificationStatusTokens = await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM verification_token
        WHERE subscriber_id = $1 AND purpose = 'status'`,
      values: [pendingId],
    });
    assert.equal(verificationStatusTokens?.count, '1');

    const referrerId = await subscriber(f.owner);
    for (let index = 0; index < 3; index += 1)
      await confirmedEdge(f.owner, referrerId);
    const referral = createReferralService(f.app, {
      clock,
      milestoneEmail: failing.milestone,
    });
    assert.deepEqual(await referral.backfillTier(1, 'e8-03a-test', 10, now), {
      awarded: 1,
      checked: 1,
    });
    assert.equal((await sendRows(f.owner, referrerId)).length, 0);
    const award = await f.owner.readOne<{ id: string }>({
      text: `SELECT id FROM milestone_award WHERE subscriber_id = $1 AND tier = 1`,
      values: [referrerId],
    });
    assert.ok(award);

    const flags = { isEnabled: async () => true };
    const accrual = createGiveawayAccrualService(
      f.app,
      flags,
      () => rules,
      now,
      clock,
      failing.receipt,
    );
    assert.equal(await accrual.accrue(referrerId, 'base'), true);
    assert.equal((await sendRows(f.owner, referrerId)).length, 0);
    const entry = await f.owner.readOne<{ id: string }>({
      text: `SELECT id FROM giveaway_entry WHERE subscriber_id = $1`,
      values: [referrerId],
    });
    assert.ok(entry);
    const laterEdge = await confirmedEdge(f.owner, referrerId);
    const workingAccrual = createGiveawayAccrualService(
      f.app,
      flags,
      () => rules,
      now,
      clock,
    );
    assert.equal(
      await workingAccrual.accrue(referrerId, 'referral', laterEdge),
      true,
    );
    assert.equal((await sendRows(f.owner, referrerId)).length, 0);
    const failedProducerTokens = await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM verification_token
        WHERE subscriber_id = $1 AND purpose = 'status'`,
      values: [referrerId],
    });
    assert.equal(failedProducerTokens?.count, '0');
  } finally {
    await f.close();
  }
});
