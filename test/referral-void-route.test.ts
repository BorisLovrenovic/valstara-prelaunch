import assert from 'node:assert/strict';
import test from 'node:test';

import type { APIContext } from 'astro';

import { createUnvoidReferralRoute } from '../src/pages/api/admin/referrals/unvoid.ts';
import { createVoidReferralRoute } from '../src/pages/api/admin/referrals/void.ts';
import { adminCopy } from '../src/copy/admin.ts';
import { DatabaseUnavailableError } from '../src/server/db/errors.ts';
import {
  ReferralVoidInputError,
  ReferralVoidRefusedError,
  type ReferralVoidResult,
  type ReferralVoidService,
} from '../src/server/referral/void.ts';

const referredId = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';
const result: ReferralVoidResult = {
  edgeId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  referredId,
  referrerId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  state: 'confirmed',
  voided: true,
  voidedAt: new Date('2026-10-20T12:00:00.000Z'),
  voidReason: 'Bulk signups',
  voidedBy: 'admin.operator',
  referrerConfirmedReferrals: 2,
  giveawayEntry: 'voided',
};

function context(body: string, actor: string | null = 'admin.operator') {
  const request = new Request(
    'https://valstara.test/api/admin/referrals/void',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
  );
  return {
    locals: actor === null ? {} : { adminActor: actor },
    params: {},
    request,
    url: new URL(request.url),
  } as unknown as APIContext;
}

function service(
  outcome: ReferralVoidResult | Error,
  calls: unknown[][] = [],
): ReferralVoidService {
  const respond = async (...args: unknown[]) => {
    calls.push(args);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { voidReferral: respond, unvoidReferral: respond };
}

const body = JSON.stringify({
  subscriber_id: referredId,
  reason: 'Bulk signups',
});

test('the void route passes the authenticated actor and shapes the result', async () => {
  const calls: unknown[][] = [];
  const response = await createVoidReferralRoute(service(result, calls))(
    context(body),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [[referredId, 'Bulk signups', 'admin.operator']]);
  assert.deepEqual(await response.json(), {
    referral: {
      edge_id: result.edgeId,
      referred_id: referredId,
      referrer_id: result.referrerId,
      state: 'confirmed',
      voided: true,
      voided_at: '2026-10-20T12:00:00.000Z',
      void_reason: 'Bulk signups',
      voided_by: 'admin.operator',
    },
    referrer: { confirmed_referrals: 2 },
    giveaway_entry: 'voided',
  });
});

test('the routes refuse a malformed body, a missing reason and extra fields before calling the service', async () => {
  for (const malformed of [
    'not json',
    '[]',
    JSON.stringify({ subscriber_id: referredId }),
    JSON.stringify({ subscriber_id: referredId, reason: 3 }),
    JSON.stringify({ reason: 'Bulk signups' }),
    JSON.stringify({ subscriber_id: referredId, reason: 'x', actor: 'me' }),
  ]) {
    for (const route of [createVoidReferralRoute, createUnvoidReferralRoute]) {
      const calls: unknown[][] = [];
      const response = await route(service(result, calls))(context(malformed));
      assert.equal(response.status, 400, malformed);
      assert.deepEqual(await response.json(), {
        error: {
          code: 'invalid_input',
          message: adminCopy.referralVoidInvalid,
        },
      });
      assert.equal(calls.length, 0);
    }
  }
});

test('the routes map every service outcome to the closed code set, with no detail', async () => {
  const cases: readonly [Error, number, string, string][] = [
    [
      new ReferralVoidInputError('A reason is required.'),
      400,
      'invalid_input',
      adminCopy.referralVoidInvalid,
    ],
    [
      new ReferralVoidRefusedError('not_found'),
      400,
      'invalid_input',
      adminCopy.referralNotFound,
    ],
    [
      new ReferralVoidRefusedError('already_voided'),
      400,
      'invalid_input',
      adminCopy.referralAlreadyVoided,
    ],
    [
      new ReferralVoidRefusedError('not_voided'),
      400,
      'invalid_input',
      adminCopy.referralNotVoided,
    ],
    [
      new ReferralVoidRefusedError('not_changeable'),
      400,
      'invalid_input',
      adminCopy.referralNotChangeable,
    ],
    [
      new DatabaseUnavailableError(new Error('connect ECONNREFUSED 10.0.0.5')),
      503,
      'unavailable',
      adminCopy.referralVoidUnavailable,
    ],
    [
      new Error('duplicate key value violates "secret_internal_detail"'),
      500,
      'internal',
      adminCopy.referralVoidUnavailable,
    ],
  ];
  for (const [error, status, code, message] of cases) {
    const response = await createUnvoidReferralRoute(service(error))(
      context(body),
    );
    assert.equal(response.status, status, error.message);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: { code, message } });
    assert.equal(text.includes('10.0.0.5'), false);
    assert.equal(text.includes('secret_internal_detail'), false);
  }
});

test('a route reached without the authenticated actor fails closed', async () => {
  const calls: unknown[][] = [];
  await assert.rejects(
    async () =>
      createVoidReferralRoute(service(result, calls))(context(body, null)),
    /Authenticated admin actor is required/u,
  );
  assert.equal(calls.length, 0);
});
