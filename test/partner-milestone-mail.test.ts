// E11.7-12: the auto-invite and the partner's first-signup email, against a
// real database. Asserts the consent gate (at queueing and at dispatch), the
// threshold, one email per business key across retries, concurrent runs and a
// void that drops a member below the threshold and back, suppression before
// queueing and at dispatch, both flags, the batch cap, and both rendered
// messages through the email service.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { emailCopy } from '../src/copy/email.ts';
import { partnersCopy } from '../src/copy/partners.ts';
import { createCampaignFlagRepository } from '../src/server/db/campaign-flags.ts';
import { createPartnerWelcomeRepository } from '../src/server/db/partner-welcome.ts';
import { createReferralCouponRepository } from '../src/server/db/referral-coupon.ts';
import {
  createEmailService,
  type EmailProvider,
  type Message,
} from '../src/server/email/service.ts';
import {
  partnerFirstSignupBusinessKey,
  partnerFirstSignupTemplate,
  partnerInviteBusinessKey,
  partnerInviteTemplate,
  partnerInviteThreshold,
  partnerWelcomeBusinessKey,
} from '../src/server/partner/config.ts';
import {
  createPartnerFirstSignupJob,
  createPartnerInviteJob,
  partnerMilestoneMailBatchLimit,
} from '../src/server/partner/milestone-mail.ts';
import { createPartnerReviewService } from '../src/server/partner/review.ts';
import {
  partnerApplicationRenderers,
  partnerInviteRenderer,
} from '../src/server/partner/templates.ts';
import { createPartnerWelcomeJob } from '../src/server/partner/welcome.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createReferralVoidService } from '../src/server/referral/void.ts';
import { emailTokenSecret } from '../src/server/verification/token-derivation.ts';
import {
  createPartnerFixture,
  insertMember,
  insertPartner,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const actor = 'founder:test';
const secret = emailTokenSecret();
const origin = 'https://valstara.com';
const now = new Date('2026-11-24T10:00:00.000Z');
const clock = () => now;
const contract = { date: '2026-11-24', version: 'partner-v1', reference: null };
const limit = partnerMilestoneMailBatchLimit;

let fixture: PartnerFixture;

before(async () => {
  fixture = await createPartnerFixture('partner-milestone-mail');
});

after(async () => {
  await fixture?.dispose();
});

function provider(id: string, domain: string, sent: Message[]): EmailProvider {
  return {
    id,
    sendingDomain: domain,
    capabilities: {
      broadcast: id === 'brevo',
      contactSync: false,
      dailyFreeCap: 100,
    },
    async send({ message }) {
      sent.push(message);
      return { providerMessageId: randomUUID() };
    },
  };
}

function emailService(sent: Message[], broadcast = true) {
  return createEmailService(fixture.app, {
    clock,
    tokenSecret: secret,
    baseUrl: origin,
    providers: new Map([
      ['resend', provider('resend', 'send.valstara.com', sent)],
      ['brevo', provider('brevo', 'mail.valstara.com', sent)],
    ]),
    renderers: new Map([
      ...partnerApplicationRenderers(origin, 'send.valstara.com', {
        welcomeCode: (tokenId) =>
          createPartnerWelcomeRepository(fixture.app).codeForDashboardToken(
            tokenId,
          ),
      }),
      [
        partnerInviteTemplate,
        partnerInviteRenderer(origin, 'mail.valstara.com'),
      ],
    ]),
    isBroadcastEnabled: async () => broadcast,
    operatorTask: async () => assert.fail('unexpected failed email'),
  });
}

const queue = () => emailService([]);
const inviteJob = () =>
  createPartnerInviteJob(fixture.app, {
    clock,
    email: queue(),
    tokenSecret: secret,
  });
const firstSignupJob = () =>
  createPartnerFirstSignupJob(fixture.app, {
    clock,
    email: queue(),
    tokenSecret: secret,
  });
const welcomeJob = () =>
  createPartnerWelcomeJob(fixture.app, {
    clock,
    email: queue(),
    tokenSecret: secret,
  });

async function setFlag(
  key: 'partners.enabled' | 'email.broadcast',
  on: boolean,
) {
  await createCampaignFlagRepository(fixture.app).set(key, on, actor);
}

async function setFlags(partners: boolean, broadcast: boolean) {
  await setFlag('partners.enabled', partners);
  await setFlag('email.broadcast', broadcast);
}

async function rows(businessKey: string) {
  return fixture.owner.list<{
    template: string;
    provider: string;
    state: string;
    last_error: string | null;
    payload: Record<string, string>;
  }>(
    {
      text: `SELECT template, provider, state, last_error, payload
        FROM email_send WHERE business_key = $1`,
      values: [businessKey],
    },
    10,
  );
}

async function verify(id: string) {
  await fixture.owner.execute({
    text: "UPDATE subscriber SET status='verified', verified_at=$2 WHERE id=$1",
    values: [id, now],
  });
  assert.equal(
    await createReferralCouponRepository(
      fixture.app,
    ).assignVerificationOrderWindow(id, 'wave-2'),
    1,
  );
  await createReferralService(fixture.app).generateCode(id);
}

/** A friend who signs up with `code`, and confirms unless told otherwise. */
async function friend(code: string, confirm = true): Promise<string> {
  const member = await insertMember(fixture, { status: 'pending' });
  const referrals = createReferralService(fixture.app);
  assert.deepEqual(await referrals.attribute(member.id, code), {
    kind: 'attributed',
  });
  if (confirm) {
    await verify(member.id);
    assert.notEqual(await referrals.confirm(member.id, now), null);
  }
  return member.id;
}

/** A verified member with `count` confirmed referrals. */
async function referrer(count: number, marketing = true) {
  const member = await insertMember(fixture, { marketing });
  const code = await createReferralService(fixture.app).getReferralCode(
    member.id,
  );
  assert.ok(code);
  const friends: string[] = [];
  for (let index = 0; index < count; index += 1)
    friends.push(await friend(code));
  return { ...member, code, friends };
}

async function suppress(email: string) {
  await fixture.owner.execute({
    text: "INSERT INTO suppression (email_normalised, reason, source) VALUES (lower($1), 'complaint', 'resend')",
    values: [email],
  });
}

/** Queue everything else due, so a test counts only its own rows. */
async function drain() {
  await setFlags(true, true);
  await welcomeJob().run(100);
  await firstSignupJob().run(limit);
  await inviteJob().run(limit);
  await emailService([]).dispatch(100);
}

async function activePartner() {
  const partner = await insertPartner(fixture, { status: 'applied' });
  const review = createPartnerReviewService(fixture.app, clock);
  const approved = await review.approve(partner.id, null, actor);
  assert.ok(approved.after.code);
  await review.contractSent(partner.id, actor);
  await review.contractSigned(partner.id, contract, actor);
  return { ...partner, code: approved.after.code };
}

// ── The auto-invite ────────────────────────────────────────────────────────

test('the invite reaches only members with marketing consent, and only at the threshold', async () => {
  await drain();
  const consenting = await referrer(partnerInviteThreshold);
  const withoutConsent = await referrer(partnerInviteThreshold, false);
  const short = await referrer(partnerInviteThreshold - 1);

  assert.equal(await inviteJob().run(limit), 1);
  const [row] = await rows(partnerInviteBusinessKey(consenting.id));
  assert.ok(row);
  assert.equal(row.template, partnerInviteTemplate);
  // Marketing goes through the broadcast provider, so its unsubscribe
  // withdraws marketing consent only (ADR-027).
  assert.equal(row.provider, 'brevo');
  assert.deepEqual(Object.keys(row.payload), ['status_token_id']);
  assert.deepEqual(await rows(partnerInviteBusinessKey(withoutConsent.id)), []);
  assert.deepEqual(await rows(partnerInviteBusinessKey(short.id)), []);

  // The tenth referral confirms: the member reaches the threshold.
  await friend(short.code);
  assert.equal(await inviteJob().run(limit), 1);
  assert.equal((await rows(partnerInviteBusinessKey(short.id))).length, 1);

  // A member without consent who opts in later is invited then.
  await fixture.owner.execute({
    text: `UPDATE subscriber SET marketing_consent_at = $2,
      marketing_consent_version = 'v1', marketing_consent_source = 'member_status'
      WHERE id = $1`,
    values: [withoutConsent.id, now],
  });
  assert.equal(await inviteJob().run(limit), 1);
  assert.equal(
    (await rows(partnerInviteBusinessKey(withoutConsent.id))).length,
    1,
  );
});

test('consent withdrawn after queueing stops the invite at dispatch', async () => {
  await drain();
  const member = await referrer(partnerInviteThreshold);
  assert.equal(await inviteJob().run(limit), 1);
  await fixture.owner.execute({
    text: `UPDATE subscriber SET marketing_consent_at = NULL,
      marketing_consent_version = NULL, marketing_consent_source = NULL
      WHERE id = $1`,
    values: [member.id],
  });
  const sent: Message[] = [];
  const summary = await emailService(sent).dispatch(100);
  assert.equal(summary.suppressed, 1);
  assert.deepEqual(sent, []);
  const [row] = await rows(partnerInviteBusinessKey(member.id));
  assert.equal(row?.state, 'failed');
  assert.equal(row?.last_error, 'recipient_ineligible');
  assert.equal(await inviteJob().run(limit), 0, 'never queued again');
});

test('the invite is sent once: across retries, concurrent runs, and a void below the threshold and back', async () => {
  await drain();
  const members = [
    await referrer(partnerInviteThreshold),
    await referrer(partnerInviteThreshold),
    await referrer(partnerInviteThreshold),
  ];
  assert.equal(await inviteJob().run(1), 1, 'one per batch of one');
  const results = await Promise.all([
    inviteJob().run(limit),
    inviteJob().run(limit),
    inviteJob().run(limit),
  ]);
  assert.equal(
    results.reduce((sum, count) => sum + count, 0),
    2,
    'the concurrent runs queue each remaining member once',
  );
  for (const member of members)
    assert.equal((await rows(partnerInviteBusinessKey(member.id))).length, 1);

  const sent: Message[] = [];
  assert.equal((await emailService(sent).dispatch(100)).sent, 3);

  // A void drops the first member to nine: nothing is retracted or re-sent.
  const [first] = members;
  assert.ok(first);
  const voids = createReferralVoidService(fixture.app, clock);
  await voids.voidReferral(first.friends[0]!, 'Test void', actor);
  assert.equal(await inviteJob().run(limit), 0);
  const [afterVoid] = await rows(partnerInviteBusinessKey(first.id));
  assert.equal(afterVoid?.state, 'sent', 'the sent invite is left as it is');
  // Back to ten, by an un-void and by a new referral: still one invite.
  await voids.unvoidReferral(first.friends[0]!, 'Test undo', actor);
  await voids.voidReferral(first.friends[1]!, 'Test void', actor);
  await friend(first.code);
  assert.equal(await inviteJob().run(limit), 0);
  assert.equal((await rows(partnerInviteBusinessKey(first.id))).length, 1);
  sent.length = 0;
  assert.equal((await emailService(sent).dispatch(100)).sent, 0);

  for (const bad of [0, limit + 1, 1.5])
    await assert.rejects(inviteJob().run(bad), RangeError);
});

test('a voided referral does not count towards the threshold', async () => {
  await drain();
  const member = await referrer(partnerInviteThreshold);
  await createReferralVoidService(fixture.app, clock).voidReferral(
    member.friends[0]!,
    'Test void',
    actor,
  );
  assert.equal(await inviteJob().run(limit), 0);
  assert.deepEqual(await rows(partnerInviteBusinessKey(member.id)), []);
});

test('suppression stops the invite before queueing and again at dispatch', async () => {
  await drain();
  const before = await referrer(partnerInviteThreshold);
  await suppress(before.email);
  assert.equal(await inviteJob().run(limit), 0);
  assert.deepEqual(await rows(partnerInviteBusinessKey(before.id)), []);

  const during = await referrer(partnerInviteThreshold);
  assert.equal(await inviteJob().run(limit), 1);
  await suppress(during.email);
  const sent: Message[] = [];
  const summary = await emailService(sent).dispatch(100);
  assert.equal(summary.suppressed, 1);
  assert.deepEqual(sent, []);
  assert.equal(
    (await rows(partnerInviteBusinessKey(during.id)))[0]?.state,
    'failed',
  );
});

test('flag off, broadcast off or an existing application queues no invite', async () => {
  await drain();
  const member = await referrer(partnerInviteThreshold);
  await setFlags(false, true);
  assert.equal(await inviteJob().run(limit), 0);
  await setFlags(true, false);
  assert.equal(await inviteJob().run(limit), 0);
  assert.deepEqual(await rows(partnerInviteBusinessKey(member.id)), []);

  // A queued invite waits while broadcast sending is off.
  await setFlags(true, true);
  assert.equal(await inviteJob().run(limit), 1);
  const sent: Message[] = [];
  const paused = await emailService(sent, false).dispatch(100);
  assert.equal(paused.sent, 0);
  assert.deepEqual(sent, []);
  assert.equal(
    (await rows(partnerInviteBusinessKey(member.id)))[0]?.state,
    'queued',
  );

  // A member who already applied is not invited to apply.
  const applicant = await referrer(partnerInviteThreshold);
  await insertPartner(fixture, {
    status: 'unconfirmed',
    subscriberId: applicant.id,
    email: applicant.email,
  });
  assert.equal(await inviteJob().run(limit), 0);
  assert.deepEqual(await rows(partnerInviteBusinessKey(applicant.id)), []);
});

test('the invite renders from the broadcast domain, with the application link carrying only the recipient’s address', async () => {
  await drain();
  const member = await referrer(partnerInviteThreshold);
  assert.equal(await inviteJob().run(limit), 1);
  const sent: Message[] = [];
  assert.equal((await emailService(sent).dispatch(100)).sent, 1);
  const [message] = sent;
  assert.ok(message);
  assert.equal(message.to, member.email);
  assert.equal(message.from, 'Valstara <hello@mail.valstara.com>');
  const copy = partnersCopy.email.invite;
  assert.equal(message.subject, copy.subject);
  for (const line of [
    copy.firstLine(partnerInviteThreshold),
    copy.body,
    copy.review,
  ])
    assert.ok(message.text.includes(line), line);
  const hrefs = [
    ...(message.html ?? '').matchAll(/<a\b[^>]*\bhref="([^"]*)"/gu),
  ].map((match) => new URL(match[1]!.replaceAll('&amp;', '&')));
  const apply = hrefs[0];
  assert.ok(apply);
  assert.equal(apply.pathname, '/partners/apply', 'the main action applies');
  assert.deepEqual([...apply.searchParams.keys()], ['email']);
  assert.equal(apply.searchParams.get('email'), member.email);
  assert.ok(hrefs.some((url) => url.pathname === '/partners'));
  assert.ok(
    hrefs.some((url) => url.pathname === '/me' && url.searchParams.has('t')),
  );
  assert.ok(message.text.includes(emailCopy.status));
});

