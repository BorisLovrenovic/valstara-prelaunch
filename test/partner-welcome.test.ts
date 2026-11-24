// E11.7-11 (D-057, relocated from E11.7-07): the partner welcome email. It
// asserts the full message, no send while the flag is off or before the
// partner's code is live, one send for an already-active partner across
// catch-up retries and concurrent runs, one send on a later activation and
// reactivation, the batch cap, the dashboard link rules, and suppression at
// dispatch. Everything runs against a real database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { partnerDashboardCopy } from '../src/copy/partner-dashboard.ts';
import { createCampaignFlagRepository } from '../src/server/db/campaign-flags.ts';
import { createPartnerWelcomeRepository } from '../src/server/db/partner-welcome.ts';
import {
  createEmailService,
  type EmailProvider,
  type Message,
} from '../src/server/email/service.ts';
import { createPartnerActivationJob } from '../src/server/partner/activation.ts';
import {
  partnerWelcomeBusinessKey,
  partnerWelcomeTemplate,
} from '../src/server/partner/config.ts';
import { createPartnerDashboardService } from '../src/server/partner/dashboard.ts';
import { parsePartnerKit, partnerKit } from '../src/server/partner/kit.ts';
import { createPartnerReviewService } from '../src/server/partner/review.ts';
import { partnerApplicationRenderers } from '../src/server/partner/templates.ts';
import {
  createPartnerWelcomeJob,
  partnerWelcomeBatchLimit,
} from '../src/server/partner/welcome.ts';
import { emailTokenSecret } from '../src/server/verification/token-derivation.ts';
import {
  createPartnerFixture,
  insertPartner,
  type InsertedPartner,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const actor = 'founder:test';
const secret = emailTokenSecret();
const origin = 'https://valstara.com';
const now = new Date('2026-11-24T10:00:00.000Z');
const clock = () => now;
const contract = { date: '2026-11-24', version: 'partner-v1', reference: null };
const copy = partnerDashboardCopy.welcome;

let fixture: PartnerFixture;

before(async () => {
  fixture = await createPartnerFixture('partner-welcome');
});

after(async () => {
  await fixture?.dispose();
});

function emailService(
  sent: Message[],
  renderers = partnerApplicationRenderers(origin, 'send.valstara.com', {
    welcomeCode: (tokenId) =>
      createPartnerWelcomeRepository(fixture.app).codeForDashboardToken(
        tokenId,
      ),
  }),
) {
  const provider: EmailProvider = {
    id: 'resend',
    sendingDomain: 'send.valstara.com',
    capabilities: { broadcast: false, contactSync: false, dailyFreeCap: 100 },
    async send({ message }) {
      sent.push(message);
      return { providerMessageId: randomUUID() };
    },
  };
  return createEmailService(fixture.app, {
    clock,
    tokenSecret: secret,
    baseUrl: origin,
    providers: new Map([['resend', provider]]),
    renderers,
    isBroadcastEnabled: async () => false,
    operatorTask: async () => assert.fail('unexpected failed email'),
  });
}

function welcomeJob() {
  return createPartnerWelcomeJob(fixture.app, {
    clock,
    email: emailService([]),
    tokenSecret: secret,
  });
}

async function setFlag(enabled: boolean) {
  await createCampaignFlagRepository(fixture.app).set(
    'partners.enabled',
    enabled,
    actor,
  );
}

async function activePartner(): Promise<InsertedPartner & { code: string }> {
  const partner = await insertPartner(fixture, { status: 'active' });
  assert.ok(partner.code);
  await fixture.owner.readOne({
    text: 'SELECT set_partner_code_active($1, true)',
    values: [partner.id],
  });
  return { ...partner, code: partner.code };
}

async function welcomes(partnerId: string) {
  return fixture.owner.list<{
    template: string;
    state: string;
    payload: { token_id: string };
    expires_at: Date | null;
  }>(
    {
      text: `SELECT template, state, payload, expires_at FROM email_send
        WHERE business_key = $1`,
      values: [partnerWelcomeBusinessKey(partnerId)],
    },
    10,
  );
}

async function currentLinkId(partnerId: string) {
  const row = await fixture.owner.readOne<{
    dashboard_token_id: string | null;
  }>({
    text: 'SELECT dashboard_token_id FROM partner WHERE id = $1',
    values: [partnerId],
  });
  return row?.dashboard_token_id ?? null;
}

async function queuedWelcome(partner: { id: string }) {
  const rows = await welcomes(partner.id);
  assert.equal(rows.length, 1, 'exactly one welcome');
  const [row] = rows;
  assert.ok(row);
  assert.equal(row.template, partnerWelcomeTemplate);
  // A queued payload holds references only; the code is read at dispatch.
  assert.deepEqual(Object.keys(row.payload), ['token_id']);
  return row;
}

function dashboardService() {
  return createPartnerDashboardService(fixture.app, {
    clock,
    isEnabled: async () => true,
    tokenSecret: secret,
  });
}

test('the welcome holds the dashboard and flyer links, the code, the /r/ link and the checklist, and no kit-files line while the kit is empty', async () => {
  await setFlag(true);
  const partner = await activePartner();
  assert.equal((await welcomeJob().run(partnerWelcomeBatchLimit)) >= 1, true);
  const row = await queuedWelcome(partner);
  // The welcome's link is the partner's one current dashboard link, and the
  // mail may not outlive it.
  assert.equal(await currentLinkId(partner.id), row.payload.token_id);
  const token = await fixture.owner.readOne<{ expires_at: Date }>({
    text: 'SELECT expires_at FROM verification_token WHERE id = $1',
    values: [row.payload.token_id],
  });
  assert.equal(row.expires_at?.getTime(), token?.expires_at.getTime());
  assert.equal(
    token?.expires_at.getTime(),
    now.getTime() + 30 * 24 * 60 * 60 * 1000,
  );

  const sent: Message[] = [];
  const summary = await emailService(sent).dispatch(100);
  assert.equal(summary.sent >= 1, true);
  const message = sent.find((entry) => entry.to === partner.email);
  assert.ok(message);
  assert.equal(message.subject, copy.subject);
  assert.equal(message.from, 'Valstara <hello@send.valstara.com>');
  const link = `${origin}/r/${partner.code}`;
  for (const line of [
    copy.firstLine,
    copy.dashboard,
    copy.checklist,
    ...copy.steps,
    copy.code(partner.code),
    copy.link(link),
  ]) {
    assert.ok(message.text.includes(line), `text holds: ${line}`);
  }
  assert.equal(copy.steps.length, 3);
  assert.ok(!message.text.includes(copy.kitFiles), 'no kit-files line');
  assert.ok(!message.html?.includes(copy.kitFiles), 'no kit-files line');

  const hrefs = [
    ...(message.html ?? '').matchAll(/<a\b[^>]*\bhref="([^"]*)"/gu),
  ].map((match) => match[1]!.replaceAll('&amp;', '&'));
  const dashboard = hrefs.find((href) =>
    href.startsWith(`${origin}/partners/dashboard?t=`),
  );
  const flyer = hrefs.find((href) =>
    href.startsWith(`${origin}/partners/dashboard/flyer?t=`),
  );
  assert.ok(dashboard, 'the dashboard link is the main action');
  assert.equal(hrefs.indexOf(dashboard), 0, 'the dashboard link is the button');
  assert.ok(flyer, 'the flyer link is present');
  const bearer = new URL(dashboard).searchParams.get('t')!;
  assert.equal(new URL(flyer).searchParams.get('t'), bearer);
  // The emailed link opens this partner's own dashboard.
  const view = await dashboardService().read(bearer);
  assert.equal(view.kind, 'authenticated');
  assert.equal(view.kind === 'authenticated' ? view.row.id : null, partner.id);
});

