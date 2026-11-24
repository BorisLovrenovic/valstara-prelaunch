import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import {
  createEmailService,
  type EmailProvider,
} from '../src/server/email/service.ts';
import { displayNameDisclosureVersion } from '../src/server/partner/config.ts';
import {
  createPartnerDashboardService,
  readPartnerSettings,
} from '../src/server/partner/dashboard.ts';
import { createPartnerDashboardRecovery } from '../src/server/partner/dashboard-recovery.ts';
import { createPartnerLeaderboardJob } from '../src/server/partner/leaderboard.ts';
import { presentPartnerDashboard } from '../src/server/partner/dashboard-presentation.ts';
import { createPartnerApplicationPurgeJob } from '../src/server/partner/retention.ts';
import { partnerApplicationRenderers } from '../src/server/partner/templates.ts';
import {
  deriveEmailToken,
  emailTokenSecret,
  hashEmailToken,
} from '../src/server/verification/token-derivation.ts';
import {
  createPartnerFixture,
  insertPartner,
  insertReferral,
  partnerErasure,
  type InsertedPartner,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

let fixture: PartnerFixture;
const initialTime = new Date('2026-11-23T10:00:00Z');
const thirtyDays = 30 * 24 * 60 * 60 * 1000;
const fifteenMinutes = 15 * 60 * 1000;
const secret = emailTokenSecret();

before(async () => {
  fixture = await createPartnerFixture('partner-dashboard');
});

after(async () => {
  await fixture?.dispose();
});

function form(fields: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries(fields)) result.set(key, value);
  return result;
}

function recoveryForm(address: string, challenge = 'valid') {
  return form({ email_address: address, turnstile_token: challenge });
}

function settingsForm(token: string, name: string, show = false) {
  return form({
    settings_token: token,
    display_name: name,
    ...(show
      ? { show_on_leaderboard: 'yes', nonessential_email_enabled: 'yes' }
      : {}),
  });
}

function scenario() {
  let current = new Date(initialTime);
  let enabled = true;
  const clock = () => current;
  const isEnabled = async () => enabled;
  const calls: string[] = [];
  const delays: number[] = [];
  const dashboard = createPartnerDashboardService(fixture.app, {
    clock,
    isEnabled,
    tokenSecret: secret,
  });
  const recover = createPartnerDashboardRecovery(fixture.app, {
    clock,
    tokenSecret: secret,
    async isEnabled() {
      calls.push('flag');
      return enabled;
    },
    async verifyTurnstile(token) {
      calls.push('challenge');
      return token === 'valid'
        ? 'verified'
        : token === 'unavailable'
          ? 'unavailable'
          : 'rejected';
    },
    hashIpPrefix(address) {
      calls.push('prefix');
      return address;
    },
    async sleep(ms) {
      delays.push(ms);
    },
  });
  return {
    dashboard,
    recover,
    calls,
    delays,
    clock,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    pauseProgramme() {
      enabled = false;
    },
  };
}

async function currentLink(partner: InsertedPartner) {
  return fixture.owner.readOne<{
    id: string;
    expires_at: Date;
    token_hash: Buffer;
  }>({
    text: `SELECT token.id, token.expires_at, token.token_hash
      FROM partner JOIN verification_token token ON token.id = partner.dashboard_token_id
      WHERE partner.id = $1`,
    values: [partner.id],
  });
}

async function requestLink(
  state: ReturnType<typeof scenario>,
  partner: InsertedPartner,
  prefix = randomUUID(),
) {
  assert.equal(
    await state.recover(recoveryForm(partner.email), prefix),
    'accepted',
  );
  const link = await currentLink(partner);
  assert.ok(link);
  return { ...link, bearer: deriveEmailToken(link.id, secret) };
}

async function settingsFor(state: ReturnType<typeof scenario>, bearer: string) {
  const view = await state.dashboard.read(bearer);
  assert.equal(view.kind, 'authenticated');
  return view.settingsToken;
}

