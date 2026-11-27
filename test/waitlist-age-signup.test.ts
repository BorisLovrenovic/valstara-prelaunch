import assert from 'node:assert/strict';
import test from 'node:test';

import { marketingOptInWordingByVersion } from '../src/copy/marketing.ts';
import { signupCopy } from '../src/copy/signup.ts';
import { createSignupRoute } from '../src/pages/api/signup.ts';
import type { DatabasePool } from '../src/server/db/pool.ts';
import type { AgePolicy } from '../src/server/giveaway/age-policy.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';

import {
  ageFixture,
  insertMember,
  insertToken,
  signupTime,
  verifyTime,
  type AgeFixture,
} from './helpers/waitlist-age-fixture.ts';

// E11.8-06: the signup route and service with the 13+ form. The form's age
// policy is checked against the current one after Turnstile and the rate
// limit and before any signup effect (D-083); the 16+ marketing wording is a
// new version; the 18+ giveaway box is separate, unticked and not needed to
// join; and after rollback an 18+ form changes no pending consent on a row
// admitted at 13 (D-084 Q2).

function route(f: AgeFixture, policy: () => AgePolicy) {
  const signup = createSignupService(f.app, {
    clock: () => signupTime,
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    sendVerificationMail: async () => undefined,
  });
  return createSignupRoute({
    isSignupEnabled: async () => true,
    currentAgePolicy: async () => policy(),
    verifyTurnstile: async () => 'verified',
    consumeIpRateLimit: async () => 'ok',
    signup,
    flagChallengeTimeout: async () => undefined,
    ipPrefixPepper: 'e11-8-06-pepper',
    monotonicClock: () => 0,
    sleep: async () => undefined,
  });
}

async function post(
  handler: ReturnType<typeof route>,
  fields: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await handler({
    clientAddress: '203.0.113.10',
    request: new Request('https://valstara.test/api/signup', {
      method: 'POST',
      body: new URLSearchParams({ turnstile_token: 'ok', ...fields }),
    }),
  } as never);
  return { status: response.status, body: await response.json() };
}

async function row(owner: DatabasePool, email: string) {
  return owner.readOne<{
    id: string;
    status: string;
    admission_age_policy: string;
    giveaway_opt_in_source: string | null;
    marketing_opt_in_pending_version: string | null;
    marketing_consent_version: string | null;
    marketing_consent_source: string | null;
  }>({
    text: `SELECT id::text, status, admission_age_policy, giveaway_opt_in_source,
                  marketing_opt_in_pending_version, marketing_consent_version,
                  marketing_consent_source
           FROM subscriber WHERE email_normalised = $1`,
    values: [email],
  });
}

async function counts(owner: DatabasePool) {
  return owner.readOne<{ subscribers: string; sends: string; buckets: string }>(
    {
      text: `SELECT (SELECT count(*) FROM subscriber)::text AS subscribers,
                    (SELECT count(*) FROM email_send)::text AS sends,
                    (SELECT count(*) FROM rate_limit_bucket
                     WHERE key LIKE 'signup:verify:%')::text AS buckets`,
    },
  );
}

const accepted = {
  status: 200,
  body: { status: 'pending', message: signupCopy.pending },
};
const freshForm = {
  status: 400,
  body: { error: { code: 'invalid_input', message: signupCopy.formChanged } },
};
const invalidInput = {
  status: 400,
  body: { error: { code: 'invalid_input', message: signupCopy.invalidInput } },
};

test('a form rendered under the other age policy, in either direction, asks for the current form and changes nothing, whatever the address', async () => {
  const f = await ageFixture('e11-8-06-stale-form');
  try {
    let policy: AgePolicy = '18_plus';
    const handler = route(f, () => policy);
    // A pending row with a pending 18+ opt-in, and a verified member.
    assert.deepEqual(
      await post(handler, {
        email: 'pending@example.test',
        marketing_opt_in: 'v1',
      }),
      accepted,
    );
    await insertMember(f.owner, { status: 'verified' });
    const verified = await f.owner.readOne<{ email: string }>({
      text: `SELECT email FROM subscriber WHERE status = 'verified'`,
    });
    const before = await counts(f.owner);
    const pendingBefore = await row(f.owner, 'pending@example.test');

    // Rollout: the 18+ form, with both boxes unticked, after the flag is on.
    policy = '13_plus';
    for (const email of [
      'new@example.test',
      'pending@example.test',
      verified!.email,
    ]) {
      assert.deepEqual(await post(handler, { email }), freshForm, email);
    }
    // Rollback: the 13+ form, with both boxes unticked, after the flag is off.
    policy = '18_plus';
    for (const email of [
      'new@example.test',
      'pending@example.test',
      verified!.email,
    ]) {
      assert.deepEqual(
        await post(handler, { email, age_policy: '13_plus' }),
        freshForm,
        email,
      );
    }
    // No signup effect: no row, no mail, no send-window spend, no change.
    assert.deepEqual(await counts(f.owner), before);
    assert.equal(await row(f.owner, 'new@example.test'), null);
    assert.deepEqual(await row(f.owner, 'pending@example.test'), pendingBefore);
  } finally {
    await f.dispose();
  }
});