test('a listed kit file adds the kit-files line', async () => {
  const kit = parsePartnerKit({
    _comment: 'planted',
    files: [],
    videos: [{ title: 'How to share', url: 'https://videos.example/share' }],
  });
  assert.equal(partnerKit.files.length + partnerKit.videos.length, 0);
  const renderers = (code: string | null) =>
    partnerApplicationRenderers(origin, 'send.valstara.com', {
      kit,
      welcomeCode: async (tokenId) => (tokenId === 'token-id' ? code : null),
    }).get(partnerWelcomeTemplate)!;
  const render = (code: string | null) =>
    renderers(code).render({
      email: 'partner@example.test',
      payload: { token_id: 'token-id' },
      token: async (id) => `${id}-signature`,
      unsubscribePageUrl: `${origin}/unsubscribe?t=u`,
    });
  const message = await render('PLANTED1');
  assert.ok(message.text.includes(copy.kitFiles));
  assert.ok(message.text.includes(copy.code('PLANTED1')));
  // A link whose partner has no live code, or a malformed one, never
  // renders a mail with a broken link.
  await assert.rejects(render(null), /email_token_missing/u);
  await assert.rejects(render('not a code'), /email_token_missing/u);
});

test('flag off sends nothing; a partner whose code is not live yet waits', async () => {
  await setFlag(true);
  // Drain anything other tests left due.
  await welcomeJob().run(partnerWelcomeBatchLimit);
  const partner = await activePartner();
  await setFlag(false);
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 0);
  assert.equal((await welcomes(partner.id)).length, 0);
  assert.equal(await currentLinkId(partner.id), null);

  // Signed while the flag is off: active, but the code activation is
  // deferred, so the dashboard's link and the flyer would not credit anyone.
  const pending = await insertPartner(fixture, { status: 'applied' });
  const review = createPartnerReviewService(fixture.app, clock);
  await review.approve(pending.id, null, actor);
  await review.contractSent(pending.id, actor);
  await review.contractSigned(pending.id, contract, actor);
  await setFlag(true);
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 1);
  assert.equal((await welcomes(partner.id)).length, 1);
  assert.equal((await welcomes(pending.id)).length, 0, 'code not live yet');

  await createPartnerActivationJob(fixture.app, clock).run(100);
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 1);
  assert.equal((await welcomes(pending.id)).length, 1);
});