async function settingsRow(partnerId: string) {
  return fixture.owner.readOne({
    text: 'SELECT display_name, display_name_disclosure_version, show_on_leaderboard, nonessential_email_enabled FROM partner WHERE id = $1',
    values: [partnerId],
  });
}

test('settings parsing trims names and rejects identifiers, control characters and ambiguous controls', () => {
  assert.deepEqual(readPartnerSettings(settingsForm('', '  Riley  ', true)), {
    displayName: 'Riley',
    confirmLeaderboardName: false,
    showOnLeaderboard: true,
    nonessentialEmailEnabled: true,
  });
  assert.deepEqual(readPartnerSettings(settingsForm('', '')), {
    displayName: null,
    confirmLeaderboardName: false,
    showOnLeaderboard: false,
    nonessentialEmailEnabled: false,
  });
  for (const name of [
    'friend@example.test',
    '192.0.2.90',
    'Ali\nce',
    'a'.repeat(201),
  ]) {
    assert.equal(readPartnerSettings(settingsForm('', name, true)), null);
  }
  assert.equal(
    readPartnerSettings(settingsForm('', '', true))?.showOnLeaderboard,
    false,
  );
  const ambiguousConfirmation = settingsForm('', 'Riley');
  ambiguousConfirmation.set('confirm_leaderboard_name', 'no');
  assert.equal(readPartnerSettings(ambiguousConfirmation), null);
  const duplicate = settingsForm('', 'Riley', true);
  duplicate.append('show_on_leaderboard', 'yes');
  assert.equal(readPartnerSettings(duplicate), null);
  assert.equal(
    readPartnerSettings(
      form({ display_name: 'Riley', nonessential_email_enabled: 'no' }),
    ),
    null,
  );
});

test('a new 30-day link cancels the old bearer and its settings token; expiry and tamper share the same result', async () => {
  const state = scenario();
  const partner = await insertPartner(fixture, { status: 'active' });
  const original = await requestLink(state, partner);
  assert.equal(
    original.expires_at.getTime() - state.clock().getTime(),
    thirtyDays,
  );
  assert.deepEqual(original.token_hash, hashEmailToken(original.bearer));
  const settings = await settingsFor(state, original.bearer);

  state.advance(fifteenMinutes);
  const current = await requestLink(state, partner);
  assert.notEqual(current.id, original.id);
  const invalid = { kind: 'invalid' };
  assert.deepEqual(await state.dashboard.read(original.bearer), invalid);
  assert.deepEqual(
    await state.dashboard.save(settingsForm(settings, 'Old link'), 'rotation'),
    invalid,
  );
  assert.deepEqual(
    await state.dashboard.read(
      (current.bearer[0] === 'x' ? 'y' : 'x') + current.bearer.slice(1),
    ),
    invalid,
  );
  const fresh = await settingsFor(state, current.bearer);
  state.advance(thirtyDays);
  assert.deepEqual(await state.dashboard.read(current.bearer), invalid);
  assert.deepEqual(
    await state.dashboard.save(settingsForm(fresh, 'Expired'), 'rotation'),
    invalid,
  );
  assert.equal((await settingsRow(partner.id))?.display_name, null);
});