// ── The first-signup email ─────────────────────────────────────────────────

test('the first-signup email goes once per partner, on the first confirmed partner signup', async () => {
  await drain();
  const partner = await activePartner();
  assert.equal(await welcomeJob().run(100), 1);
  assert.equal(await firstSignupJob().run(limit), 0, 'no signup yet');

  const pending = await friend(partner.code, false);
  assert.equal(await firstSignupJob().run(limit), 0, 'an unconfirmed signup');
  await verify(pending);
  assert.notEqual(
    await createReferralService(fixture.app).confirm(pending, now),
    null,
  );
  const results = await Promise.all([
    firstSignupJob().run(limit),
    firstSignupJob().run(limit),
    firstSignupJob().run(limit),
  ]);
  assert.equal(
    results.reduce((sum, count) => sum + count, 0),
    1,
  );
  const [row] = await rows(partnerFirstSignupBusinessKey(partner.id));
  assert.ok(row);
  assert.equal(row.template, partnerFirstSignupTemplate);
  assert.equal(row.provider, 'resend');
  assert.deepEqual(Object.keys(row.payload), ['status_token_id']);

  // A second signup, and a void of the first, send nothing more.
  await friend(partner.code);
  await createReferralVoidService(fixture.app, clock).voidReferral(
    pending,
    'Test void',
    actor,
  );
  assert.equal(await firstSignupJob().run(limit), 0);
  assert.equal(
    (await rows(partnerFirstSignupBusinessKey(partner.id))).length,
    1,
  );

  const sent: Message[] = [];
  assert.equal((await emailService(sent).dispatch(100)).sent >= 1, true);
  const message = sent.find(
    (entry) => entry.subject === partnersCopy.email.firstSignup.subject,
  );
  assert.ok(message);
  assert.equal(message.to, partner.email);
  assert.equal(message.from, 'Valstara <hello@send.valstara.com>');
  const copy = partnersCopy.email.firstSignup;
  for (const line of [copy.firstLine, copy.body, copy.dashboard])
    assert.ok(message.text.includes(line), line);
  // It names no one: the referred person's address appears nowhere.
  const friendEmail = await fixture.owner.readOne<{ email: string }>({
    text: 'SELECT email FROM subscriber WHERE id = $1',
    values: [pending],
  });
  assert.ok(friendEmail);
  assert.ok(!message.text.includes(friendEmail.email));
  assert.ok(!(message.html ?? '').includes(friendEmail.email));
  // No new dashboard link: the welcome's link stays the current one.
  assert.doesNotMatch(message.html ?? '', /\/partners\/dashboard\?t=/u);
  assert.match(
    message.text,
    /\/partners\/apply\?operation=dashboard-recovery/u,
  );
});

