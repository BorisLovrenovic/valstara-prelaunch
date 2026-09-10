import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  POST as signupPost,
  createSignupRoute,
  signupErrorCatalogue,
  type SignupRouteDependencies,
} from '../src/pages/api/signup.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { DatabaseUnavailableError } from '../src/server/db/errors.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import type { SignupOutcome } from '../src/server/subscriber/signup.ts';

const pendingSubscriber = {
  created: true,
  id: 'subscriber-id',
  status: 'pending',
} as const;

function makeRequest(
  fields: Record<string, string> = {
    country: 'GB',
    email: 'person@example.test',
    turnstile_token: 'valid-token',
  },
): Request {
  return new Request('http://valstara.test/api/signup', {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

function routeContext(request: Request, clientAddress = '203.0.113.10') {
  return { clientAddress, request } as never;
}

function deps(
  overrides: Partial<SignupRouteDependencies> = {},
): SignupRouteDependencies {
  return {
    isSignupEnabled: async () => true,
    verifyTurnstile: async () => 'verified',
    consumeIpRateLimit: async () => 'ok',
    signup: async (): Promise<SignupOutcome> => ({
      kind: 'created',
      subscriber: pendingSubscriber,
    }),
    flagChallengeTimeout: async () => undefined,
    ...overrides,
  };
}

// --- Order of operations ----------------------------------------------------

test('the route runs Turnstile, then the flag, rate limit, and signup module, in that order', async () => {
  const order: string[] = [];
  const route = createSignupRoute(
    deps({
      async isSignupEnabled() {
        order.push('flag');
        return true;
      },
      async verifyTurnstile() {
        order.push('turnstile');
        return 'verified';
      },
      async consumeIpRateLimit() {
        order.push('rate-limit');
        return 'ok';
      },
      async signup() {
        order.push('signup');
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );

  const response = await route(routeContext(makeRequest()));
  assert.equal(response.status, 200);
  assert.deepEqual(order, ['turnstile', 'flag', 'rate-limit', 'signup']);
});

test('a rejected Turnstile token stops the route before the rate limit or any work', async () => {
  const order: string[] = [];
  const route = createSignupRoute(
    deps({
      async verifyTurnstile() {
        order.push('turnstile');
        return 'rejected';
      },
      async consumeIpRateLimit() {
        order.push('rate-limit');
        return 'ok';
      },
      async signup() {
        order.push('signup');
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );

  const response = await route(
    routeContext(
      makeRequest({ country: 'GB', email: 'a@b.co', turnstile_token: 'nope' }),
    ),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'challenge_failed');
  assert.deepEqual(order, ['turnstile']);
});

// --- Provider timeout: accept, strict limits, flag the row -----------------

test('a Turnstile provider timeout accepts the signup, applies the strict limit, and flags the row', async () => {
  const order: string[] = [];
  const flagged: string[] = [];
  let strictArgument: boolean | undefined;
  const route = createSignupRoute(
    deps({
      async verifyTurnstile() {
        order.push('turnstile');
        return 'unavailable';
      },
      async consumeIpRateLimit(_ip, _now, strict) {
        order.push('rate-limit');
        strictArgument = strict;
        return 'ok';
      },
      async signup() {
        order.push('signup');
        return { kind: 'created', subscriber: pendingSubscriber };
      },
      async flagChallengeTimeout(subscriberId) {
        order.push('flag');
        flagged.push(subscriberId);
      },
    }),
  );

  const response = await route(routeContext(makeRequest()));
  // Accepted — a real person is never rejected because Cloudflare was slow.
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'pending');
  // The rate limit ran in strict mode, and the row was flagged after the upsert.
  assert.equal(strictArgument, true);
  assert.deepEqual(order, ['turnstile', 'rate-limit', 'signup', 'flag']);
  assert.deepEqual(flagged, [pendingSubscriber.id]);
});

test('the strict limit can still reject a timed-out request, and then nothing is signed up or flagged', async () => {
  let signupCalled = false;
  let flagCalled = false;
  const route = createSignupRoute(
    deps({
      verifyTurnstile: async () => 'unavailable',
      consumeIpRateLimit: async () => 'rate_limited',
      async signup() {
        signupCalled = true;
        return { kind: 'created', subscriber: pendingSubscriber };
      },
      async flagChallengeTimeout() {
        flagCalled = true;
      },
    }),
  );

  const response = await route(routeContext(makeRequest()));
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'rate_limited');
  assert.equal(signupCalled, false);
  assert.equal(flagCalled, false);
});

test('an already-verified repeat during a timeout is not flagged', async () => {
  let flagCalled = false;
  const route = createSignupRoute(
    deps({
      verifyTurnstile: async () => 'unavailable',
      signup: async () => ({
        kind: 'already_verified',
        subscriber: { created: false, id: 'verified-id', status: 'verified' },
      }),
      async flagChallengeTimeout() {
        flagCalled = true;
      },
    }),
  );

  const response = await route(routeContext(makeRequest()));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'pending');
  assert.equal(flagCalled, false);
});

test('a failed flag write never turns a committed signup into an error', async () => {
  const route = createSignupRoute(
    deps({
      verifyTurnstile: async () => 'unavailable',
      async flagChallengeTimeout() {
        throw new Error('flag store down');
      },
    }),
  );

  const response = await route(routeContext(makeRequest()));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'pending');
});

test('a confirmed challenge uses the normal limit and never flags', async () => {
  let strictArgument: boolean | undefined;
  let flagCalled = false;
  const route = createSignupRoute(
    deps({
      verifyTurnstile: async () => 'verified',
      async consumeIpRateLimit(_ip, _now, strict) {
        strictArgument = strict;
        return 'ok';
      },
      async flagChallengeTimeout() {
        flagCalled = true;
      },
    }),
  );

  const response = await route(routeContext(makeRequest()));
  assert.equal(response.status, 200);
  assert.equal(strictArgument, false);
  assert.equal(flagCalled, false);
});

test('the rate limit runs before validation — a rate-limited request with a bad body is rate_limited, not invalid_input', async () => {
  let signupCalled = false;
  const route = createSignupRoute(
    deps({
      async consumeIpRateLimit() {
        return 'rate_limited';
      },
      async signup() {
        signupCalled = true;
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );

  // A body missing its country would fail validation — but the rate limit is
  // checked first, so the honest 429 wins and no signup work happens.
  const response = await route(
    routeContext(
      makeRequest({
        email: 'no-country@example.test',
        turnstile_token: 'valid-token',
      }),
    ),
  );
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'rate_limited');
  assert.equal(signupCalled, false);
});

test('validation runs before the signup module — a missing country never reaches it', async () => {
  let signupCalled = false;
  const route = createSignupRoute(
    deps({
      async signup() {
        signupCalled = true;
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );

  const response = await route(
    routeContext(
      makeRequest({
        email: 'person@example.test',
        turnstile_token: 'valid-token',
      }),
    ),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_input');
  assert.equal(signupCalled, false);
});

// --- Flag off ---------------------------------------------------------------

test('with signup.enabled off the route verifies Turnstile first, returns an honest paused response, and does no database work', async () => {
  let turnstileCalled = false;
  let rateLimitCalled = false;
  let signupCalled = false;
  const route = createSignupRoute(
    deps({
      isSignupEnabled: async () => false,
      async verifyTurnstile() {
        turnstileCalled = true;
        return 'verified';
      },
      async consumeIpRateLimit() {
        rateLimitCalled = true;
        return 'ok';
      },
      async signup() {
        signupCalled = true;
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );

  const response = await route(routeContext(makeRequest()));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'paused');
  assert.equal(typeof body.message, 'string');
  assert.equal(turnstileCalled, true);
  assert.equal(rateLimitCalled, false);
  assert.equal(signupCalled, false);
});

// --- Error and success mapping, and the no-position rule --------------------

test('unknown, pending, and verified addresses receive an identical accepted response with no membership signal', async () => {
  const outcomes: SignupOutcome[] = [
    { kind: 'created', subscriber: pendingSubscriber },
    {
      kind: 'existing',
      subscriber: { created: false, id: 'pending-id', status: 'pending' },
    },
    {
      kind: 'already_verified',
      subscriber: { created: false, id: 'verified-id', status: 'verified' },
    },
  ];
  const responses = await Promise.all(
    outcomes.map((outcome) =>
      createSignupRoute(deps({ signup: async () => outcome }))(
        routeContext(makeRequest()),
      ),
    ),
  );
  const bodies = await Promise.all(
    responses.map((response) => response.json()),
  );

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const body of bodies) {
    assert.deepEqual(body, bodies[0]);
    assert.deepEqual(Object.keys(body).sort(), ['message', 'status']);
    assert.equal(body.status, 'pending');
    for (const forbidden of ['already_verified', 'position', 'count', 'rank']) {
      assert.equal(forbidden in body, false);
    }
  }
});

test('each error outcome maps to the documented code', async () => {
  const missingToken = await createSignupRoute(deps()).call(
    null,
    routeContext(makeRequest({ country: 'GB', email: 'a@b.co' })),
  );
  assert.equal(missingToken.status, 400);
  assert.equal((await missingToken.json()).error.code, 'challenge_failed');

  const invalidEmail = await createSignupRoute(
    deps({ signup: async () => ({ kind: 'invalid_email' }) }),
  )(routeContext(makeRequest()));
  assert.equal(invalidEmail.status, 400);
  assert.equal((await invalidEmail.json()).error.code, 'invalid_email');
});

test('a database outage maps to unavailable, and an unexpected error maps to internal', async () => {
  const rateLimitOutage = await createSignupRoute(
    deps({
      async consumeIpRateLimit() {
        throw new DatabaseUnavailableError(new Error('down'));
      },
    }),
  )(routeContext(makeRequest()));
  assert.equal(rateLimitOutage.status, 503);
  assert.equal((await rateLimitOutage.json()).error.code, 'unavailable');

  const signupOutage = await createSignupRoute(
    deps({
      async signup() {
        throw new DatabaseUnavailableError(new Error('down'));
      },
    }),
  )(routeContext(makeRequest()));
  assert.equal(signupOutage.status, 503);
  assert.equal((await signupOutage.json()).error.code, 'unavailable');

  const unexpected = await createSignupRoute(
    deps({
      async signup() {
        throw new Error('unexpected');
      },
    }),
  )(routeContext(makeRequest()));
  assert.equal(unexpected.status, 500);
  assert.equal((await unexpected.json()).error.code, 'internal');
});

// --- The closed code set ----------------------------------------------------

test('every code the route can return is in the documented closed set with the same status', () => {
  const doc = readFileSync(
    fileURLToPath(new URL('../docs/api/README.md', import.meta.url)),
    'utf8',
  );
  const documented = new Map<string, number>();
  for (const match of doc.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*(\d{3})\s*\|/gm)) {
    documented.set(match[1] as string, Number(match[2]));
  }

  // Sanity: the table was actually parsed.
  assert.ok(documented.size >= 10, 'the closed code set table did not parse');

  for (const [code, status] of Object.entries(signupErrorCatalogue)) {
    assert.equal(
      documented.get(code),
      status,
      `${code} must be documented at HTTP ${status}`,
    );
  }
  assert.equal(documented.has('already_verified'), false);
});

// --- Default wiring against a real database ---------------------------------

test('the default POST route verifies Turnstile server-side then sends, writing exactly one row', async () => {
  const databaseName = `valstara_e302route_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database: DatabasePool = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword:
      process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only',
    release: 'e3-02-route-test',
  });

  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.IP_PREFIX_PEPPER = 'route-test-pepper';
  process.env.TURNSTILE_SECRET_KEY = 'route-test-turnstile-secret';
  process.env.RESEND_API_KEY = 'route-test-resend-key';
  process.env.RESEND_TEST_RECIPIENT = 'delivered@resend.dev';
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push(url);
    if (url.includes('challenges.cloudflare.com')) {
      return Response.json({ success: true });
    }
    if (url === 'https://api.resend.com/emails') {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    const response = await signupPost(
      routeContext(
        makeRequest({
          country: 'GB',
          email: 'default-route@example.test',
          turnstile_token: 'token',
        }),
      ),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'pending');

    const count = await database.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM subscriber',
    });
    assert.equal(count?.count, '1');
    // Turnstile is verified before the mail is sent.
    assert.deepEqual(requests, [
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      'https://api.resend.com/emails',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of [
      'DATABASE_URL',
      'IP_PREFIX_PEPPER',
      'TURNSTILE_SECRET_KEY',
      'RESEND_API_KEY',
      'RESEND_TEST_RECIPIENT',
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