test('active and paused partners can recover, read and save; termination ends all three', async () => {
  const state = scenario();
  const partner = await insertPartner(fixture, { status: 'active' });
  const initial = await requestLink(state, partner);
  await fixture.owner.execute({
    text: "UPDATE partner SET status = 'paused', status_changed_at = $2 WHERE id = $1",
    values: [partner.id, state.clock()],
  });
  state.advance(fifteenMinutes);
  const paused = await requestLink(state, partner);
  assert.deepEqual(await state.dashboard.read(initial.bearer), {
    kind: 'invalid',
  });
  const formToken = await settingsFor(state, paused.bearer);
  assert.deepEqual(
    await state.dashboard.save(
      settingsForm(formToken, 'Paused partner'),
      'paused',
    ),
    { kind: 'saved', bearer: paused.bearer },
  );
  const pending = await settingsFor(state, paused.bearer);
  await fixture.owner.execute({
    text: "UPDATE partner SET status = 'terminated', status_changed_at = $2 WHERE id = $1",
    values: [partner.id, state.clock()],
  });
  assert.deepEqual(await state.dashboard.read(paused.bearer), {
    kind: 'invalid',
  });
  assert.deepEqual(
    await state.dashboard.save(settingsForm(pending, 'Terminated'), 'paused'),
    { kind: 'invalid' },
  );
  state.advance(fifteenMinutes);
  const before = await fixture.owner.readOne({
    text: "SELECT count(*)::int FROM email_send WHERE subscriber_id = $1 AND template = 'partner_dashboard_link'",
    values: [partner.subscriberId],
  });
  const terminated = await state.recover(
    recoveryForm(partner.email),
    'terminated',
  );
  assert.equal(
    terminated,
    await state.recover(
      recoveryForm('no-such-partner@example.test'),
      'terminated',
    ),
  );
  assert.equal(await currentLink(partner), null);
  assert.deepEqual(
    await fixture.owner.readOne({
      text: "SELECT count(*)::int FROM email_send WHERE subscriber_id = $1 AND template = 'partner_dashboard_link'",
      values: [partner.subscriberId],
    }),
    before,
  );
  assert.equal((await settingsRow(partner.id))?.display_name, 'Paused partner');
});

test('settings are purpose-bound, fresh per load and single-use under real concurrency', async () => {
  const state = scenario();
  const one = await insertPartner(fixture, { status: 'active' });
  const two = await insertPartner(fixture, { status: 'active' });
  const first = await requestLink(state, one);
  const second = await requestLink(state, two);
  const token = await settingsFor(state, first.bearer);
  assert.notEqual(token, await settingsFor(state, first.bearer));
  const tampered = token.replace(first.id, second.id);
  assert.deepEqual(
    await state.dashboard.save(
      settingsForm(tampered, 'Cross partner'),
      'tamper',
    ),
    { kind: 'invalid' },
  );
  assert.deepEqual(
    await state.dashboard.save(
      settingsForm(first.bearer, 'Wrong purpose'),
      'tamper',
    ),
    { kind: 'invalid' },
  );
  const results = await Promise.all([
    state.dashboard.save(settingsForm(token, 'Riley', true), 'concurrent'),
    state.dashboard.save(settingsForm(token, 'Morgan', true), 'concurrent'),
  ]);
  assert.deepEqual(results.map(({ kind }) => kind).sort(), [
    'invalid',
    'saved',
  ]);
  assert.deepEqual(await settingsRow(one.id), {
    display_name: results[0]?.kind === 'saved' ? 'Riley' : 'Morgan',
    display_name_disclosure_version: displayNameDisclosureVersion,
    show_on_leaderboard: true,
    nonessential_email_enabled: true,
  });
  assert.deepEqual(await settingsRow(two.id), {
    display_name: null,
    display_name_disclosure_version: null,
    show_on_leaderboard: false,
    nonessential_email_enabled: false,
  });
  const claims = await fixture.owner.readOne({
    text: "SELECT count(*)::int FROM verification_token WHERE subscriber_id = $1 AND purpose = 'partner_dashboard_settings' AND consumed_at IS NOT NULL AND expires_at = $2",
    values: [one.subscriberId, first.expires_at],
  });
  assert.deepEqual(claims, { count: 1 });
});

test('a failed settings write rolls back the claim and the same token can be retried', async () => {
  const state = scenario();
  const partner = await insertPartner(fixture, { status: 'active' });
  const link = await requestLink(state, partner);
  const token = await settingsFor(state, link.bearer);
  await fixture.owner.execute({
    text: "ALTER TABLE partner ADD CONSTRAINT test_settings_write_failure CHECK (display_name <> 'Induce failure')",
  });
  try {
    assert.deepEqual(
      await state.dashboard.save(
        settingsForm(token, 'Induce failure'),
        'atomic',
      ),
      { kind: 'unavailable' },
    );
    assert.equal((await settingsRow(partner.id))?.display_name, null);
    assert.deepEqual(
      await state.dashboard.save(settingsForm(token, 'Retried'), 'atomic'),
      {
        kind: 'saved',
        bearer: link.bearer,
      },
    );
  } finally {
    await fixture.owner.execute({
      text: 'ALTER TABLE partner DROP CONSTRAINT test_settings_write_failure',
    });
  }
});