test('a voided signup, a partner without a welcome and flag off send no first-signup email', async () => {
  await drain();
  // The only partner signup is voided before the job runs.
  const voided = await activePartner();
  assert.equal(await welcomeJob().run(100), 1);
  const only = await friend(voided.code);
  await createReferralVoidService(fixture.app, clock).voidReferral(
    only,
    'Test void',
    actor,
  );
  assert.equal(await firstSignupJob().run(limit), 0);
  assert.deepEqual(await rows(partnerFirstSignupBusinessKey(voided.id)), []);

  // A partner whose welcome has not been queued yet waits for it.
  const waiting = await activePartner();
  await friend(waiting.code);
  assert.equal((await rows(partnerWelcomeBusinessKey(waiting.id))).length, 0);
  await setFlag('partners.enabled', false);
  assert.equal(await firstSignupJob().run(limit), 0, 'flag off');
  await setFlag('partners.enabled', true);
  assert.equal(await firstSignupJob().run(limit), 0, 'no welcome yet');
  assert.equal(await welcomeJob().run(100), 1);
  await setFlag('partners.enabled', false);
  assert.equal(await firstSignupJob().run(limit), 0, 'flag off');
  assert.deepEqual(await rows(partnerFirstSignupBusinessKey(waiting.id)), []);
  await setFlag('partners.enabled', true);
  assert.equal(await firstSignupJob().run(limit), 1);

  for (const bad of [0, limit + 1, 1.5])
    await assert.rejects(firstSignupJob().run(bad), RangeError);
});

test('suppression stops the first-signup email before queueing and again at dispatch', async () => {
  await drain();
  const before = await activePartner();
  assert.equal(await welcomeJob().run(100), 1);
  await friend(before.code);
  await suppress(before.email);
  assert.equal(await firstSignupJob().run(limit), 0);
  assert.deepEqual(await rows(partnerFirstSignupBusinessKey(before.id)), []);

  const during = await activePartner();
  assert.equal(await welcomeJob().run(100), 1);
  await emailService([]).dispatch(100);
  await friend(during.code);
  assert.equal(await firstSignupJob().run(limit), 1);
  await suppress(during.email);
  const sent: Message[] = [];
  const summary = await emailService(sent).dispatch(100);
  assert.equal(summary.suppressed, 1);
  assert.deepEqual(sent, []);
  assert.equal(
    (await rows(partnerFirstSignupBusinessKey(during.id)))[0]?.state,
    'failed',
  );
  assert.equal(await firstSignupJob().run(limit), 0, 'never re-sent');
});
