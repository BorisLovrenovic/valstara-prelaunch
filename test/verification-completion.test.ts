import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createStrandedReferralReconciliationJob } from '../src/server/referral/reconcile-stranded.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-08T12:00:00.000Z');
const tokenIds = new Map<string, string>();

function tokenValue(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const token = deriveEmailToken(id, process.env.EMAIL_TOKEN_SECRET!);
  tokenIds.set(token, id);
  return token;
}

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e307_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationDatabaseUrl = new URL(databaseUrl);
  applicationDatabaseUrl.username = 'valstara_app';
  applicationDatabaseUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e3-07-test',
  });
  const applicationDatabase = createPool(applicationDatabaseUrl.toString());

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

test('the application role completes verification and replay through the E3 transaction', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'pending');
    await seedVerificationToken(
      fixture.database,
      subscriberId,
      tokenValue('application-role-completion-token'),
    );

    const complete = createVerificationCompletionService(
      fixture.applicationDatabase,
      { clock: () => now },
    );
    assert.equal(
      (await complete(tokenValue('application-role-completion-token'))).outcome,
      'verified',
    );
    assert.equal(
      (await complete(tokenValue('application-role-completion-token'))).outcome,
      'already',
    );

    const subscriber = await fixture.database.readOne<{
      status: string;
      verified_at: Date | null;
    }>({
      text: 'SELECT status, verified_at FROM subscriber WHERE id = $1',
      values: [subscriberId],
    });
    assert.equal(subscriber?.status, 'verified');
    assert.notEqual(subscriber?.verified_at, null);
  } finally {
    await fixture.dispose();
  }
});

test('concurrent verifications receive distinct recorded orders at a wave boundary', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const firstId = await insertSubscriber(fixture.database, 'pending');
    const secondId = await insertSubscriber(fixture.database, 'pending');
    await seedVerificationToken(
      fixture.database,
      firstId,
      tokenValue('wave-token-one'),
    );
    await seedVerificationToken(
      fixture.database,
      secondId,
      tokenValue('wave-token-two'),
    );

    const complete = createVerificationCompletionService(fixture.database, {
      accessWindowBands: [
        { maximumVerificationOrder: 1, window: 'wave-1' },
        { maximumVerificationOrder: 2, window: 'wave-2' },
        { maximumVerificationOrder: 3, window: 'wave-3' },
        { maximumVerificationOrder: null, window: 'wave-4' },
      ],
      clock: () => now,
    });
    const results = await Promise.all([
      complete(tokenValue('wave-token-one')),
      complete(tokenValue('wave-token-two')),
    ]);

    assert.deepEqual(results.map((result) => result.accessWindow).sort(), [
      'wave-1',
      'wave-2',
    ]);
    const persisted = await fixture.database.list<{ access_window: string }>(
      {
        text: `
          SELECT access_window
          FROM subscriber
          WHERE id = $1 OR id = $2
          ORDER BY access_window
        `,
        values: [firstId, secondId],
      },
      2,
    );
    assert.deepEqual(persisted, [
      { access_window: 'wave-1' },
      { access_window: 'wave-2' },
    ]);
  } finally {
    await fixture.dispose();
  }
});