test('the flag pauses reads, mail and settings, and invalid settings attempts spend the IP bucket', async () => {
  const state = scenario();
  const partner = await insertPartner(fixture, { status: 'active' });
  const link = await requestLink(state, partner);
  const token = await settingsFor(state, link.bearer);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(
      await state.dashboard.save(new FormData(), 'settings-limit'),
      { kind: 'invalid' },
    );
  }
  assert.deepEqual(
    await state.dashboard.save(
      settingsForm(token, 'Rate limited'),
      'settings-limit',
    ),
    { kind: 'rate_limited' },
  );
  assert.equal((await settingsRow(partner.id))?.display_name, null);
  state.pauseProgramme();
  assert.deepEqual(await state.dashboard.read(link.bearer), { kind: 'paused' });
  assert.deepEqual(
    await state.dashboard.save(
      settingsForm(token, 'Programme paused'),
      'another',
    ),
    { kind: 'paused' },
  );
  state.advance(fifteenMinutes);
  assert.equal(
    await state.recover(recoveryForm(partner.email), 'another'),
    'paused',
  );
  assert.equal((await currentLink(partner))?.id, link.id);
  assert.equal((await settingsRow(partner.id))?.display_name, null);
});

test('Turnstile runs before flag, rate and normalisation; address and IP limits are independent and uniform', async () => {
  const state = scenario();
  const partner = await insertPartner(fixture, {
    status: 'active',
    email: 'dashlimit@gmail.com',
  });
  assert.equal(
    await state.recover(recoveryForm(partner.email, ''), 'blocked'),
    'challenge_failed',
  );
  assert.deepEqual(state.calls, ['challenge']);
  assert.equal(await currentLink(partner), null);
  const before = state.delays.length;
  const first = await state.recover(
    recoveryForm('D.A.S.H.LIMIT+test@gmail.com'),
    'prefix-a',
  );
  const second = await state.recover(
    recoveryForm('unknown-dash@example.test'),
    'prefix-a',
  );
  assert.equal(first, 'accepted');
  assert.equal(second, first);
  assert.deepEqual(state.delays.slice(before), [500, 500]);
  assert.ok(await currentLink(partner));
  assert.equal(
    await state.recover(recoveryForm(partner.email), 'prefix-b'),
    'rate_limited',
  );
  assert.equal(
    await state.recover(
      recoveryForm('unknown-dash+another@example.test'),
      'prefix-b',
    ),
    'rate_limited',
  );

  for (const address of [
    'limit-one@example.test',
    'limit-two@example.test',
    'limit-three@example.test',
  ]) {
    assert.equal(
      await state.recover(recoveryForm(address), 'prefix-a'),
      'accepted',
    );
  }
  assert.equal(
    await state.recover(recoveryForm('limit-four@example.test'), 'prefix-a'),
    'rate_limited',
  );
  assert.equal(
    await state.recover(recoveryForm('malformed'), 'prefix-b'),
    'invalid_email',
  );
});

