import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createResendVerificationRoute,
  resendVerificationMinimumResponseMs,
  type ResendVerificationRouteDependencies,
} from '../src/pages/api/resend-verification.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createResendVerificationService } from '../src/server/subscriber/resend-verification.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e309_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e3-09-test',
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

function makeRequest(email: string, token = 'valid-token'): Request {
  return new Request('http://valstara.test/api/resend-verification', {
    body: new URLSearchParams({ email, turnstile_token: token }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
}

function routeContext(request: Request, clientAddress = '203.0.113.10') {
  return { clientAddress, request } as never;
}

function routeDependencies(
  overrides: Partial<ResendVerificationRouteDependencies> = {},
): ResendVerificationRouteDependencies {
  return {
    verifyTurnstile: async () => 'verified',
    consumeAddressRateLimit: async () => 'ok',
    consumeIpRateLimit: async () => 'ok',
    resendVerification: async () => ({ pendingSubscriberId: null }),
    flagChallengeTimeout: async () => undefined,
    ...overrides,
  };
}

test('known and unknown addresses have the same response, status, and padded timing', async () => {
  let elapsed = 0;
  const completionTimes: number[] = [];
  const route = createResendVerificationRoute(
    routeDependencies({
      monotonicClock: () => elapsed,
      async resendVerification(input) {
        elapsed += input.email === 'known@example.test' ? 30 : 5;
        return {
          pendingSubscriberId:
            input.email === 'known@example.test' ? 'subscriber-id' : null,
        };
      },
      async sleep(milliseconds) {
        elapsed += milliseconds;
      },
    }),
  );

  const known = await route(routeContext(makeRequest('known@example.test')));
  completionTimes.push(elapsed);
  elapsed = 0;
  const unknown = await route(
    routeContext(makeRequest('unknown@example.test')),
  );
  completionTimes.push(elapsed);

  assert.equal(known.status, unknown.status);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.deepEqual(completionTimes, [
    resendVerificationMinimumResponseMs,
    resendVerificationMinimumResponseMs,
  ]);
});

test('Turnstile is verified before rate limits and the resend service', async () => {
  const order: string[] = [];
  const route = createResendVerificationRoute(
    routeDependencies({
      async verifyTurnstile() {
        order.push('turnstile');
        return 'verified';
      },
      async consumeIpRateLimit() {
        order.push('ip');
        return 'ok';
      },
      async consumeAddressRateLimit() {
        order.push('address');
        return 'ok';
      },
      async resendVerification() {
        order.push('resend');
        return { pendingSubscriberId: null };
      },
      sleep: async () => undefined,
    }),
  );

  await route(routeContext(makeRequest('person@example.test')));
  assert.deepEqual(order, ['turnstile', 'ip', 'address', 'resend']);
});

test('both IP-prefix and normalised-address limits independently reject requests', async () => {
  let addressCalled = false;
  const ipLimited = createResendVerificationRoute(
    routeDependencies({
      consumeIpRateLimit: async () => 'rate_limited',
      async consumeAddressRateLimit() {
        addressCalled = true;
        return 'ok';
      },
      sleep: async () => undefined,
    }),
  );
  const ipResponse = await ipLimited(
    routeContext(makeRequest('one@example.test')),
  );
  assert.equal(ipResponse.status, 429);
  assert.equal(addressCalled, false);

  let receivedAddress: string | undefined;
  const addressLimited = createResendVerificationRoute(
    routeDependencies({
      async consumeAddressRateLimit(address) {
        receivedAddress = address;
        return 'rate_limited';
      },
      sleep: async () => undefined,
    }),
  );
  const addressResponse = await addressLimited(
    routeContext(makeRequest('User+tag@Gmail.com')),
  );
  assert.equal(addressResponse.status, 429);
  assert.equal(receivedAddress, 'user@gmail.com');
});

test('a rejected Turnstile token stops the route before either rate limit', async () => {
  const order: string[] = [];
  const route = createResendVerificationRoute(
    routeDependencies({
      async verifyTurnstile() {
        order.push('turnstile');
        return 'rejected';
      },
      async consumeIpRateLimit() {
        order.push('ip');
        return 'ok';
      },
      sleep: async () => undefined,
    }),
  );

  const response = await route(
    routeContext(makeRequest('person@example.test')),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(order, ['turnstile']);
});

test('a Turnstile timeout uses the strict IP limit and flags a pending row without changing the response', async () => {
  let strict: boolean | undefined;
  const flagged: string[] = [];
  const route = createResendVerificationRoute(
    routeDependencies({
      verifyTurnstile: async () => 'unavailable',
      async consumeIpRateLimit(_ip, _now, strictLimit) {
        strict = strictLimit;
        return 'ok';
      },
      resendVerification: async () => ({ pendingSubscriberId: 'pending-id' }),
      async flagChallengeTimeout(subscriberId) {
        flagged.push(subscriberId);
      },
      sleep: async () => undefined,
    }),
  );

  const response = await route(
    routeContext(makeRequest('person@example.test')),
  );
  assert.equal(response.status, 200);
  assert.equal(strict, true);
  assert.deepEqual(flagged, ['pending-id']);
});

test('only a pending subscriber receives a newly queued verification token and mail', async () => {
  const fixture = await createDatabaseFixture();
  const resendVerification = createResendVerificationService(fixture.database);
  const pendingId = randomUUID();
  const verifiedId = randomUUID();
  const now = new Date('2026-09-09T12:00:00.000Z');

  try {
    await fixture.database.execute({
      text: `
        INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
        VALUES
          ($1, 'pending@example.test', 'pending@example.test', 'example.test', 'pending'),
          ($2, 'verified@example.test', 'verified@example.test', 'example.test', 'verified')
      `,
      values: [pendingId, verifiedId],
    });

    const pending = await resendVerification({
      email: 'pending@example.test',
      now,
      verificationUrl: (token) => `http://valstara.test/verify?token=${token}`,
    });
    const verified = await resendVerification({
      email: 'verified@example.test',
      now,
      verificationUrl: (token) => `http://valstara.test/verify?token=${token}`,
    });
    const unknown = await resendVerification({
      email: 'unknown@example.test',
      now,
      verificationUrl: (token) => `http://valstara.test/verify?token=${token}`,
    });

    assert.deepEqual(pending, { pendingSubscriberId: pendingId });
    assert.deepEqual(verified, { pendingSubscriberId: null });
    assert.deepEqual(unknown, { pendingSubscriberId: null });
    const tokenCount = await fixture.database.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM verification_token',
    });
    const emailCount = await fixture.database.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM email_send',
    });
    assert.equal(tokenCount?.count, '1');
    assert.equal(emailCount?.count, '1');
  } finally {
    await fixture.dispose();
  }
});