async function insertSubscriber(
  database: DatabasePool,
  status: 'pending' | 'verified',
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at
      )
      VALUES ($1, $2, $3, 'example.test', $4, $5)
    `,
    values: [
      id,
      `${id}@example.test`,
      `${id}@example.test`,
      status,
      status === 'verified' ? now : null,
    ],
  });
  return id;
}

async function seedVerificationToken(
  database: DatabasePool,
  subscriberId: string,
  token: string,
): Promise<void> {
  const tokenId = tokenIds.get(token);
  assert.ok(tokenId, 'fixture token must be HMAC-derived from its recorded id');
  await database.execute({
    text: `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      )
      VALUES ($1, $2, $3, 'verify', $4)
    `,
    values: [
      tokenId,
      subscriberId,
      createHash('sha256').update(token).digest(),
      new Date('2026-09-15T12:00:00.000Z'),
    ],
  });
}

async function seedAttributedEdge(
  database: DatabasePool,
  referrerId: string,
  referredId: string,
): Promise<void> {
  await database.execute({
    text: `
      INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
      VALUES ($1, $2, $3, 'attributed', 'none')
    `,
    values: [randomUUID(), referrerId, referredId],
  });
}

test('verification commits the referral completion together and holds high-value Tier 1 rewards', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    await fixture.database.execute({
      text: "UPDATE subscriber SET access_window = 'wave-3' WHERE id = $1",
      values: [referrerId],
    });
    for (let index = 0; index < 2; index += 1) {
      const priorReferral = await insertSubscriber(
        fixture.database,
        'verified',
      );
      await fixture.database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state, confirmed_at
          )
          VALUES ($1, $2, $3, 'confirmed', 'settled', $4)
        `,
        values: [randomUUID(), referrerId, priorReferral, now],
      });
    }
    const referredId = await insertSubscriber(fixture.database, 'pending');
    await seedAttributedEdge(fixture.database, referrerId, referredId);
    await seedVerificationToken(
      fixture.database,
      referredId,
      tokenValue('completion-token'),
    );

    const complete = createVerificationCompletionService(fixture.database, {
      clock: () => now,
    });
    const result = await complete(tokenValue('completion-token'));

    assert.equal(result.outcome, 'verified');
    assert.match(
      result.referralCode ?? '',
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/u,
    );
    assert.equal(result.accessWindow, 'wave-1');
    assert.notEqual(result.statusToken, null);

    const edge = await fixture.database.readOne<{
      reward_state: string;
      state: string;
    }>({
      text: 'SELECT state, reward_state FROM referral_edge WHERE referred_id = $1',
      values: [referredId],
    });
    assert.deepEqual(edge, { reward_state: 'settled', state: 'confirmed' });

    const referrer = await fixture.database.readOne<{
      access_window: string;
      confirmed_referrals: number;
      referral_tier: number;
    }>({
      text: 'SELECT confirmed_referrals, referral_tier, access_window FROM subscriber WHERE id = $1',
      values: [referrerId],
    });
    assert.deepEqual(referrer, {
      access_window: 'wave-2',
      confirmed_referrals: 3,
      referral_tier: 1,
    });
    assert.deepEqual(
      await fixture.database.readOne({
        text: `
          SELECT actor, detail
          FROM audit_log
          WHERE action = 'referral.access_window_promoted'
        `,
      }),
      {
        actor: 'system:referral-confirmation',
        detail: {
          fromTier: 0,
          fromWindow: 'wave-3',
          toTier: 1,
          toWindow: 'wave-2',
        },
      },
    );

    const awards = await fixture.database.list<{
      reward_kind: string;
      state: string;
    }>(
      {
        text: `
        SELECT reward_kind, state
        FROM milestone_award
        WHERE subscriber_id = $1
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
  } finally {
    await fixture.dispose();
  }
});

test('an attributed edge cannot confirm before its referred subscriber verifies', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    const referredId = await insertSubscriber(fixture.database, 'pending');
    await seedAttributedEdge(fixture.database, referrerId, referredId);

    await createReferralService(fixture.database).confirm(referredId, now);

    const edge = await fixture.database.readOne<{ state: string }>({
      text: 'SELECT state FROM referral_edge WHERE referred_id = $1',
      values: [referredId],
    });
    const referrer = await fixture.database.readOne<{
      confirmed_referrals: number;
    }>({
      text: 'SELECT confirmed_referrals FROM subscriber WHERE id = $1',
      values: [referrerId],
    });
    assert.deepEqual(edge, { state: 'attributed' });
    assert.deepEqual(referrer, { confirmed_referrals: 0 });
  } finally {
    await fixture.dispose();
  }
});

test('confirmation derives the counter from edges and evaluates each milestone only once', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    await fixture.database.execute({
      text: 'UPDATE subscriber SET confirmed_referrals = 99 WHERE id = $1',
      values: [referrerId],
    });
    for (let index = 0; index < 2; index += 1) {
      const priorReferredId = await insertSubscriber(
        fixture.database,
        'verified',
      );
      await fixture.database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state, confirmed_at
          ) VALUES ($1, $2, $3, 'confirmed', 'settled', $4)
        `,
        values: [randomUUID(), referrerId, priorReferredId, now],
      });
    }
    const referredId = await insertSubscriber(fixture.database, 'verified');
    await seedAttributedEdge(fixture.database, referrerId, referredId);

    const referral = createReferralService(fixture.database);
    await referral.confirm(referredId, now);
    await referral.confirm(referredId, now);

    const referrer = await fixture.database.readOne<{
      confirmed_referrals: number;
      referral_tier: number;
    }>({
      text: 'SELECT confirmed_referrals, referral_tier FROM subscriber WHERE id = $1',
      values: [referrerId],
    });
    const awards = await fixture.database.list<{ reward_kind: string }>(
      {
        text: `
          SELECT reward_kind
          FROM milestone_award
          WHERE subscriber_id = $1
          ORDER BY reward_kind
        `,
        values: [referrerId],
      },
      3,
    );
    assert.deepEqual(referrer, { confirmed_referrals: 3, referral_tier: 1 });
    assert.deepEqual(awards, [
      { reward_kind: 'discount' },
      { reward_kind: 'entries' },
      { reward_kind: 'wave_upgrade' },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('an induced failure rolls back every E3-07 transition', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    for (let index = 0; index < 2; index += 1) {
      const priorReferral = await insertSubscriber(
        fixture.database,
        'verified',
      );
      await fixture.database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state, confirmed_at
          )
          VALUES ($1, $2, $3, 'confirmed', 'settled', $4)
        `,
        values: [randomUUID(), referrerId, priorReferral, now],
      });
    }
    const referredId = await insertSubscriber(fixture.database, 'pending');
    await seedAttributedEdge(fixture.database, referrerId, referredId);
    await seedVerificationToken(
      fixture.database,
      referredId,
      tokenValue('rollback-token'),
    );

    const complete = createVerificationCompletionService(fixture.database, {
      afterStep: async (step) => {
        if (step === 'referral-confirmed') {
          throw new Error('induced mid-transaction failure');
        }
      },
      clock: () => now,
    });
    await assert.rejects(complete(tokenValue('rollback-token')), /induced/u);

    const subscriber = await fixture.database.readOne<{
      access_window: string | null;
      referral_code: string | null;
      status: string;
    }>({
      text: 'SELECT status, referral_code, access_window FROM subscriber WHERE id = $1',
      values: [referredId],
    });
    assert.deepEqual(subscriber, {
      access_window: null,
      referral_code: null,
      status: 'pending',
    });
    const edge = await fixture.database.readOne<{
      reward_state: string;
      state: string;
    }>({
      text: 'SELECT state, reward_state FROM referral_edge WHERE referred_id = $1',
      values: [referredId],
    });
    assert.deepEqual(edge, { reward_state: 'none', state: 'attributed' });
    const referrer = await fixture.database.readOne<{
      confirmed_referrals: number;
      referral_tier: number;
    }>({
      text: 'SELECT confirmed_referrals, referral_tier FROM subscriber WHERE id = $1',
      values: [referrerId],
    });
    assert.deepEqual(referrer, { confirmed_referrals: 0, referral_tier: 0 });
    const award = await fixture.database.readOne<{
      reward_kind: string;
      state: string;
    }>({
      text: 'SELECT reward_kind, state FROM milestone_award WHERE subscriber_id = $1',
      values: [referrerId],
    });
    assert.equal(award, null);
    const token = await fixture.database.readOne<{ consumed_at: Date | null }>({
      text: 'SELECT consumed_at FROM verification_token WHERE subscriber_id = $1',
      values: [referredId],
    });
    assert.equal(token?.consumed_at, null);
  } finally {
    await fixture.dispose();
  }
});

test('with referral.enabled off, verification still confirms and settles an existing edge', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    for (let index = 0; index < 2; index += 1) {
      const priorReferralId = await insertSubscriber(
        fixture.database,
        'verified',
      );
      await fixture.database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state, confirmed_at
          ) VALUES ($1, $2, $3, 'confirmed', 'settled', $4)
        `,
        values: [randomUUID(), referrerId, priorReferralId, now],
      });
    }
    const referredId = await insertSubscriber(fixture.database, 'pending');
    await seedAttributedEdge(fixture.database, referrerId, referredId);
    await seedVerificationToken(
      fixture.database,
      referredId,
      tokenValue('flag-off-token'),
    );

    const result = await createVerificationCompletionService(fixture.database, {
      clock: () => now,
      referralEnabled: false,
    })(tokenValue('flag-off-token'));
    assert.equal(result.outcome, 'verified');
    assert.equal(result.referralCode, null);

    const subscriber = await fixture.database.readOne<{
      referral_code: string | null;
    }>({
      text: 'SELECT referral_code FROM subscriber WHERE id = $1',
      values: [referredId],
    });
    assert.match(
      subscriber?.referral_code ?? '',
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/u,
    );

    const edge = await fixture.database.readOne<{
      reward_state: string;
      state: string;
    }>({
      text: 'SELECT state, reward_state FROM referral_edge WHERE referred_id = $1',
      values: [referredId],
    });
    assert.deepEqual(edge, { reward_state: 'settled', state: 'confirmed' });
    assert.deepEqual(
      await fixture.database.readOne({
        text: 'SELECT referral_tier FROM subscriber WHERE id = $1',
        values: [referrerId],
      }),
      { referral_tier: 1 },
    );
    const awards = await fixture.database.list<{
      reward_kind: string;
      state: string;
    }>(
      {
        text: `
          SELECT reward_kind, state
          FROM milestone_award
          WHERE subscriber_id = $1 AND tier = 1
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
  } finally {
    await fixture.dispose();
  }
});

test('a replay repairs an edge previously stranded while referral.enabled was off', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    const referredId = await insertSubscriber(fixture.database, 'verified');
    await seedAttributedEdge(fixture.database, referrerId, referredId);
    await seedVerificationToken(
      fixture.database,
      referredId,
      tokenValue('stranded-token'),
    );
    await fixture.database.execute({
      text: 'UPDATE verification_token SET consumed_at = $2 WHERE subscriber_id = $1',
      values: [referredId, now],
    });

    const result = await createVerificationCompletionService(fixture.database, {
      clock: () => now,
      referralEnabled: false,
    })(tokenValue('stranded-token'));
    assert.equal(result.outcome, 'already');
    assert.equal(result.referralCode, null);

    const edge = await fixture.database.readOne<{
      reward_state: string;
      state: string;
    }>({
      text: 'SELECT state, reward_state FROM referral_edge WHERE referred_id = $1',
      values: [referredId],
    });
    assert.deepEqual(edge, { reward_state: 'settled', state: 'confirmed' });
  } finally {
    await fixture.dispose();
  }
});

test('the bounded reconciliation job repairs already-stranded verified rows', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    const firstReferredId = await insertSubscriber(
      fixture.database,
      'verified',
    );
    const secondReferredId = await insertSubscriber(
      fixture.database,
      'verified',
    );
    await seedAttributedEdge(fixture.database, referrerId, firstReferredId);
    await seedAttributedEdge(fixture.database, referrerId, secondReferredId);

    const job = createStrandedReferralReconciliationJob(fixture.database, {
      clock: () => now,
    });
    assert.equal(await job.run(1), 1);
    assert.equal(await job.run(1), 1);
    assert.equal(await job.run(1), 0);

    const states = await fixture.database.list<{ state: string }>(
      {
        text: `
          SELECT state FROM referral_edge
          WHERE referred_id = ANY($1::uuid[])
          ORDER BY referred_id
        `,
        values: [[firstReferredId, secondReferredId]],
      },
      2,
    );
    assert.deepEqual(states, [{ state: 'confirmed' }, { state: 'confirmed' }]);
  } finally {
    await fixture.dispose();
  }
});
