import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createTurnstileUnavailableReporter,
  createTurnstileVerifier,
  type TurnstileOutcome,
} from '../src/server/turnstile/verify.ts';

const secret = 'super-secret-turnstile-key-DO-NOT-LEAK';

/** A fetch stub that returns a fixed siteverify body, recording the request. */
function fetchReturning(
  body: unknown,
  init: ResponseInit = { status: 200 },
): { fetch: typeof fetch; calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, options?: RequestInit) => {
    calls.push(new URLSearchParams((options?.body as URLSearchParams) ?? ''));
    return typeof body === 'string'
      ? new Response(body, init)
      : Response.json(body, init);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

async function outcomeFor(
  body: unknown,
  init?: ResponseInit,
): Promise<TurnstileOutcome> {
  const { fetch } = fetchReturning(body, init);
  return createTurnstileVerifier({ fetch, secret }).verify('a-token');
}

// --- The invalid vs unreachable distinction (the whole design) --------------

test('a confirmed token verifies', async () => {
  assert.equal(await outcomeFor({ success: true }), 'verified');
});

test('an invalid token is rejected — the provider blamed the token', async () => {
  assert.equal(
    await outcomeFor({
      success: false,
      'error-codes': ['invalid-input-response'],
    }),
    'rejected',
  );
});

test('a replayed (already-redeemed) token is rejected', async () => {
  // `timeout-or-duplicate` is Cloudflare's code for a token redeemed twice.
  assert.equal(
    await outcomeFor({
      success: false,
      'error-codes': ['timeout-or-duplicate'],
    }),
    'rejected',
  );
});

test('an empty token is rejected without calling the provider', async () => {
  const { calls, fetch } = fetchReturning({ success: true });
  const outcome = await createTurnstileVerifier({ fetch, secret }).verify('');
  assert.equal(outcome, 'rejected');
  assert.equal(calls.length, 0);
});

test('a network error is unavailable, not a rejection — accept-and-flag, never reject a real person', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNRESET');
  }) as typeof fetch;
  assert.equal(
    await createTurnstileVerifier({ fetch: fetchImpl, secret }).verify('t'),
    'unavailable',
  );
});

test('an aborted (timed-out) request is unavailable', async () => {
  const fetchImpl = (async (_url: RequestInfo | URL, options?: RequestInit) => {
    // Mimic AbortSignal.timeout firing: fetch rejects with an abort error.
    options?.signal?.throwIfAborted();
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }) as typeof fetch;
  assert.equal(
    await createTurnstileVerifier({
      fetch: fetchImpl,
      secret,
      timeoutMs: 5,
    }).verify('t'),
    'unavailable',
  );
});

test('a non-2xx provider response is unavailable, not a rejection', async () => {
  assert.equal(await outcomeFor({}, { status: 502 }), 'unavailable');
});

test('a malformed (non-JSON) body is unavailable', async () => {
  assert.equal(await outcomeFor('<html>gateway error</html>'), 'unavailable');
});

test('a body with no boolean success is unavailable', async () => {
  assert.equal(await outcomeFor({ success: 'yes' }), 'unavailable');
});

test('a failure the provider blames on the secret is unavailable, not a rejection', async () => {
  // A misconfigured or missing secret is our problem, not the visitor's — do
  // not reject every real person; accept-and-flag under strict limits instead.
  assert.equal(
    await outcomeFor({
      success: false,
      'error-codes': ['invalid-input-secret'],
    }),
    'unavailable',
  );
});

for (const code of ['missing-input-secret', 'invalid-input-secret']) {
  test(`${code} remains unavailable and raises a sanitized, deduplicated P1`, async () => {
    const alerts: unknown[] = [];
    const reporter = createTurnstileUnavailableReporter(
      {
        send: async (alert) => {
          alerts.push(alert);
        },
      },
      () => new Date('2026-10-08T12:00:00.000Z'),
    );
    const { fetch } = fetchReturning({ success: false, 'error-codes': [code] });
    const verifier = createTurnstileVerifier({
      fetch,
      secret,
      onUnavailable: reporter.report,
    });
    assert.deepEqual(
      await Promise.all([verifier.verify('one'), verifier.verify('two')]),
      ['unavailable', 'unavailable'],
    );
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0], {
      detail: { reason: 'secret_configuration' },
      event: 'turnstile_unavailable',
      occurredAt: new Date('2026-10-08T12:00:00.000Z'),
      severity: 'P1',
    });
  });
}