test('retained marketing versions stay accepted within their own age policy, and a version from the other policy is refused', async () => {
  const f = await ageFixture('e11-8-06-versions');
  try {
    let policy: AgePolicy = '18_plus';
    const handler = route(f, () => policy);
    assert.deepEqual(
      await post(handler, { email: 'v1@example.test', marketing_opt_in: 'v1' }),
      accepted,
    );
    assert.deepEqual(
      await post(handler, {
        email: 'v2-on-18@example.test',
        marketing_opt_in: 'v2',
      }),
      invalidInput,
    );
    assert.deepEqual(
      await post(handler, {
        email: 'box-on-18@example.test',
        giveaway_opt_in: 'yes',
      }),
      invalidInput,
    );
    policy = '13_plus';
    assert.deepEqual(
      await post(handler, {
        email: 'v2@example.test',
        marketing_opt_in: 'v2',
        age_policy: '13_plus',
      }),
      accepted,
    );
    assert.deepEqual(
      await post(handler, {
        email: 'v1-on-13@example.test',
        marketing_opt_in: 'v1',
        age_policy: '13_plus',
      }),
      invalidInput,
    );
    for (const [field, value] of [
      ['age_policy', '16_plus'],
      ['giveaway_opt_in', 'on'],
    ]) {
      assert.deepEqual(
        await post(handler, {
          email: 'malformed@example.test',
          age_policy: '13_plus',
          [field]: value,
        }),
        invalidInput,
        field,
      );
    }
    assert.equal(
      (await row(f.owner, 'v1@example.test'))?.marketing_opt_in_pending_version,
      'v1',
    );
    assert.equal(
      (await row(f.owner, 'v2@example.test'))?.marketing_opt_in_pending_version,
      'v2',
    );
    for (const email of [
      'v2-on-18@example.test',
      'box-on-18@example.test',
      'v1-on-13@example.test',
      'malformed@example.test',
    ])
      assert.equal(await row(f.owner, email), null, email);
    // The 16+ version is a recorded wording of its own.
    assert.match(marketingOptInWordingByVersion.v2, /16 or over/u);
    assert.notEqual(
      marketingOptInWordingByVersion.v2,
      marketingOptInWordingByVersion.v1,
    );
  } finally {
    await f.dispose();
  }
});

test('the two boxes are independent and neither is needed to join; the 16+ version becomes consent at verification', async () => {
  const f = await ageFixture('e11-8-06-boxes');
  try {
    const handler = route(f, () => '13_plus');
    const cases = [
      ['neither@example.test', {}],
      ['marketing@example.test', { marketing_opt_in: 'v2' }],
      ['giveaway@example.test', { giveaway_opt_in: 'yes' }],
      ['both@example.test', { marketing_opt_in: 'v2', giveaway_opt_in: 'yes' }],
    ] as const;
    for (const [email, boxes] of cases) {
      assert.deepEqual(
        await post(handler, { email, age_policy: '13_plus', ...boxes }),
        accepted,
        email,
      );
    }
    const rows = await Promise.all(
      cases.map(async ([email]) => [email, await row(f.owner, email)] as const),
    );
    for (const [email, record] of rows) {
      assert.equal(record?.status, 'pending', email);
      assert.equal(record?.admission_age_policy, '13_plus', email);
      assert.equal(
        record?.giveaway_opt_in_source,
        email.startsWith('giveaway') || email.startsWith('both')
          ? 'signup'
          : null,
        email,
      );
      assert.equal(
        record?.marketing_opt_in_pending_version,
        email.startsWith('marketing') || email.startsWith('both') ? 'v2' : null,
        email,
      );
    }
    // A later tick of the box on a pending row records it once.
    assert.deepEqual(
      await post(handler, {
        email: 'neither@example.test',
        age_policy: '13_plus',
        giveaway_opt_in: 'yes',
      }),
      accepted,
    );
    assert.equal(
      (await row(f.owner, 'neither@example.test'))?.giveaway_opt_in_source,
      'signup',
    );

    // Verification turns the 16+ opt-in into consent under version v2.
    const marketing = await row(f.owner, 'marketing@example.test');
    const token = await insertToken(f.owner, marketing!.id);
    const complete = createVerificationCompletionService(f.app, {
      clock: () => verifyTime,
    });
    assert.equal((await complete(token)).outcome, 'verified');
    const consented = await row(f.owner, 'marketing@example.test');
    assert.equal(consented?.marketing_consent_version, 'v2');
    assert.equal(consented?.marketing_consent_source, 'signup');
    const audit = await f.owner.readOne<{ detail: unknown }>({
      text: `SELECT detail FROM audit_log
             WHERE action = 'consent.marketing_granted' AND subject_id = $1`,
      values: [marketing!.id],
    });
    assert.deepEqual(audit?.detail, { source: 'signup', version: 'v2' });
  } finally {
    await f.dispose();
  }
});