test('unavailable Turnstile applies a strict bucket and flags eligible recovery; suppression is rechecked at dispatch', async () => {
  const state = scenario();
  const recipient = await insertPartner(fixture, { status: 'active' });
  const suppressed = await insertPartner(fixture, { status: 'active' });
  assert.equal(
    await state.recover(recoveryForm(recipient.email, 'unavailable'), 'strict'),
    'accepted',
  );
  assert.equal(
    await state.recover(
      recoveryForm('strict-miss@example.test', 'unavailable'),
      'strict',
    ),
    'accepted',
  );
  assert.equal(
    await state.recover(
      recoveryForm(suppressed.email, 'unavailable'),
      'strict',
    ),
    'rate_limited',
  );
  assert.deepEqual(
    await fixture.owner.readOne({
      text: "SELECT count(*)::int FROM fraud_flag WHERE subscriber_id = $1 AND kind = 'challenge_timeout'",
      values: [recipient.subscriberId],
    }),
    { count: 1 },
  );
  const link = await currentLink(recipient);
  assert.ok(link);
  await fixture.owner.execute({
    text: "INSERT INTO suppression (email_normalised, reason, source) VALUES ($1, 'complaint', 'resend')",
    values: [suppressed.email],
  });
  assert.equal(
    await state.recover(recoveryForm(suppressed.email), 'ordinary'),
    'accepted',
  );
  assert.equal(await currentLink(suppressed), null);

  const sent: string[] = [];
  const provider: EmailProvider = {
    id: 'resend',
    sendingDomain: 'send.valstara.com',
    capabilities: { broadcast: false, contactSync: false, dailyFreeCap: 100 },
    async send({ message }) {
      sent.push(message.to);
      return { providerMessageId: randomUUID() };
    },
  };
  const service = createEmailService(fixture.app, {
    clock: state.clock,
    tokenSecret: secret,
    baseUrl: 'https://valstara.com',
    providers: new Map([['resend', provider]]),
    renderers: partnerApplicationRenderers(
      'https://valstara.com',
      'send.valstara.com',
    ),
    isBroadcastEnabled: async () => false,
    operatorTask: async () => assert.fail('unexpected failed email'),
  });
  await fixture.owner.execute({
    text: "INSERT INTO suppression (email_normalised, reason, source) VALUES ($1, 'complaint', 'resend')",
    values: [recipient.email],
  });
  const summary = await service.dispatch(100);
  assert.ok(summary.suppressed > 0);
  assert.ok(!sent.includes(recipient.email));
  assert.deepEqual(
    await fixture.owner.readOne({
      text: 'SELECT state, last_error FROM email_send WHERE business_key = $1',
      values: [`partner-dashboard-link:${link.id}`],
    }),
    { state: 'failed', last_error: 'recipient_ineligible' },
  );
});

test('counts and current survey categories include only the owner’s eligible edges', async () => {
  const state = scenario();
  const partner = await insertPartner(fixture, {
    status: 'active',
    partnerType: 'student_ambassador',
  });
  const other = await insertPartner(fixture, { status: 'active' });
  const v2 = await insertReferral(fixture, partner.subscriberId);
  const v1 = await insertReferral(fixture, partner.subscriberId, {
    createdAt: new Date('2026-11-11T01:02:03Z'),
  });
  const pending = await insertReferral(fixture, partner.subscriberId, {
    state: 'attributed',
  });
  const voided = await insertReferral(fixture, partner.subscriberId, {
    voided: true,
  });
  const stranger = await insertReferral(fixture, other.subscriberId);
  for (const [friend, version, categories] of [
    [v2, '2026-10-19', ['ai', 'software']],
    [v1, '2026-09-08', ['apparel']],
    [pending, '2026-10-19', ['subscriptions']],
    [voided, '2026-10-19', ['gift_cards']],
    [stranger, '2026-10-19', ['game_keys']],
  ] as const) {
    await fixture.owner.execute({
      text: 'INSERT INTO survey_response (id, subscriber_id, version, answers, first_answered_at) VALUES ($1, $2, $3, $4, $5)',
      values: [
        randomUUID(),
        friend.referredId,
        version,
        { category_preference: categories },
        initialTime,
      ],
    });
  }
  await fixture.app.readOne({
    text: 'SELECT set_partner_code_active($1, true)',
    values: [partner.id],
  });
  const link = await requestLink(state, partner);
  const view = await state.dashboard.read(link.bearer);
  assert.equal(view.kind, 'authenticated');
  const { row } = view;
  assert.deepEqual([row.confirmed, row.pending, row.voided], [2, 1, 1]);
  assert.deepEqual(row.weeks, [
    { week: '2026-11-09', count: 1 },
    { week: '2026-11-02', count: 1 },
  ]);
  assert.deepEqual(row.categories, { ai: 1, software: 1 });
  assert.equal(row.code, partner.code);
  assert.doesNotMatch(JSON.stringify(row), /@example\.test|apparel/u);
  const presentation = presentPartnerDashboard(row, true);
  assert.match(presentation.rewards?.welcome ?? '', /15%/u);
  assert.match(
    presentation.rewards?.ladder.line ?? '',
    /1 more confirmed referral/u,
  );
  assert.equal(presentPartnerDashboard(row, false).rewards, null);
});

