import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createStatusLinkRecoveryBoundary,
  createStatusLinkService,
} from '../src/server/verification/status-link.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-22T12:00:00.000Z');

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e604_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e6-04-test',
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

async function seedSubscriber(
  database: DatabasePool,
  label: string,
): Promise<string> {
  const id = randomUUID();
  const email = `${label}-${id}@example.test`;
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at
      )
      VALUES ($1, $2, $2, 'example.test', 'verified', $3)
    `,
    values: [id, email, now],
  });
  return id;
}

async function seedStatusToken(
  database: DatabasePool,
  input: {
    readonly expiresAt: Date;
    readonly subscriberId: string;
    readonly token: string;
  },
): Promise<void> {
  await database.execute({
    text: `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      )
      VALUES ($1, $2, $3, 'status', $4)
    `,
    values: [
      randomUUID(),
      input.subscriberId,
      createHash('sha256').update(input.token).digest(),
      input.expiresAt,
    ],
  });
}

test('status bearer authentication returns only the token-bound subscriber and rejects cross-subject substitution', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const firstSubscriber = await seedSubscriber(fixture.database, 'first');
    const secondSubscriber = await seedSubscriber(fixture.database, 'second');
    await seedStatusToken(fixture.database, {
      expiresAt: new Date('2026-10-22T12:00:00.000Z'),
      subscriberId: firstSubscriber,
      token: 'first-status-token',
    });
    await seedStatusToken(fixture.database, {
      expiresAt: new Date('2026-10-22T12:00:00.000Z'),
      subscriberId: secondSubscriber,
      token: 'second-status-token',
    });
    const service = createStatusLinkService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });

    assert.deepEqual(await service.authenticate('first-status-token'), {
      kind: 'authenticated',
      subscriberId: firstSubscriber,
    });
    assert.deepEqual(await service.authenticate('first-status-token'), {
      kind: 'authenticated',
      subscriberId: firstSubscriber,
    });
    assert.notDeepEqual(await service.authenticate('first-status-token'), {
      kind: 'authenticated',
      subscriberId: secondSubscriber,
    });
  } finally {
    await fixture.dispose();
  }
});

test('expired and tampered status tokens have the identical rejected authentication result', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await seedSubscriber(fixture.database, 'expired');
    await seedStatusToken(fixture.database, {
      expiresAt: now,
      subscriberId,
      token: 'expired-status-token',
    });
    const service = createStatusLinkService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });

    const expired = await service.authenticate('expired-status-token');
    const tampered = await service.authenticate('tampered-status-token');
    assert.deepEqual(expired, { kind: 'rejected' });
    assert.deepEqual(expired, tampered);
  } finally {
    await fixture.dispose();
  }
});

test('a status token used before expiry is rejected once its expiry passes', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await seedSubscriber(
      fixture.database,
      'used-before-expiry',
    );
    await seedStatusToken(fixture.database, {
      expiresAt: new Date('2026-09-22T12:01:00.000Z'),
      subscriberId,
      token: 'used-before-expiry-token',
    });
    let time = now;
    const service = createStatusLinkService(fixture.applicationDatabase, {
      clock: () => time,
      flags: { isEnabled: async () => true },
    });
    assert.equal(
      (await service.authenticate('used-before-expiry-token')).kind,
      'authenticated',
    );
    time = new Date('2026-09-22T12:01:00.000Z');
    assert.deepEqual(await service.authenticate('used-before-expiry-token'), {
      kind: 'rejected',
    });
  } finally {
    await fixture.dispose();
  }
});

test('a rejected Turnstile challenge stops recovery before flag, rate-limit, token, or email work', async () => {
  const calls: string[] = [];
  const recover = createStatusLinkRecoveryBoundary({
    async verifyTurnstile(token) {
      calls.push(`turnstile:${token}`);
      return 'rejected';
    },
    async recover() {
      calls.push('status-link-recovery');
      return 'accepted';
    },
  });

  assert.equal(await recover('rejected-token'), 'challenge_failed');
  assert.deepEqual(calls, ['turnstile:rejected-token']);
});

test('a Turnstile provider timeout reaches recovery with the strict-limit signal', async () => {
  const calls: string[] = [];
  const recover = createStatusLinkRecoveryBoundary({
    async verifyTurnstile() {
      calls.push('turnstile');
      return 'unavailable';
    },
    async recover(challengeTimedOut) {
      calls.push(`recovery:${challengeTimedOut}`);
      return 'accepted';
    },
  });

  assert.equal(await recover('provider-timeout-token'), 'accepted');
  assert.deepEqual(calls, ['turnstile', 'recovery:true']);
});

test('one-click recovery queues once for the expired token subject and rate-limits a repeat', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await seedSubscriber(fixture.database, 'recovery');
    await seedStatusToken(fixture.database, {
      expiresAt: now,
      subscriberId,
      token: 'recoverable-status-token',
    });
    const service = createStatusLinkService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });

    assert.equal(
      await service.requestReplacement({
        challengeTimedOut: false,
        ipPrefixHash: 'hashed-prefix',
        token: 'recoverable-status-token',
      }),
      'accepted',
    );
    assert.equal(
      await service.requestReplacement({
        challengeTimedOut: false,
        ipPrefixHash: 'hashed-prefix',
        token: 'recoverable-status-token',
      }),
      'rate_limited',
    );
    assert.equal(
      await service.requestReplacement({
        challengeTimedOut: false,
        ipPrefixHash: 'other-hashed-prefix',
        token: 'tampered-status-token',
      }),
      'accepted',
    );

    const sends = await fixture.database.list<{
      subscriber_id: string;
      template: string;
    }>(
      {
        text: 'SELECT subscriber_id, template FROM email_send ORDER BY created_at',
      },
      10,
    );
    assert.deepEqual(sends, [
      { subscriber_id: subscriberId, template: 'status_link' },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('provider-timeout recovery uses the strict IP bucket and flags the recognised subscriber', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await seedSubscriber(
      fixture.database,
      'timeout-recovery',
    );
    await seedStatusToken(fixture.database, {
      expiresAt: now,
      subscriberId,
      token: 'timeout-recovery-status-token',
    });
    const service = createStatusLinkService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });

    assert.equal(
      await service.requestReplacement({
        challengeTimedOut: true,
        ipPrefixHash: 'timeout-prefix',
        token: 'timeout-recovery-status-token',
      }),
      'accepted',
    );

    const buckets = await fixture.database.list<{ key: string }>(
      {
        text: `
          SELECT key
          FROM rate_limit_bucket
          WHERE key LIKE 'status-link-recovery:ip:%'
        `,
      },
      10,
    );
    const flags = await fixture.database.list<{
      kind: string;
      subscriber_id: string;
    }>(
      {
        text: `
          SELECT subscriber_id, kind
          FROM fraud_flag
          WHERE subscriber_id = $1
        `,
        values: [subscriberId],
      },
      10,
    );
    assert.deepEqual(buckets, [
      { key: 'status-link-recovery:ip:strict:timeout-prefix' },
    ]);
    assert.deepEqual(flags, [
      { kind: 'challenge_timeout', subscriber_id: subscriberId },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('member.dashboard off is graceful and creates no consume or recovery write', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await seedSubscriber(fixture.database, 'disabled');
    await seedStatusToken(fixture.database, {
      expiresAt: new Date('2026-10-22T12:00:00.000Z'),
      subscriberId,
      token: 'disabled-status-token',
    });
    const service = createStatusLinkService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => false },
    });

    assert.deepEqual(await service.authenticate('disabled-status-token'), {
      kind: 'disabled',
    });
    assert.equal(
      await service.requestReplacement({
        challengeTimedOut: false,
        ipPrefixHash: 'hashed-prefix',
        token: 'disabled-status-token',
      }),
      'disabled',
    );
    const token = await fixture.database.readOne<{ consumed_at: Date | null }>({
      text: 'SELECT consumed_at FROM verification_token WHERE subscriber_id = $1',
      values: [subscriberId],
    });
    const sendCount = await fixture.database.readOne<{ count: string }>({
      text: 'SELECT COUNT(*)::text AS count FROM email_send',
    });
    assert.equal(token?.consumed_at, null);
    assert.equal(sendCount?.count, '0');
  } finally {
    await fixture.dispose();
  }
});