test('after rollback, a fresh 18+ form leaves the pending consent of a row admitted at 13 unchanged, and its earlier 16+ opt-in is promoted as usual (D-084 Q2)', async () => {
  const f = await ageFixture('e11-8-06-pending-after-rollback');
  try {
    let policy: AgePolicy = '13_plus';
    const handler = route(f, () => policy);
    assert.deepEqual(
      await post(handler, {
        email: 'with@example.test',
        age_policy: '13_plus',
        marketing_opt_in: 'v2',
      }),
      accepted,
    );
    assert.deepEqual(
      await post(handler, {
        email: 'without@example.test',
        age_policy: '13_plus',
      }),
      accepted,
    );
    policy = '18_plus';
    const before = await counts(f.owner);
    for (const email of ['with@example.test', 'without@example.test']) {
      // The current 18+ form, with the 18+ marketing box ticked: the normal
      // response, and the verification mail as for any pending repeat.
      assert.deepEqual(
        await post(handler, { email, marketing_opt_in: 'v1' }),
        accepted,
        email,
      );
    }
    const after = await counts(f.owner);
    assert.equal(after?.subscribers, before?.subscribers);
    const withRow = await row(f.owner, 'with@example.test');
    const withoutRow = await row(f.owner, 'without@example.test');
    assert.equal(withRow?.marketing_opt_in_pending_version, 'v2');
    assert.equal(withoutRow?.marketing_opt_in_pending_version, null);
    assert.equal(withRow?.admission_age_policy, '13_plus');

    // The legacy flow is unchanged for an 18+ row: its opt-in is recorded,
    // and a repeat replaces it.
    assert.deepEqual(
      await post(handler, { email: 'legacy@example.test' }),
      accepted,
    );
    assert.deepEqual(
      await post(handler, {
        email: 'legacy@example.test',
        marketing_opt_in: 'v1',
      }),
      accepted,
    );
    assert.equal(
      (await row(f.owner, 'legacy@example.test'))
        ?.marketing_opt_in_pending_version,
      'v1',
    );
    assert.equal(
      (await row(f.owner, 'legacy@example.test'))?.admission_age_policy,
      '18_plus',
    );

    // Verification promotes the preserved 16+ opt-in; the other row has none.
    const complete = createVerificationCompletionService(f.app, {
      clock: () => verifyTime,
    });
    for (const record of [withRow, withoutRow]) {
      const token = await insertToken(f.owner, record!.id);
      assert.equal((await complete(token)).outcome, 'verified');
    }
    assert.equal(
      (await row(f.owner, 'with@example.test'))?.marketing_consent_version,
      'v2',
    );
    assert.equal(
      (await row(f.owner, 'without@example.test'))?.marketing_consent_version,
      null,
    );
  } finally {
    await f.dispose();
  }
});

test('flag off: a form without the age field joins under the 18+ policy exactly as before', async () => {
  const f = await ageFixture('e11-8-06-signup-flag-off');
  try {
    // No age-policy dependency at all: the flag's fail-safe default.
    const signup = createSignupService(f.app, {
      clock: () => signupTime,
      raiseFraudFlag: async () => undefined,
      screenEmailDomain: async () => ({ flags: [] }),
      sendVerificationMail: async () => undefined,
    });
    const handler = createSignupRoute({
      isSignupEnabled: async () => true,
      verifyTurnstile: async () => 'verified',
      consumeIpRateLimit: async () => 'ok',
      signup,
      flagChallengeTimeout: async () => undefined,
      ipPrefixPepper: 'e11-8-06-pepper',
      monotonicClock: () => 0,
      sleep: async () => undefined,
    });
    assert.deepEqual(
      await post(handler as never, {
        email: 'plain@example.test',
        marketing_opt_in: 'v1',
      }),
      accepted,
    );
    const record = await row(f.owner, 'plain@example.test');
    assert.equal(record?.admission_age_policy, '18_plus');
    assert.equal(record?.giveaway_opt_in_source, null);
    assert.equal(record?.marketing_opt_in_pending_version, 'v1');
    assert.deepEqual(
      await post(handler as never, {
        email: 'thirteen@example.test',
        age_policy: '13_plus',
      }),
      freshForm,
    );
  } finally {
    await f.dispose();
  }
});