test('saved settings enter subject export and erasure clears settings and both token purposes', async () => {
  const state = scenario();
  const partner = await insertPartner(fixture, { status: 'active' });
  const link = await requestLink(state, partner);
  assert.equal(
    (
      await state.dashboard.save(
        settingsForm(
          await settingsFor(state, link.bearer),
          'Erasure Riley',
          true,
        ),
        'erasable',
      )
    ).kind,
    'saved',
  );
  const { exportSubjectPage } = await import('../src/server/db/dsr-export.ts');
  const rows = await exportSubjectPage(
    fixture.app,
    'partner',
    partner.subscriberId,
    0,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.data.display_name, 'Erasure Riley');
  assert.equal(
    rows[0]?.data.display_name_disclosure_version,
    displayNameDisclosureVersion,
  );
  const erasure = partnerErasure(fixture, async () => {});
  await (
    await erasure.signedConfirmation(partner.subscriberId)
  )();
  await erasure.fulfil();
  assert.deepEqual(await settingsRow(partner.id), {
    display_name: null,
    display_name_disclosure_version: null,
    show_on_leaderboard: false,
    nonessential_email_enabled: false,
  });
  assert.equal(await currentLink(partner), null);
  assert.deepEqual(
    await fixture.owner.readOne({
      text: "SELECT count(*)::int FROM verification_token WHERE subscriber_id = $1 AND purpose LIKE 'partner_dashboard%'",
      values: [partner.subscriberId],
    }),
    { count: 0 },
  );
});

