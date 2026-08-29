import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createThinSignupRoute } from '../src/pages/api/signup.ts';
import {
  createThinSignupService,
  type VerificationTestMail,
} from '../src/server/e1-11/signup.ts';
import { consumeThinVerificationToken } from '../src/server/e1-11/verify.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e111_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e1-11-test',
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

function signupRequest(
  email: string,
  turnstileToken = 'valid-turnstile-token',
): Request {
  return new Request('http://valstara.test/api/signup', {
    method: 'POST',
    body: new URLSearchParams({
      email,
      turnstile_token: turnstileToken,
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

function routeContext(request: Request, clientAddress = '203.0.113.55') {
  return { clientAddress, request };
}

async function rowCount(
  database: DatabasePool,
  table: string,
): Promise<number> {
  const row = await database.readOne<{ count: string }>({
    text: `SELECT count(*)::text AS count FROM ${table}`,
  });
  return Number(row?.count);
}

test('E1-11 signup path verifies Turnstile first, writes one row/token/queued email, and token replay succeeds', async () => {
  const fixture = await createDatabaseFixture();
  const sentMails: VerificationTestMail[] = [];
  const order: string[] = [];
  const signup = createThinSignupService(fixture.database, {
    clock: () => new Date('2026-08-29T12:00:00.000Z'),
    ipPrefixPepper: 'test-pepper',
    async sendVerificationTestMail(mail) {
      order.push('resend');
      sentMails.push(mail);
    },
  });
  const route = createThinSignupRoute({
    async signup(input) {
      order.push('signup');
      return signup(input);
    },
    async verifyTurnstile(token) {
      order.push('turnstile');
      return token === 'valid-turnstile-token';
    },
  });

  try {
    const invalidChallenge = await route(
      routeContext(
        signupRequest('ignored@example.test', 'invalid-token'),
      ) as never,
    );
    assert.equal(invalidChallenge.status, 400);
    assert.deepEqual(order, ['turnstile']);
    assert.equal(await rowCount(fixture.database, 'subscriber'), 0);

    const [first, duplicate] = await Promise.all([
      route(routeContext(signupRequest('Test.User@Example.test')) as never),
      route(routeContext(signupRequest('test.user@example.test')) as never),
    ]);

    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(order.filter((step) => step === 'turnstile').length, 3);
    assert.equal(order.filter((step) => step === 'signup').length, 2);
    assert.equal(order.filter((step) => step === 'resend').length, 1);
    assert.equal(await rowCount(fixture.database, 'subscriber'), 1);
    assert.equal(await rowCount(fixture.database, 'verification_token'), 1);
    assert.equal(await rowCount(fixture.database, 'email_send'), 1);
    assert.equal(sentMails.length, 1);

    const verificationUrl = new URL(sentMails[0]?.verificationUrl ?? '');
    const token = verificationUrl.searchParams.get('token') ?? '';
    assert.notEqual(token, '');
    assert.equal(
      await consumeThinVerificationToken(
        fixture.database,
        token,
        new Date('2026-08-29T12:01:00.000Z'),
      ),
      'verified',
    );
    assert.equal(
      await consumeThinVerificationToken(
        fixture.database,
        token,
        new Date('2026-08-29T12:01:00.000Z'),
      ),
      'already',
    );
    const subscriber = await fixture.database.readOne<{
      email_normalised: string;
      status: string;
      verified_at: Date | null;
    }>({
      text: 'SELECT email_normalised, status, verified_at FROM subscriber',
    });
    assert.deepEqual(subscriber?.email_normalised, 'test.user@example.test');
    assert.equal(subscriber?.status, 'verified');
    assert.notEqual(subscriber?.verified_at, null);
  } finally {
    await fixture.dispose();
  }
});

test('E1-11 rate-limits a hashed IP-prefix window with an honest response', async () => {
  const fixture = await createDatabaseFixture();
  const signup = createThinSignupService(fixture.database, {
    clock: () => new Date('2026-08-29T12:00:00.000Z'),
    ipPrefixPepper: 'test-pepper',
    rateLimitMaximumAttempts: 1,
    async sendVerificationTestMail() {
      return undefined;
    },
  });
  const route = createThinSignupRoute({
    signup,
    async verifyTurnstile() {
      return true;
    },
  });

  try {
    const first = await route(
      routeContext(
        signupRequest('first@example.test'),
        '198.51.100.7',
      ) as never,
    );
    const blocked = await route(
      routeContext(
        signupRequest('second@example.test'),
        '198.51.100.42',
      ) as never,
    );

    assert.equal(first.status, 200);
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), {
      error: {
        code: 'rate_limited',
        message: 'Too many attempts — try again in a few minutes.',
      },
    });
    assert.equal(await rowCount(fixture.database, 'subscriber'), 1);
    const bucket = await fixture.database.readOne<{ key: string }>({
      text: 'SELECT key FROM rate_limit_bucket',
    });
    assert.match(bucket?.key ?? '', /^signup:ip:[a-f0-9]{64}$/);
    assert.doesNotMatch(bucket?.key ?? '', /198\.51\.100/);
  } finally {
    await fixture.dispose();
  }
});

test('E1-11 reports a post-challenge dependency failure without doing a signup', async () => {
  let signupCalled = false;
  const route = createThinSignupRoute({
    async signup() {
      signupCalled = true;
      throw new Error('database unavailable');
    },
    async verifyTurnstile() {
      return true;
    },
  });

  const response = await route(
    routeContext(signupRequest('unavailable@example.test')) as never,
  );

  assert.equal(signupCalled, true);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'unavailable',
      message:
        'The waitlist is temporarily unavailable. Please try again soon.',
    },
  });
});
