import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSignupRoute,
  type SignupRouteDependencies,
} from '../src/pages/api/signup.ts';
import type {
  SignupInput,
  SignupOutcome,
} from '../src/server/subscriber/signup.ts';

const pendingSubscriber = {
  created: true,
  id: 'subscriber-id',
  status: 'pending',
} as const;

function makeRequest(
  fields: Record<string, string>,
  cfIpCountry?: string,
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (cfIpCountry !== undefined) {
    headers['CF-IPCountry'] = cfIpCountry;
  }
  return new Request('http://valstara.test/api/signup', {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers,
  });
}

function routeContext(request: Request) {
  return { clientAddress: '203.0.113.10', request } as never;
}

/** A route whose `signup` dependency records the input it was handed. */
function routeCapturing(captured: { input?: SignupInput }) {
  const deps: SignupRouteDependencies = {
    isSignupEnabled: async () => true,
    verifyTurnstile: async () => 'verified',
    consumeIpRateLimit: async () => 'ok',
    async signup(input): Promise<SignupOutcome> {
      captured.input = input;
      return { kind: 'created', subscriber: pendingSubscriber };
    },
    flagChallengeTimeout: async () => undefined,
  };
  return createSignupRoute(deps);
}

// --- Region is required for Canada, and only for Canada --------------------

test('a Canadian signup with no region is rejected as invalid_input, before the signup module', async () => {
  const captured: { input?: SignupInput } = {};
  const response = await routeCapturing(captured)(
    routeContext(
      makeRequest({
        country: 'CA',
        email: 'person@example.test',
        turnstile_token: 'valid-token',
      }),
    ),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_input');
  // The incomplete Canadian signup never reaches the module — nothing is written.
  assert.equal(captured.input, undefined);
});

test('a Canadian signup with an empty region string is rejected too', async () => {
  const captured: { input?: SignupInput } = {};
  const response = await routeCapturing(captured)(
    routeContext(
      makeRequest({
        country: 'CA',
        email: 'person@example.test',
        region: '   ',
        turnstile_token: 'valid-token',
      }),
    ),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_input');
  assert.equal(captured.input, undefined);
});

test('a Canadian signup with a region is accepted and the region reaches the module', async () => {
  const captured: { input?: SignupInput } = {};
  const response = await routeCapturing(captured)(
    routeContext(
      makeRequest({
        country: 'CA',
        email: 'person@example.test',
        region: 'QC',
        turnstile_token: 'valid-token',
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(captured.input?.country, 'CA');
  assert.equal(captured.input?.region, 'QC');
});

test('a non-Canadian signup needs no region', async () => {
  const captured: { input?: SignupInput } = {};
  const response = await routeCapturing(captured)(
    routeContext(
      makeRequest({
        country: 'US',
        email: 'person@example.test',
        turnstile_token: 'valid-token',
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(captured.input?.country, 'US');
  assert.equal(captured.input?.region, undefined);
});

// --- The confirmed value wins over detection -------------------------------

test('the submitted country is stored, never the detected one — a CF-IPCountry header cannot override it', async () => {
  const captured: { input?: SignupInput } = {};
  // The request advertises France by header, but the person confirmed Germany.
  // The confirmed value is the one that must reach the module (silent detection
  // overriding a person's answer is the failure this guards).
  const response = await routeCapturing(captured)(
    routeContext(
      makeRequest(
        {
          country: 'DE',
          email: 'person@example.test',
          turnstile_token: 'valid-token',
        },
        'FR',
      ),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(captured.input?.country, 'DE');
});
