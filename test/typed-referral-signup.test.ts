import assert from 'node:assert/strict';
import test from 'node:test';

import { signupCopy } from '../src/copy/signup.ts';
import { createSignupRoute } from '../src/pages/api/signup.ts';
import { createCampaignFlagRepository } from '../src/server/db/campaign-flags.ts';
import { createPartnerAttributionRepository } from '../src/server/db/partner-attribution.ts';
import { createTransactionalTemplateData } from '../src/server/email/transactional-template-data.ts';
import { createTransactionalRenderers } from '../src/server/email/transactional-templates.ts';
import {
  createReferralCaptureService,
  referralCaptureTtlMs,
} from '../src/server/referral/capture.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createReferralVoidService } from '../src/server/referral/void.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { startAppServer } from './helpers/listen-port.mjs';
import {
  createPartnerFixture,
  insertMember,
  insertPartner,
} from './helpers/partner-review-fixture.ts';

const clock = () => new Date('2090-11-23T10:00:00Z');
const referralSecret = 'typed-referral-test-secret';
const actor = 'founder:typed-referral-test';
const expectedLine =
  'You joined through MAYA: early access from September 2027 and 15% off your first order.';

test('signup resolves signed and typed codes, preserves a single immutable edge, and confirms only the fixed partner perks', async (t) => {
  const fixture = await createPartnerFixture('typed-referral-signup');
  const resources: { app?: Awaited<ReturnType<typeof startAppServer>> } = {};
  t.after(async () => {
    try {
      await resources.app?.stop();
    } finally {
      await fixture.dispose();
    }
  });
  const flags = createCampaignFlagRepository(fixture.app);
  await flags.set('partners.enabled', true, actor);
  const plainMember = await insertMember(fixture);
  const referrals = createReferralService(fixture.app);
  const memberCode = await referrals.getReferralCode(plainMember.id);
  assert.ok(memberCode);
  const partner = await insertPartner(fixture, {
    status: 'active',
    code: 'MAYA',
    partnerType: 'student_ambassador',
  });
  await createPartnerAttributionRepository(fixture.app).setCodeActive(
    partner.id,
    true,
  );
  await insertPartner(fixture, { status: 'paused', code: 'PARKED' });

  const capture = createReferralCaptureService(referralSecret, { clock });
  const signed = (ref: string) =>
    capture.signRef({ ref, utm: { medium: 'social' } });
  const expired = createReferralCaptureService(referralSecret, {
    clock: () => new Date(clock().getTime() - referralCaptureTtlMs - 1),
  }).signRef({ ref: 'MAYA', utm: null });
  const tampered = signed('MAYA').replace(/\..+$/u, '.broken');
  const verificationUrls = new Map<string, string>();
  const signup = createSignupService(fixture.app, {
    clock,
    attributeReferral: (id, code, allow, method) =>
      referrals.attribute(id, code, allow, method),
    isReferralEnabled: async () =>
      (await flags.list(['referral.enabled']))[0]?.enabled ?? true,
    screenEmailDomain: async () => ({ flags: [] }),
    raiseFraudFlag: async () => undefined,
    sendVerificationMail: async ({ businessKey, verificationUrl }) => {
      const subscriberId = businessKey.split(':')[1];
      assert.ok(subscriberId);
      verificationUrls.set(subscriberId, verificationUrl);
    },
  });
  const route = createSignupRoute({
    isSignupEnabled: async () => true,
    verifyTurnstile: async () => 'verified',
    consumeIpRateLimit: async () => 'ok',
    signup,
    verifyReferralCapture: capture.verifyRef,
    flagChallengeTimeout: async () => undefined,
    ipPrefixPepper: 'typed-referral-test-prefix',
    clock,
    monotonicClock: () => 500,
    sleep: async () => undefined,
  });

  async function submit(label: string, fields: Record<string, string>) {
    const request = new Request('http://valstara.test/api/signup', {
      method: 'POST',
      body: new URLSearchParams({
        email: `${label}@example.test`,
        turnstile_token: 'verified-in-the-test',
        ...fields,
      }),
    });
    const response = await route({
      request,
      clientAddress: '203.0.113.42',
    } as never);
    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get('set-cookie'), null, label);
    return response.json();
  }

  async function state(label: string) {
    const subscriber = await fixture.owner.readOne<{
      id: string;
      status: string;
      referred_by_id: string | null;
      signup_had_ref: boolean;
      utm: { medium: string } | null;
    }>({
      text: 'SELECT id, status, referred_by_id, signup_had_ref, utm FROM subscriber WHERE email_normalised = $1',
      values: [`${label}@example.test`],
    });
    assert.ok(subscriber, label);
    const edge = await fixture.owner.readOne<{
      state: string;
      referrer_id: string;
      attribution_method: string;
      partner_id: string | null;
      welcome_discount_pct: number | null;
    }>({
      text: `SELECT state, referrer_id, attribution_method, partner_id, welcome_discount_pct
             FROM referral_edge WHERE referred_id = $1`,
      values: [subscriber.id],
    });
    return { subscriber, edge };
  }

  const normal = { status: 'pending', message: signupCopy.pending };
  const unavailable = { ...normal, message: signupCopy.referralUnavailable };
  const typed = {
    referral_capture: signed(memberCode),
    referral_prefill: memberCode,
    referral_code: ' maya ',
  };
  assert.deepEqual(
    await Promise.all([
      submit('typed-partner', typed),
      submit('typed-partner', typed),
    ]),
    [normal, normal],
  );
  const friend = await state('typed-partner');
  assert.equal(friend.subscriber.referred_by_id, partner.subscriberId);
  assert.deepEqual(friend.subscriber.utm, { medium: 'social' });
  assert.equal(friend.subscriber.signup_had_ref, true);
  assert.deepEqual(friend.edge, {
    state: 'attributed',
    referrer_id: partner.subscriberId,
    attribution_method: 'code',
    partner_id: partner.id,
    welcome_discount_pct: 15,
  });
  const counts = await fixture.owner.readOne({
    text: `SELECT (SELECT count(*)::int FROM referral_edge WHERE referred_id = $1) AS edges,
      (SELECT count(*)::int FROM email_send WHERE subscriber_id = $1 AND template = 'verification_test') AS emails`,
    values: [friend.subscriber.id],
  });
  assert.deepEqual(counts, { edges: 1, emails: 1 });
  assert.deepEqual(
    await submit('typed-partner', {
      referral_prefill: '',
      referral_code: memberCode,
    }),
    normal,
  );
  assert.deepEqual(await state('typed-partner'), friend);
  await assert.rejects(
    fixture.owner.execute({
      text: 'UPDATE subscriber SET referred_by_id = $2 WHERE id = $1',
      values: [friend.subscriber.id, plainMember.id],
    }),
    /referred_by_id is write-once/u,
  );

  assert.deepEqual(
    await submit('typed-member', {
      referral_capture: signed('MAYA'),
      referral_prefill: 'MAYA',
      referral_code: memberCode,
    }),
    normal,
  );
  const plain = await state('typed-member');
  assert.equal(plain.subscriber.referred_by_id, plainMember.id);
  assert.deepEqual(plain.edge, {
    state: 'attributed',
    referrer_id: plainMember.id,
    attribution_method: 'code',
    partner_id: null,
    welcome_discount_pct: null,
  });

  for (const [label, fields, responseBody] of [
    [
      'unknown',
      { referral_capture: signed('MAYA'), referral_code: 'UNKNOWN' },
      unavailable,
    ],
    [
      'inactive',
      { referral_capture: signed('MAYA'), referral_code: 'PARKED' },
      unavailable,
    ],
    [
      'malformed',
      { referral_capture: signed('MAYA'), referral_code: 'BAD\u0000CODE' },
      unavailable,
    ],
    ['expired', { referral_capture: expired, referral_code: 'MAYA' }, normal],
    ['tampered', { referral_capture: tampered, referral_code: 'MAYA' }, normal],
    ['missing', { referral_code: 'MAYA' }, normal],
    [
      'cleared',
      { referral_capture: signed('MAYA'), referral_code: '' },
      normal,
    ],
  ] as const) {
    assert.deepEqual(
      await submit(label, { referral_prefill: 'MAYA', ...fields }),
      responseBody,
    );
    const unattributed = await state(label);
    assert.equal(unattributed.subscriber.status, 'pending');
    assert.equal(unattributed.subscriber.referred_by_id, null);
    assert.equal(unattributed.edge, null);
    assert.ok(verificationUrls.has(unattributed.subscriber.id), label);
  }

  assert.deepEqual(
    await submit('untouched', {
      referral_capture: signed('MAYA'),
      referral_prefill: 'MAYA',
      referral_code: 'MAYA',
    }),
    normal,
  );
  const untouched = await state('untouched');
  assert.equal(untouched.subscriber.referred_by_id, partner.subscriberId);
  assert.equal(untouched.edge?.attribution_method, 'link');
  assert.equal(untouched.edge?.welcome_discount_pct, 15);
  assert.deepEqual(
    await submit('standalone', {
      referral_prefill: '',
      referral_code: 'MAYA',
    }),
    normal,
  );
  assert.equal((await state('standalone')).edge?.attribution_method, 'code');

  await flags.set('referral.enabled', false, actor);
  assert.deepEqual(await submit('disabled', typed), normal);
  assert.equal((await state('disabled')).edge, null);
  await flags.set('referral.enabled', true, actor);

  // Raise the partner's current count to the 20% band after signup. The
  // confirmation must read the stored 15%, even after the count changes.
  await fixture.owner.execute({
    text: `INSERT INTO referral_edge (id, referrer_id, state, reward_state, confirmed_at)
      SELECT gen_random_uuid(), $1, 'confirmed', 'settled', $2 FROM generate_series(1, 39)`,
    values: [partner.subscriberId, clock()],
  });
  await ensureAppBuild();
  const startVerification = () =>
    startAppServer({
      label: 'Partner perk verification',
      readyPath: '/verify',
      env: () => ({
        DATABASE_URL: fixture.appDatabaseUrl,
        HOST: '127.0.0.1',
        REFERRAL_SIGNING_SECRET: referralSecret,
        IP_PREFIX_PEPPER: 'typed-referral-test-prefix',
        ADMIN_CREDENTIAL: 'typed-referral-admin-credential-32',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        RESEND_API_KEY: 'typed-referral-test-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: 'typed-referral-test-turnstile-key',
      }),
    });
  resources.app = await startVerification();
  async function verify(id: string) {
    const verificationUrl = verificationUrls.get(id);
    assert.ok(verificationUrl);
    const url = new URL(verificationUrl);
    const token = url.searchParams.get('token');
    assert.ok(token);
    assert.ok(resources.app);
    const origin = `http://127.0.0.1:${resources.app.port}`;
    const response = await fetch(`${origin}/verify`, {
      method: 'POST',
      headers: { Origin: origin },
      body: new URLSearchParams({ token }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const html = await response.text();
    assert.match(html, /data-access-wave/u);
    return html;
  }

  async function welcome(id: string) {
    const row = await fixture.owner.readOne<{
      payload: Record<string, unknown>;
      email: string;
    }>({
      text: `SELECT payload, email FROM email_send JOIN subscriber ON subscriber.id = subscriber_id
        WHERE business_key = $1 AND template = 'welcome'`,
      values: [`welcome:${id}`],
    });
    assert.ok(row);
    const template = createTransactionalRenderers({
      baseUrl: 'https://valstara.com',
      sendingDomain: 'send.valstara.com',
      data: createTransactionalTemplateData(fixture.app),
    }).get('welcome');
    assert.ok(template);
    const rendered = await template.render({
      email: row.email,
      payload: row.payload,
      token: async () => 'test-status-token',
      unsubscribePageUrl: 'https://valstara.com/unsubscribe?token=test',
    });
    assert.ok(rendered.html);
    return { ...rendered, html: rendered.html };
  }

  const perkText = (html: string) =>
    html
      .match(/<p[^>]*data-partner-welcome[^>]*>(.*?)<\/p>/su)?.[1]
      ?.replace(/<[^>]+>/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
  const friendId = friend.subscriber.id;
  assert.equal(perkText(await verify(friendId)), expectedLine);
  assert.equal(perkText(await verify(friendId)), expectedLine, 'replay');
  assert.equal((await state('typed-partner')).edge?.state, 'confirmed');
  const mail = await welcome(friendId);
  assert.ok(mail.html.includes(expectedLine));
  assert.ok(mail.text.includes(expectedLine));

  for (const id of [
    plain.subscriber.id,
    (await state('unknown')).subscriber.id,
    (await state('inactive')).subscriber.id,
  ]) {
    assert.equal(perkText(await verify(id)), undefined);
    const other = await welcome(id);
    assert.doesNotMatch(other.text, /You joined through|off your first order/u);
    assert.doesNotMatch(other.html, /You joined through|off your first order/u);
  }
  assert.deepEqual(
    await submit('typed-partner', {
      referral_capture: signed('MAYA'),
      referral_prefill: 'MAYA',
      referral_code: 'UNKNOWN',
    }),
    unavailable,
    'the note is identical for an already verified address',
  );

  const voids = createReferralVoidService(fixture.app, clock);
  await voids.voidReferral(friendId, 'Reconcile test referral', actor);
  assert.equal(perkText(await verify(friendId)), undefined);
  assert.doesNotMatch((await welcome(friendId)).text, /You joined through/u);
  await voids.unvoidReferral(friendId, 'Restore test referral', actor);
  assert.equal(perkText(await verify(friendId)), expectedLine);

  await flags.set('referral.enabled', false, actor);
  assert.doesNotMatch((await welcome(friendId)).text, /You joined through/u);
  await resources.app.stop();
  resources.app = await startVerification();
  assert.equal(perkText(await verify(friendId)), undefined);
});
