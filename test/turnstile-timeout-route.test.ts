import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { POST as signupPost } from '../src/pages/api/signup.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

function makeRequest(email: string): Request {
  return new Request('http://valstara.test/api/signup', {
    body: new URLSearchParams({
      email,
      turnstile_token: 'a-token',
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
}

function routeContext(request: Request) {
  return { clientAddress: '203.0.113.55', request } as never;
}

// End-to-end through the default wiring: when siteverify is unreachable the
// signup is accepted, the mail still queues, and the row is flagged for review
// (ADR-006, E3-03). This exercises the real turnstile module → route → db path.
test('a provider-unreachable signup, through the default wiring, commits the row and opens exactly one challenge_timeout flag', async () => {
  const databaseName = `valstara_e303timeout_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database: DatabasePool = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e3-03-timeout-route-test',
  });

  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.ADMIN_CREDENTIAL = 'timeout-route-admin-credential-32-chars';
  process.env.ADMIN_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.IP_PREFIX_PEPPER = 'timeout-route-test-pepper';
  process.env.REFERRAL_SIGNING_SECRET = 'timeout-route-referral-secret';
  process.env.TURNSTILE_SECRET_KEY = 'timeout-route-test-turnstile-secret';
  process.env.RESEND_API_KEY = 'timeout-route-test-resend-key';
  process.env.RESEND_DKIM_EXPECTED_VALUE = 'p=test-public-key';
  process.env.RESEND_KEY_MODE = 'test';
  process.env.RESEND_RSEND_CNAME_EXPECTED_TARGET =
    'rsend-euw1.forge.rmta.net';
  process.env.RESEND_SEND_CNAME_EXPECTED_TARGET = 'send.forge.rmta.net';
  process.env.RESEND_SENDING_DOMAIN = 'send.valstara.com';

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('challenges.cloudflare.com')) {
      throw new Error('ECONNREFUSED'); // the provider is unreachable
    }
    if (url === 'https://api.resend.com/emails') {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    const email = 'timeout-signup@gmail.com';
    const response = await signupPost(routeContext(makeRequest(email)));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'pending');

    const subscriber = await database.readOne<{ id: string }>({
      text: 'SELECT id FROM subscriber WHERE email_normalised = $1',
      values: [email],
    });
    assert.ok(subscriber, 'the signup should have committed a subscriber row');

    const flags = await database.list<{ kind: string; state: string }>(
      {
        text: 'SELECT kind, state FROM fraud_flag WHERE subscriber_id = $1',
        values: [subscriber.id],
      },
      10,
    );
    assert.deepEqual(flags, [{ kind: 'challenge_timeout', state: 'open' }]);

    // The strict rate-limit bucket was used, not the normal one.
    const buckets = await database.list<{ key: string }>(
      { text: 'SELECT key FROM rate_limit_bucket ORDER BY key' },
      10,
    );
    const signupBuckets = buckets
      .map((bucket) => bucket.key)
      .filter((key) => key.startsWith('signup:ip:'));
    assert.equal(signupBuckets.length, 1);
    assert.ok(
      signupBuckets[0]?.startsWith('signup:ip:strict:'),
      `expected the strict bucket, got ${signupBuckets[0]}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of [
      'ADMIN_CREDENTIAL',
      'ADMIN_TOTP_SECRET',
      'DATABASE_URL',
      'IP_PREFIX_PEPPER',
      'REFERRAL_SIGNING_SECRET',
      'TURNSTILE_SECRET_KEY',
      'RESEND_API_KEY',
      'RESEND_DKIM_EXPECTED_VALUE',
      'RESEND_KEY_MODE',
      'RESEND_RSEND_CNAME_EXPECTED_TARGET',
      'RESEND_SEND_CNAME_EXPECTED_TARGET',
      'RESEND_SENDING_DOMAIN',
    ]) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
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
  }
});