test('a provider timeout remains unavailable and raises P2', async () => {
  const alerts: unknown[] = [];
  const reporter = createTurnstileUnavailableReporter(
    {
      send: async (alert) => {
        alerts.push(alert);
      },
    },
    () => new Date('2026-10-08T12:00:00.000Z'),
  );
  const fetchImpl = (async () => {
    throw new Error('timeout');
  }) as typeof fetch;
  const result = await createTurnstileVerifier({
    fetch: fetchImpl,
    secret,
    onUnavailable: reporter.report,
  }).verify('a-token');
  assert.equal(result, 'unavailable');
  assert.deepEqual(alerts, [
    {
      detail: { reason: 'provider_unavailable' },
      event: 'turnstile_unavailable',
      occurredAt: new Date('2026-10-08T12:00:00.000Z'),
      severity: 'P2',
    },
  ]);
});

test('success:false with no error codes is unavailable — the failure cannot be blamed on the token', async () => {
  assert.equal(await outcomeFor({ success: false }), 'unavailable');
});

test('a mixed error set including a non-token code is unavailable', async () => {
  assert.equal(
    await outcomeFor({
      success: false,
      'error-codes': ['timeout-or-duplicate', 'internal-error'],
    }),
    'unavailable',
  );
});

// --- The secret and the request shape ---------------------------------------

test('the secret and the token are sent to the provider; the client IP is only sent when given', async () => {
  const withoutIp = fetchReturning({ success: true });
  await createTurnstileVerifier({ fetch: withoutIp.fetch, secret }).verify(
    'tok',
  );
  assert.equal(withoutIp.calls[0]?.get('secret'), secret);
  assert.equal(withoutIp.calls[0]?.get('response'), 'tok');
  assert.equal(withoutIp.calls[0]?.has('remoteip'), false);

  const withIp = fetchReturning({ success: true });
  await createTurnstileVerifier({ fetch: withIp.fetch, secret }).verify(
    'tok',
    '203.0.113.9',
  );
  assert.equal(withIp.calls[0]?.get('remoteip'), '203.0.113.9');
});

test('the secret appears in no log line across every path', async () => {
  const logged: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
  }

  try {
    const throwing = (async () => {
      throw new Error(`boom while holding ${secret}`);
    }) as typeof fetch;
    await createTurnstileVerifier({ fetch: throwing, secret }).verify('t');
    await outcomeFor({ success: true });
    await outcomeFor({
      success: false,
      'error-codes': ['invalid-input-response'],
    });
    await outcomeFor({}, { status: 500 });
    await outcomeFor('not json');
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index] as typeof console.log;
    });
  }

  for (const line of logged) {
    assert.ok(!line.includes(secret), `a log line leaked the secret: ${line}`);
  }
});

// --- No client code contains the secret -------------------------------------

test('the Turnstile secret is referenced only under src/server, never in a client-reachable file', () => {
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
  const needles = ['turnstileSecretKey', 'TURNSTILE_SECRET_KEY'];
  const offenders: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = `${directory}/${entry}`;
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const contents = readFileSync(path, 'utf8');
      if (!needles.some((needle) => contents.includes(needle))) {
        continue;
      }
      const relative = path.slice(sourceRoot.length + 1);
      if (!relative.startsWith('server/')) {
        offenders.push(relative);
      }
    }
  };

  walk(sourceRoot);
  assert.deepEqual(
    offenders,
    [],
    `the secret must be server-only, but was referenced in: ${offenders.join(', ')}`,
  );
});
