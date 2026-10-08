import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  marketingOptInCopy,
  marketingOptInWordingByVersion,
} from '../src/copy/marketing.ts';

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
    ipPrefixPepper: 'signup-route-test-pepper',
    verifyReferralCapture: () => null,
    monotonicClock: () => 500,
    sleep: async () => undefined,
    ...overrides,
  };
}

test('legacy location fields are ignored and marketing opt-in never changes the accepted response', async () => {
  const received: unknown[] = [];
  const route = createSignupRoute(
    deps({
      async signup(input) {
        received.push(input);
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );
  const ordinary = await route(routeContext(makeRequest()));
  const legacy = await route(
    routeContext(
      makeRequest({
        email: 'person@example.test',
        turnstile_token: 'valid-token',
        country: 'CA',
        region: 'QC',
        marketing_opt_in: marketingOptInCopy.version,
      }),
    ),
  );
  assert.equal(ordinary.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(await ordinary.json(), await legacy.json());
  assert.equal(
    (received[0] as { marketingOptInVersion: string | null })
      .marketingOptInVersion,
    null,
  );
  assert.equal(
    (received[1] as { marketingOptInVersion: string | null })
      .marketingOptInVersion,
    'v1',
  );
  assert.equal('country' in (received[1] as object), false);
  assert.equal('region' in (received[1] as object), false);
});

test('a form left open across a marketing copy version change keeps its shown version and accepted response', async () => {
  const received: Array<string | null> = [];
  const route = createSignupRoute(
    deps({
      async signup(input) {
        received.push(input.marketingOptInVersion ?? null);
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );
  const copy = marketingOptInCopy as { version: string; wording: string };
  const wordingByVersion = marketingOptInWordingByVersion as Record<
    string,
    string
  >;
  const originalVersion = copy.version;
  const originalWording = copy.wording;
  try {
    // A cached form still submits v1 after a deployment starts rendering v2.
    wordingByVersion.v2 = 'New marketing opt-in wording.';
    copy.version = 'v2';
    copy.wording = wordingByVersion.v2;
    const unticked = await route(routeContext(makeRequest()));
    const ticked = await route(
      routeContext(
        makeRequest({
          email: 'person@example.test',
          turnstile_token: 'valid-token',
          marketing_opt_in: originalVersion,
        }),
      ),
    );
    assert.equal(ticked.status, 200);
    const untickedBody = await unticked.json();
    assert.deepEqual(await ticked.json(), untickedBody);
    const current = await route(
      routeContext(
        makeRequest({
          email: 'person@example.test',
          turnstile_token: 'valid-token',
          marketing_opt_in: copy.version,
        }),
      ),
    );
    assert.equal(current.status, 200);
    assert.deepEqual(await current.json(), untickedBody);
    assert.deepEqual(received, [null, originalVersion, 'v2']);
  } finally {
    copy.version = originalVersion;
    copy.wording = originalWording;
    delete wordingByVersion.v2;
  }
});

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

test('each rejected signup emits its closed reason code once, while flag-off emits none', async () => {
  const cases: Array<{
    reason: keyof typeof signupErrorCatalogue;
    overrides: Partial<SignupRouteDependencies>;
    fields?: Record<string, string>;
  }> = [
    {
      reason: 'challenge_failed',
      overrides: { verifyTurnstile: async () => 'rejected' },
    },
    {
      reason: 'rate_limited',
      overrides: {
        consumeIpRateLimit: async () => ({ retryAfterSeconds: 600 }),
      },
    },
    {
      reason: 'invalid_input',
      overrides: {},
      fields: { turnstile_token: 'valid-token' },
    },
    {
      reason: 'invalid_email',
      overrides: { signup: async () => ({ kind: 'invalid_email' }) },
    },
    {
      reason: 'blocked_domain',
      overrides: { signup: async () => ({ kind: 'blocked_domain' }) },
    },
    {
      reason: 'unavailable',
      overrides: {
        isSignupEnabled: async () => {
          throw new DatabaseUnavailableError(new Error('down'));
        },
      },
    },
    {
      reason: 'unavailable',
      overrides: {
        signup: async () => {
          throw new DatabaseUnavailableError('offline');
        },
      },
    },
    {
      reason: 'internal',
      overrides: {
        signup: async () => {
          throw new Error('failure');
        },
      },
    },
  ];
  for (const { reason, overrides, fields } of cases) {
    const events: string[] = [];
    const route = createSignupRoute(
      deps({
        ...overrides,
        onRejected: (code) => events.push(code),
      }),
    );
    const response = await route(routeContext(makeRequest(fields)));
    assert.equal((await response.json()).error.code, reason);
    assert.deepEqual(events, [reason]);
  }
  const events: string[] = [];
  const paused = createSignupRoute(
    deps({
      isSignupEnabled: async () => false,
      onRejected: (reason) => events.push(reason),
    }),
  );
  assert.equal(
    (await (await paused(routeContext(makeRequest()))).json()).status,
    'paused',
  );
  assert.deepEqual(events, []);
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
      consumeIpRateLimit: async () => ({ retryAfterSeconds: 600 }),
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
  assert.equal(response.headers.get('Retry-After'), '600');
  assert.equal(
    (await response.clone().json()).error.message,
    'Too many attempts — try again in 10 minutes.',
  );
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
        return { retryAfterSeconds: 600 };
      },
      async signup() {
        signupCalled = true;
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );

  // The rate limit is checked before signup work, so the honest 429 wins.
  const response = await route(
    routeContext(
      makeRequest({
        email: 'limited@example.test',
        turnstile_token: 'valid-token',
      }),
    ),
  );
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'rate_limited');
  assert.equal(signupCalled, false);
});

test('validation runs before the signup module — a missing email never reaches it', async () => {
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
        turnstile_token: 'valid-token',
      }),
    ),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_input');
  assert.equal(signupCalled, false);
});

test('a bad referral field still signs up without attribution data', async () => {
  let receivedUtm: unknown = 'not-called';
  const route = createSignupRoute(
    deps({
      verifyReferralCapture: () => null,
      async signup(input) {
        receivedUtm = input.utm;
        return { kind: 'created', subscriber: pendingSubscriber };
      },
    }),
  );
  const response = await route(
    routeContext(
      makeRequest({
        email: 'person@example.test',
        referral_capture: 'tampered',
        turnstile_token: 'valid-token',
      }),
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(receivedUtm, null);
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

test('unknown, pending, and verified outcomes share the real 500ms response boundary', async () => {
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

  const elapsed = await Promise.all(
    outcomes.map(async (outcome, index) => {
      const route = createSignupRoute({
        ...deps(),
        monotonicClock: undefined,
        sleep: undefined,
        async signup() {
          await new Promise((resolve) => setTimeout(resolve, index * 30));
          return outcome;
        },
      });
      const started = performance.now();
      const response = await route(routeContext(makeRequest()));
      assert.equal(response.status, 200);
      return performance.now() - started;
    }),
  );

  for (const duration of elapsed) {
    assert.ok(
      duration >= 475,
      `response returned before its boundary: ${duration}`,
    );
  }
  assert.ok(Math.max(...elapsed) - Math.min(...elapsed) < 75);
});

test('each error outcome maps to the documented code', async () => {
  const missingToken = await createSignupRoute(deps()).call(
    null,
    routeContext(makeRequest({ country: 'GB', email: 'a@b.co' })),
  );
  assert.equal(missingToken.status, 400);
  assert.equal((await missingToken.json()).error.code, 'challenge_failed');

  let emptyTokenVerified = false;
  const emptyToken = await createSignupRoute(
    deps({
      async verifyTurnstile() {
        emptyTokenVerified = true;
        return 'verified';
      },
    }),
  )(
    routeContext(
      makeRequest({ country: 'GB', email: 'a@b.co', turnstile_token: '' }),
    ),
  );
  assert.equal(emptyToken.status, 400);
  assert.equal((await emptyToken.json()).error.code, 'challenge_failed');
  assert.equal(emptyTokenVerified, false);

  const invalidEmail = await createSignupRoute(
    deps({ signup: async () => ({ kind: 'invalid_email' }) }),
  )(routeContext(makeRequest()));
  assert.equal(invalidEmail.status, 400);
  assert.equal((await invalidEmail.json()).error.code, 'invalid_email');

  const blockedDomain = await createSignupRoute(
    deps({ signup: async () => ({ kind: 'blocked_domain' }) }),
  )(routeContext(makeRequest()));
  assert.equal(blockedDomain.status, 400);
  assert.deepEqual(await blockedDomain.json(), {
    error: {
      code: 'blocked_domain',
      message: 'Use a permanent email address to join the waitlist.',
    },
  });
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

test('the default POST route verifies Turnstile and queues one mail without a direct provider send', async () => {
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
  process.env.ADMIN_CREDENTIAL = 'signup-route-admin-credential-32-chars';
  process.env.ADMIN_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.IP_PREFIX_PEPPER = 'route-test-pepper';
  process.env.REFERRAL_SIGNING_SECRET = 'route-test-referral-signing-secret';
  process.env.TURNSTILE_SECRET_KEY = 'route-test-turnstile-secret';
  process.env.RESEND_API_KEY = 'route-test-resend-key';
  process.env.RESEND_DKIM_EXPECTED_VALUE = 'p=test-public-key';
  process.env.RESEND_KEY_MODE = 'test';
  process.env.RESEND_RSEND_CNAME_EXPECTED_TARGET = 'rsend-euw1.forge.rmta.net';
  process.env.RESEND_SEND_CNAME_EXPECTED_TARGET = 'send.forge.rmta.net';
  process.env.RESEND_SENDING_DOMAIN = 'send.valstara.com';
  const requests: string[] = [];
  const analyticsPayloads: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push(url);
    if (url.includes('challenges.cloudflare.com')) {
      return Response.json({ success: true });
    }
    if (url === 'http://umami:3000/api/send') {
      analyticsPayloads.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    const response = await signupPost(
      routeContext(
        makeRequest({
          email: 'default-route@gmail.com',
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
    const queued = await database.readOne<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM email_send WHERE state = 'queued'",
    });
    assert.equal(queued?.count, '1');
    assert.deepEqual(requests, [
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      'http://umami:3000/api/send',
    ]);
    assert.deepEqual(analyticsPayloads, [
      {
        type: 'event',
        payload: {
          website: 'a4041033-3269-4a73-8772-c16f9bdf1a33',
          hostname: 'valstara.com',
          url: '/',
          name: 'signup_submitted',
          data: {
            source_bucket: 'direct',
            had_ref: false,
            marketing_opt_in: false,
          },
        },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of [
      'ADMIN_CREDENTIAL',
      'ADMIN_TOTP_SECRET',
      'DATABASE_URL',
      'IP_PREFIX_PEPPER',
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