test('legacy names stay private through email-only saves, then qualify and withdraw against the retained board', async () => {
  const state = scenario();
  const viewer = await insertPartner(fixture, { status: 'active' });
  const first = await insertPartner(fixture, {
    status: 'active',
    fullName: 'Application Alpha',
  });
  const second = await insertPartner(fixture, {
    status: 'active',
    fullName: 'Application Beta',
  });
  for (let i = 0; i < 3; i += 1) {
    await insertReferral(fixture, first.subscriberId);
    await insertReferral(fixture, second.subscriberId);
  }
  await insertReferral(fixture, first.subscriberId);
  await fixture.owner.execute({
    text: `UPDATE partner SET display_name = CASE WHEN id = $1 THEN 'Legacy Alpha' ELSE 'Legacy Beta' END,
      show_on_leaderboard = (id = $1) WHERE id IN ($1, $2)`,
    values: [first.id, second.id],
  });
  const viewerLink = await requestLink(state, viewer);
  const firstLink = await requestLink(state, first);
  const secondLink = await requestLink(state, second);
  const boardJob = createPartnerLeaderboardJob(
    fixture.app,
    async () => true,
    state.clock,
  );
  await boardJob.run();
  state.advance(60 * 60 * 1000);
  await fixture.owner.execute({
    text: `ALTER TABLE partner_leaderboard_rank
      ADD CONSTRAINT reject_next_rank CHECK (confirmed_signups < 3) NOT VALID`,
  });
  try {
    await assert.rejects(boardJob.run(), /reject_next_rank/u);
  } finally {
    await fixture.owner.execute({
      text: 'ALTER TABLE partner_leaderboard_rank DROP CONSTRAINT reject_next_rank',
    });
  }

  async function readBoard() {
    const view = await state.dashboard.read(viewerLink.bearer);
    assert.equal(view.kind, 'authenticated');
    assert.equal(view.leaderboard?.asOf, initialTime.toISOString());
    return view.leaderboard.entries
      .filter((row) => row.confirmedSignups >= 3)
      .map((row) => row.label)
      .sort();
  }
  assert.deepEqual(await readBoard(), ['Partner', 'Partner']);
  const legacy = await state.dashboard.read(firstLink.bearer);
  assert.equal(legacy.kind, 'authenticated');
  assert.equal(legacy.row.display_name, 'Legacy Alpha');
  assert.equal(legacy.needsNameConfirmation, true);

  const claims = `${first.id}.${firstLink.id}.${randomUUID()}`;
  const oldToken = `${claims}.${deriveEmailToken(`partner_dashboard_settings:${claims}`, secret)}`;
  assert.deepEqual(
    await state.dashboard.save(
      settingsForm(oldToken, 'Old form', true),
      'version',
    ),
    { kind: 'invalid' },
  );
  const tamperedVersion = legacy.settingsToken.replace('.1.', '.2.');
  assert.deepEqual(
    await state.dashboard.save(
      settingsForm(tamperedVersion, 'Tampered form', true),
      'version',
    ),
    { kind: 'invalid' },
  );
  assert.equal((await settingsRow(first.id))?.display_name, 'Legacy Alpha');

  const emailOnly = settingsForm(legacy.settingsToken, 'Legacy Alpha');
  emailOnly.set('nonessential_email_enabled', 'yes');
  assert.equal(
    (await state.dashboard.save(emailOnly, 'email-only')).kind,
    'saved',
  );
  assert.deepEqual(await settingsRow(first.id), {
    display_name: 'Legacy Alpha',
    display_name_disclosure_version: null,
    show_on_leaderboard: true,
    nonessential_email_enabled: true,
  });
  assert.deepEqual(await readBoard(), ['Partner', 'Partner']);

  const staleEarlierForm = await settingsFor(state, secondLink.bearer);
  const firstConfirmed = settingsForm(
    await settingsFor(state, firstLink.bearer),
    'Legacy Alpha',
  );
  firstConfirmed.set('confirm_leaderboard_name', 'yes');
  const secondConfirmed = settingsForm(
    await settingsFor(state, secondLink.bearer),
    'Legacy Beta',
    true,
  );
  secondConfirmed.set('confirm_leaderboard_name', 'yes');
  assert.equal(
    (await state.dashboard.save(firstConfirmed, 'first-confirmed')).kind,
    'saved',
  );
  assert.equal(
    (await state.dashboard.save(secondConfirmed, 'second-confirmed')).kind,
    'saved',
  );
  assert.deepEqual(await readBoard(), ['L. A.', 'Legacy Beta']);
  assert.equal((await settingsRow(first.id))?.show_on_leaderboard, false);

  const staleFullNameForm = await settingsFor(state, secondLink.bearer);
  const withdrawFullName = settingsForm(
    await settingsFor(state, secondLink.bearer),
    'Legacy Beta',
  );
  withdrawFullName.set('nonessential_email_enabled', 'yes');
  assert.equal(
    (await state.dashboard.save(withdrawFullName, 'withdraw-full-name')).kind,
    'saved',
  );
  assert.deepEqual(await readBoard(), ['L. A.', 'L. B.']);
  const staleEmailOnly = settingsForm(staleFullNameForm, 'Legacy Beta', true);
  staleEmailOnly.delete('nonessential_email_enabled');
  assert.deepEqual(
    await state.dashboard.save(staleEmailOnly, 'stale-email-only'),
    { kind: 'invalid' },
  );
  assert.deepEqual(await readBoard(), ['L. A.', 'L. B.']);
  assert.equal((await settingsRow(second.id))?.show_on_leaderboard, false);
  assert.equal(
    (await settingsRow(second.id))?.nonessential_email_enabled,
    true,
  );
  assert.equal(
    (
      await state.dashboard.save(
        settingsForm(await settingsFor(state, secondLink.bearer), '', true),
        'withdraw-all',
      )
    ).kind,
    'saved',
  );
  assert.deepEqual(await readBoard(), ['L. A.', 'Partner']);
  assert.equal(
    (await settingsRow(second.id))?.display_name_disclosure_version,
    null,
  );

  assert.deepEqual(
    await state.dashboard.save(
      settingsForm(staleEarlierForm, 'Legacy Beta'),
      'earlier-form-after-clear',
    ),
    { kind: 'invalid' },
  );
  assert.deepEqual(await readBoard(), ['L. A.', 'Partner']);
  assert.equal((await settingsRow(second.id))?.display_name, null);
  assert.equal(
    (await settingsRow(second.id))?.display_name_disclosure_version,
    null,
  );

  const erase = partnerErasure(fixture, async () => {});
  await (
    await erase.signedConfirmation(first.subscriberId)
  )();
  assert.deepEqual(await readBoard(), ['Partner']);
  assert.equal(
    (await settingsRow(first.id))?.display_name_disclosure_version,
    displayNameDisclosureVersion,
  );
  await erase.fulfil();
  assert.deepEqual(await readBoard(), ['Partner']);
  assert.equal(
    (await settingsRow(first.id))?.display_name_disclosure_version,
    null,
  );
});