test('catch-up is idempotent across retries and concurrent runs, and batch-capped', async () => {
  await setFlag(true);
  await welcomeJob().run(partnerWelcomeBatchLimit);
  const first = await activePartner();
  const second = await activePartner();
  const third = await activePartner();

  assert.equal(await welcomeJob().run(1), 1, 'one per batch of one');
  const results = await Promise.all([
    welcomeJob().run(partnerWelcomeBatchLimit),
    welcomeJob().run(partnerWelcomeBatchLimit),
    welcomeJob().run(partnerWelcomeBatchLimit),
  ]);
  assert.equal(
    results.reduce((sum, count) => sum + count, 0),
    2,
    'the concurrent runs queue each remaining partner once',
  );
  for (const partner of [first, second, third]) {
    const row = await queuedWelcome(partner);
    // A run that lost the race left the winner's link in place.
    assert.equal(await currentLinkId(partner.id), row.payload.token_id);
  }
  const links = await Promise.all(
    [first, second, third].map((partner) => currentLinkId(partner.id)),
  );
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 0);
  assert.deepEqual(
    await Promise.all(
      [first, second, third].map((partner) => currentLinkId(partner.id)),
    ),
    links,
    'a retry issues no new link',
  );

  for (const limit of [0, partnerWelcomeBatchLimit + 1, 1.5]) {
    await assert.rejects(welcomeJob().run(limit), RangeError);
  }
});

test('a later activation and a reactivation each get the welcome once; issuing it cancels an earlier link', async () => {
  await setFlag(true);
  await welcomeJob().run(partnerWelcomeBatchLimit);
  const review = createPartnerReviewService(fixture.app, clock);
  const partner = await insertPartner(fixture, { status: 'applied' });
  assert.ok((await review.approve(partner.id, null, actor)).after.code);
  await review.contractSent(partner.id, actor);
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 0);

  await review.contractSigned(partner.id, contract, actor);
  // A link the partner already holds (for example from recovery).
  const earlier = { id: randomUUID() };
  await fixture.owner.execute({
    text: `INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at)
      VALUES ($1, $2, sha256(gen_random_uuid()::text::bytea), 'partner_dashboard', $3)`,
    values: [
      earlier.id,
      partner.subscriberId,
      new Date(now.getTime() + 86_400_000),
    ],
  });
  await fixture.owner.execute({
    text: 'UPDATE partner SET dashboard_token_id = $2 WHERE id = $1',
    values: [partner.id, earlier.id],
  });
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 1);
  const row = await queuedWelcome(partner);
  assert.notEqual(row.payload.token_id, earlier.id);
  assert.equal(await currentLinkId(partner.id), row.payload.token_id);

  await review.pause(partner.id, actor);
  await review.reactivate(partner.id, actor);
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 0);
  assert.equal((await welcomes(partner.id)).length, 1);

  // A partner paused before the welcome shipped gets it on reactivation.
  const paused = await activePartner();
  await fixture.owner.execute({
    text: "UPDATE partner SET status = 'paused' WHERE id = $1",
    values: [paused.id],
  });
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 0);
  await review.reactivate(paused.id, actor);
  await createPartnerActivationJob(fixture.app, clock).run(100);
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 1);
  await queuedWelcome(paused);
});

test('suppression is checked before queueing and again at dispatch', async () => {
  await setFlag(true);
  await welcomeJob().run(partnerWelcomeBatchLimit);
  const sent: Message[] = [];
  await emailService(sent).dispatch(100);

  const before = await activePartner();
  await fixture.owner.execute({
    text: "INSERT INTO suppression (email_normalised, reason, source) VALUES ($1, 'complaint', 'resend')",
    values: [before.email],
  });
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 0);
  assert.equal((await welcomes(before.id)).length, 0);
  assert.equal(await currentLinkId(before.id), null, 'no link issued');

  const during = await activePartner();
  assert.equal(await welcomeJob().run(partnerWelcomeBatchLimit), 1);
  await fixture.owner.execute({
    text: "INSERT INTO suppression (email_normalised, reason, source) VALUES ($1, 'bounce_hard', 'resend')",
    values: [during.email],
  });
  const summary = await emailService(sent.splice(0)).dispatch(100);
  assert.equal(summary.suppressed, 1);
  assert.equal(summary.sent, 0);
  assert.deepEqual(sent, []);
  const [row] = await welcomes(during.id);
  assert.equal(row?.state, 'failed');
  assert.equal(
    await welcomeJob().run(partnerWelcomeBatchLimit),
    0,
    'never re-sent',
  );
});
