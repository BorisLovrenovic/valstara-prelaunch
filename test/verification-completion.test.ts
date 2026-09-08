import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createReferralCode,
  createReferralService,
} from '../src/server/referral/service.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-08T12:00:00.000Z');

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e307_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e3-07-test',
  });

  return {
    database,
    async dispose() {
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
  await database.execute({
    text: `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      )
      VALUES ($1, $2, $3, 'verify', $4)
    `,
    values: [
      randomUUID(),
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
      'completion-token',
    );

    const complete = createVerificationCompletionService(fixture.database, {
      clock: () => now,
    });
    const result = await complete('completion-token');

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
      confirmed_referrals: number;
      referral_tier: number;
    }>({
      text: 'SELECT confirmed_referrals, referral_tier FROM subscriber WHERE id = $1',
      values: [referrerId],
    });
    assert.deepEqual(referrer, { confirmed_referrals: 3, referral_tier: 1 });

    const award = await fixture.database.readOne<{
      reward_kind: string;
      state: string;
    }>({
      text: 'SELECT reward_kind, state FROM milestone_award WHERE subscriber_id = $1',
      values: [referrerId],
    });
    assert.deepEqual(award, { reward_kind: 'discount', state: 'held' });
  } finally {
    await fixture.dispose();
  }
});

test('an induced failure rolls back every E3-07 transition', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    const referredId = await insertSubscriber(fixture.database, 'pending');
    await seedAttributedEdge(fixture.database, referrerId, referredId);
    await seedVerificationToken(fixture.database, referredId, 'rollback-token');

    const complete = createVerificationCompletionService(fixture.database, {
      afterStep: async (step) => {
        if (step === 'access-window') {
          throw new Error('induced mid-transaction failure');
        }
      },
      clock: () => now,
    });
    await assert.rejects(complete('rollback-token'), /induced/u);

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
    const token = await fixture.database.readOne<{ consumed_at: Date | null }>({
      text: 'SELECT consumed_at FROM verification_token WHERE subscriber_id = $1',
      values: [referredId],
    });
    assert.equal(token?.consumed_at, null);
  } finally {
    await fixture.dispose();
  }
});

test('with referral.enabled off, verification remains successful and leaves referral state untouched', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, 'verified');
    const referredId = await insertSubscriber(fixture.database, 'pending');
    await seedAttributedEdge(fixture.database, referrerId, referredId);
    await seedVerificationToken(fixture.database, referredId, 'flag-off-token');

    const result = await createVerificationCompletionService(fixture.database, {
      clock: () => now,
      referralEnabled: false,
    })('flag-off-token');
    assert.equal(result.outcome, 'verified');
    assert.equal(result.referralCode, null);

    const edge = await fixture.database.readOne<{
      reward_state: string;
      state: string;
    }>({
      text: 'SELECT state, reward_state FROM referral_edge WHERE referred_id = $1',
      values: [referredId],
    });
    assert.deepEqual(edge, { reward_state: 'none', state: 'attributed' });
  } finally {
    await fixture.dispose();
  }
});

test('referral codes are unambiguous, collision-safe, case-insensitive on lookup, and unavailable to pending rows', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const codes = new Set<string>();
    const symbolCounts = new Map<string, number>();
    for (let index = 0; index < 2_000; index += 1) {
      const code = createReferralCode();
      assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/u);
      codes.add(code);
      for (const symbol of code) {
        symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
      }
    }
    assert.equal(codes.size, 2_000);
    assert.ok(
      [...symbolCounts.values()].every((count) => count > 400),
      'a large sample must use every permitted code symbol, not a narrow subset',
    );

    const firstId = await insertSubscriber(fixture.database, 'verified');
    const secondId = await insertSubscriber(fixture.database, 'verified');
    const existingCode = 'ABCDEFGHJKMN';
    const replacementCode = 'QRSTUVWXYZ23';
    const first = createReferralService(fixture.database, {
      createCode: () => existingCode,
    });
    assert.equal(await first.generateCode(firstId), existingCode);

    let calls = 0;
    const second = createReferralService(fixture.database, {
      createCode: () => {
        calls += 1;
        return calls === 1 ? existingCode : replacementCode;
      },
    });
    assert.equal(await second.generateCode(secondId), replacementCode);
    assert.equal(
      await second.lookupCode(replacementCode.toLowerCase()),
      secondId,
    );

    const pendingId = await insertSubscriber(fixture.database, 'pending');
    await assert.rejects(
      createReferralService(fixture.database, {
        createCode: () => 'BCDEFGHJKLMN',
      }).generateCode(pendingId),
      /allocate/u,
    );
  } finally {
    await fixture.dispose();
  }
});