test('a replacement for an earlier name qualifies under the current wording on the cached board', async () => {
  const state = scenario();
  const partner = await insertPartner(fixture, { status: 'active' });
  await insertReferral(fixture, partner.subscriberId);
  await fixture.owner.execute({
    text: "UPDATE partner SET display_name = 'Earlier Name', show_on_leaderboard = true WHERE id = $1",
    values: [partner.id],
  });
  const link = await requestLink(state, partner);
  state.advance(60 * 60 * 1000);
  await createPartnerLeaderboardJob(
    fixture.app,
    async () => true,
    state.clock,
  ).run();
  const before = await state.dashboard.read(link.bearer);
  assert.equal(before.kind, 'authenticated');
  assert.equal(before.needsNameConfirmation, true);
  assert.ok(before.leaderboard);
  const ownEntry = before.leaderboard.entries.find(
    ({ rank }) => rank === before.leaderboard?.ownRank,
  );
  assert.equal(ownEntry?.label, 'Partner');

  assert.equal(
    (
      await state.dashboard.save(
        settingsForm(before.settingsToken, 'Replacement Name', true),
        'replace-earlier-name',
      )
    ).kind,
    'saved',
  );
  assert.equal(
    (await settingsRow(partner.id))?.display_name_disclosure_version,
    displayNameDisclosureVersion,
  );
  const after = await state.dashboard.read(link.bearer);
  assert.equal(after.kind, 'authenticated');
  assert.equal(after.needsNameConfirmation, false);
  assert.equal(after.leaderboard?.asOf, before.leaderboard.asOf);
  assert.deepEqual(
    after.leaderboard?.entries.find(({ rank }) => rank === ownEntry.rank),
    { ...ownEntry, label: 'Replacement Name' },
  );
});

test('application retention clears a display name and its disclosure version together', async () => {
  const partner = await insertPartner(fixture, {
    status: 'rejected',
    at: new Date('2026-07-01T12:00:00Z'),
  });
  await fixture.owner.execute({
    text: "UPDATE partner SET display_name = 'Purged Name', display_name_disclosure_version = $2 WHERE id = $1",
    values: [partner.id, displayNameDisclosureVersion],
  });
  assert.equal(
    (await settingsRow(partner.id))?.display_name_disclosure_version,
    displayNameDisclosureVersion,
  );
  assert.equal(
    await createPartnerApplicationPurgeJob(fixture.app, {
      clock: () => initialTime,
    }).run(100),
    1,
  );
  const row = await settingsRow(partner.id);
  assert.equal(row?.display_name, null);
  assert.equal(row.display_name_disclosure_version, null);
});
