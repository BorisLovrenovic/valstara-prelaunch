// E11.7-13: the partner digest, against a real database with an injected
// clock. Asserts one digest per partner per period across a restart and
// concurrent runs, the opt-out (before queueing, between queueing and
// dispatch, and a digest unsubscribe that leaves marketing consent and the
// partner's transactional mail intact), every flag off, the cadence change as
// configuration alone, the send-time boundary, a missed window and an empty
// founder note each skipping their period with one P2, and the rendered
// message: the closed period's counts, no unverified or voided person
// counted, and no referred person named.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { emailCopy } from '../src/copy/email.ts';
import { partnersCopy } from '../src/copy/partners.ts';
import {
  ConfigurationError,
  getPartnerDigestConfiguration,
  type PartnerDigestConfiguration,
} from '../src/server/config.ts';
import { createCampaignFlagRepository } from '../src/server/db/campaign-flags.ts';
import {
  createEmailService,
  type EmailProvider,
  type Message,
  type QueueEmailInput,
} from '../src/server/email/service.ts';
import { createUnsubscribeService } from '../src/server/email/unsubscribe.ts';
import type { DatabaseConnection } from '../src/server/db/pool.ts';
import type { FlagKey } from '../src/server/flags/registry.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import {
  partnerDigestBusinessKey,
  partnerDigestTemplate,
  partnerFirstSignupTemplate,
} from '../src/server/partner/config.ts';
import {
  createPartnerDigestJob,
  partnerDigestBatchLimit,
  partnerDigestPeriodRange,
  partnerDigestWindow,
  readPartnerDigestNote,
} from '../src/server/partner/digest.ts';
import {
  partnerDigestData,
  partnerDigestRenderer,
} from '../src/server/partner/digest-template.ts';
import { createPartnerLeaderboardJob } from '../src/server/partner/leaderboard.ts';
import { partnerApplicationRenderers } from '../src/server/partner/templates.ts';
import type { AlertTransport } from '../src/server/verification-rate/p1-webhook.ts';
import {
  deriveEmailToken,
  emailTokenSecret,
} from '../src/server/verification/token-derivation.ts';
import { createVerificationService } from '../src/server/verification/service.ts';
import {
  createPartnerFixture,
  insertMember,
  insertPartner,
  insertReferral,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const actor = 'founder:test';
const secret = emailTokenSecret();
const origin = 'https://valstara.com';
const monthly: PartnerDigestConfiguration = {
  cadence: 'monthly',
  hour: 9,
  minute: 0,
};
const weekly: PartnerDigestConfiguration = {
  cadence: 'weekly',
  hour: 9,
  minute: 0,
};
const note = 'A founder note for the test.';

let fixture: PartnerFixture;

before(async () => {
  fixture = await createPartnerFixture('partner-digest');
});

after(async () => {
  await fixture?.dispose();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A clock the test moves; nothing in a test path reads the system time. */
function testClock(start: string) {
  let now = new Date(start);
  return {
    clock: () => now,
    set(at: string) {
      now = new Date(at);
    },
  };
}

function alertRecorder() {
  const sent: Parameters<AlertTransport['send']>[0][] = [];
  const transport: AlertTransport = {
    async send(alert) {
      sent.push(alert);
    },
  };
  return { sent, transport };
}

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

function emailService(
  clock: () => Date,
  sent: Message[] = [],
  options: {
    readonly broadcast?: boolean;
    readonly note?: () => string | null;
    readonly failed?: string[];
  } = {},
) {
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
        welcomeCode: async () => null,
      }),
      [
        partnerDigestTemplate,
        partnerDigestRenderer({
          baseUrl: origin,
          sendingDomain: 'mail.valstara.com',
          data: partnerDigestData(fixture.app),
          note: options.note ?? (() => note),
        }),
      ],
    ]),
    isBroadcastEnabled: async () => options.broadcast ?? true,
    operatorTask: async ({ code }) => {
      if (options.failed === undefined)
        assert.fail(`unexpected failed email: ${code}`);
      options.failed.push(code);
    },
  });
}

async function setFlag(key: FlagKey, on: boolean) {
  await createCampaignFlagRepository(fixture.app).set(key, on, actor);
}

async function flagsOn() {
  await setFlag('partners.enabled', true);
  await setFlag('partners.digest', true);
  await setFlag('email.broadcast', true);
}

function digestJob(
  clock: () => Date,
  alerts: AlertTransport,
  options: {
    readonly schedule?: PartnerDigestConfiguration;
    readonly note?: () => string | null;
    readonly queue?: (
      input: QueueEmailInput,
      connection: DatabaseConnection,
    ) => Promise<boolean>;
  } = {},
) {
  const service = emailService(clock);
  return createPartnerDigestJob({
    database: fixture.app,
    // A fresh service per job: it reads the database, with code defaults.
    flags: createFlagService(fixture.app),
    email: {
      queue:
        options.queue ??
        ((input, connection) => service.queue(input, connection)),
    },
    alerts,
    clock,
    schedule: options.schedule ?? monthly,
    note: options.note ?? (() => note),
    tokenSecret: secret,
  });
}

/** Removes every earlier test's digest state, so each test starts clean. */
async function resetDigestState() {
  await fixture.owner.execute({ text: 'DELETE FROM partner_digest_run' });
  await fixture.owner.execute({ text: 'DELETE FROM partner_digest_schedule' });
  await fixture.owner.execute({
    text: `UPDATE email_send SET state = 'failed', last_error = 'test_reset'
      WHERE template = $1 AND state = 'queued'`,
    values: [partnerDigestTemplate],
  });
  await fixture.owner.execute({
    text: 'UPDATE partner SET nonessential_email_enabled = false',
  });
}

async function digestPartner(
  options: { readonly optedIn?: boolean; readonly marketing?: boolean } = {},
) {
  const partner = await insertPartner(fixture, {
    status: 'active',
    marketing: options.marketing ?? false,
  });
  if (options.optedIn ?? true) {
    await fixture.owner.execute({
      text: 'UPDATE partner SET nonessential_email_enabled = true WHERE id = $1',
      values: [partner.id],
    });
  }
  return partner;
}

async function rows(businessKey: string) {
  return fixture.owner.list<{
    id: string;
    template: string;
    provider: string;
    state: string;
    last_error: string | null;
    payload: Record<string, string>;
    unsubscribe_token_id: string;
    expires_at: Date | null;
  }>(
    {
      text: `SELECT id, template, provider, state, last_error, payload,
        unsubscribe_token_id, expires_at
        FROM email_send WHERE business_key = $1`,
      values: [businessKey],
    },
    10,
  );
}

async function digestRows(period: string) {
  return fixture.owner.list<{ business_key: string; state: string }>(
    {
      text: `SELECT business_key, state FROM email_send
        WHERE template = $1 AND business_key LIKE 'partner-digest:' || $2 || ':%'`,
      values: [partnerDigestTemplate, period],
    },
    1_000,
  );
}

async function runRecord(period: string) {
  return fixture.owner.readOne<{
    state: string;
    skip_reason: string | null;
    alerted_at: Date | null;
  }>({
    text: 'SELECT state, skip_reason, alerted_at FROM partner_digest_run WHERE period = $1',
    values: [period],
  });
}

// ── Schedule and configuration ──────────────────────────────────────────────

test('the monthly window opens on the 1st at the send time and reports the previous UTC month', () => {
  const early = partnerDigestWindow(
    new Date('2026-12-01T08:59:59.999Z'),
    monthly,
  );
  assert.equal(early.period, '2026-11');
  assert.equal(early.startsAt.toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(early.endsAt.toISOString(), '2026-12-02T09:00:00.000Z');
  assert.equal(early.reportStart.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(early.reportEnd.toISOString(), '2026-12-01T00:00:00.000Z');
  // Across the year boundary: January's window reports December.
  const january = partnerDigestWindow(
    new Date('2027-01-15T12:00:00.000Z'),
    monthly,
  );
  assert.equal(january.period, '2026-12');
  assert.equal(january.startsAt.toISOString(), '2027-01-01T09:00:00.000Z');
  assert.deepEqual(partnerDigestPeriodRange('2026-12'), {
    start: new Date('2026-12-01T00:00:00.000Z'),
    end: new Date('2027-01-01T00:00:00.000Z'),
    label: { kind: 'month', year: 2026, month: 11 },
  });
});

test('the weekly window opens on Monday at the send time and reports the previous ISO week', () => {
  const window = partnerDigestWindow(
    new Date('2026-12-09T12:00:00.000Z'),
    weekly,
  );
  assert.equal(window.period, '2026-W49');
  assert.equal(window.startsAt.toISOString(), '2026-12-07T09:00:00.000Z');
  assert.equal(window.reportStart.toISOString(), '2026-11-30T00:00:00.000Z');
  assert.equal(window.reportEnd.toISOString(), '2026-12-07T00:00:00.000Z');
  // The first Monday of 2027 reports 2026's 53rd ISO week.
  const yearEnd = partnerDigestWindow(
    new Date('2027-01-04T09:00:00.000Z'),
    weekly,
  );
  assert.equal(yearEnd.period, '2026-W53');
  assert.deepEqual(partnerDigestPeriodRange('2026-W53'), {
    start: new Date('2026-12-28T00:00:00.000Z'),
    end: new Date('2027-01-04T00:00:00.000Z'),
    label: { kind: 'week', year: 2026, week: 53 },
  });
  assert.throws(() => partnerDigestPeriodRange('2027-W53'));
  assert.throws(() => partnerDigestPeriodRange('2026-13'));
});

test('the cadence and send time are validated configuration, and boot rejects any other cadence', () => {
  assert.deepEqual(getPartnerDigestConfiguration({}), monthly);
  assert.deepEqual(
    getPartnerDigestConfiguration({
      PARTNER_DIGEST_CADENCE: 'weekly',
      PARTNER_DIGEST_SEND_UTC: '07:30',
    }),
    { cadence: 'weekly', hour: 7, minute: 30 },
  );
  for (const cadence of ['daily', 'Monthly', 'quarterly'])
    assert.throws(
      () => getPartnerDigestConfiguration({ PARTNER_DIGEST_CADENCE: cadence }),
      (error) =>
        error instanceof ConfigurationError &&
        error.variableName === 'PARTNER_DIGEST_CADENCE',
    );
  for (const time of ['24:00', '9:00', '09:60'])
    assert.throws(
      () => getPartnerDigestConfiguration({ PARTNER_DIGEST_SEND_UTC: time }),
      (error) =>
        error instanceof ConfigurationError &&
        error.variableName === 'PARTNER_DIGEST_SEND_UTC',
    );
});

test('the founder note ships with no text, and a note file must be exactly one note string', async () => {
  assert.equal(readPartnerDigestNote(), null);
  const directory = await mkdtemp(join(tmpdir(), 'partner-digest-note-'));
  try {
    const path = join(directory, 'note.json');
    await writeFile(path, JSON.stringify({ note: '  A short note.  ' }));
    assert.equal(readPartnerDigestNote(path), 'A short note.');
    await writeFile(path, JSON.stringify({ note: '   ' }));
    assert.equal(readPartnerDigestNote(path), null);
    for (const invalid of [{ note: 1 }, { note: 'x', extra: true }, ['x']]) {
      await writeFile(path, JSON.stringify(invalid));
      assert.throws(() => readPartnerDigestNote(path), /note_invalid/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ── Once per period ─────────────────────────────────────────────────────────

test('one digest per partner per period across the send-time boundary, a restart and concurrent runs', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2026-12-01T08:59:59.999Z');
  const alerts = alertRecorder();
  const partners = [
    await digestPartner(),
    await digestPartner(),
    await digestPartner(),
  ];

  // Before the send time nothing is queued.
  assert.deepEqual(await digestJob(time.clock, alerts.transport).run(), {
    queued: 0,
    state: 'early',
  });
  assert.deepEqual(await digestRows('2026-11'), []);

  // The worker fails after one queue: a crash part-way through the run.
  time.set('2026-12-01T09:00:00.000Z');
  const service = emailService(time.clock);
  let calls = 0;
  await assert.rejects(
    digestJob(time.clock, alerts.transport, {
      queue: async (input, connection) => {
        calls += 1;
        if (calls > 1) throw new Error('worker stopped');
        return service.queue(input, connection);
      },
    }).run(),
    /worker stopped/u,
  );
  assert.equal((await digestRows('2026-11')).length, 1);
  assert.equal((await runRecord('2026-11'))?.state, 'started');

  // A restarted worker (a new job instance) finishes the run once.
  time.set('2026-12-01T10:00:00.000Z');
  const resumed = await digestJob(time.clock, alerts.transport).run(1);
  assert.deepEqual(resumed, { queued: 2, state: 'completed' });
  for (const partner of partners) {
    const queued = await rows(partnerDigestBusinessKey('2026-11', partner.id));
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.provider, 'brevo');
    assert.deepEqual(Object.keys(queued[0]!.payload).sort(), [
      'period',
      'status_token_id',
    ]);
    assert.equal(queued[0]?.payload.period, '2026-11');
    assert.equal(
      queued[0]?.expires_at?.toISOString(),
      '2026-12-02T09:00:00.000Z',
    );
  }

  // Later hourly runs, concurrent ones included, queue nothing more.
  time.set('2026-12-01T11:00:00.000Z');
  const reruns = await Promise.all([
    digestJob(time.clock, alerts.transport).run(),
    digestJob(time.clock, alerts.transport).run(),
    digestJob(time.clock, alerts.transport).run(),
  ]);
  assert.deepEqual(
    reruns.map((result) => result.queued),
    [0, 0, 0],
  );
  assert.equal((await digestRows('2026-11')).length, 3);

  // Dispatch sends each once; a later run after the window stays completed.
  const sent: Message[] = [];
  assert.equal((await emailService(time.clock, sent).dispatch(100)).sent, 3);
  time.set('2026-12-05T09:00:00.000Z');
  assert.deepEqual(await digestJob(time.clock, alerts.transport).run(), {
    queued: 0,
    state: 'completed',
  });
  assert.deepEqual(alerts.sent, []);
  for (const bad of [0, partnerDigestBatchLimit + 1, 1.5])
    await assert.rejects(
      digestJob(time.clock, alerts.transport).run(bad),
      RangeError,
    );
});

test('concurrent first runs in a fresh window queue each partner exactly once', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2027-01-01T09:00:00.000Z');
  const alerts = alertRecorder();
  const partners = await Promise.all(
    Array.from({ length: 4 }, () => digestPartner()),
  );
  const results = await Promise.all([
    digestJob(time.clock, alerts.transport).run(1),
    digestJob(time.clock, alerts.transport).run(1),
    digestJob(time.clock, alerts.transport).run(1),
  ]);
  assert.equal(
    results.reduce((sum, result) => sum + result.queued, 0),
    partners.length,
  );
  for (const partner of partners)
    assert.equal(
      (await rows(partnerDigestBusinessKey('2026-12', partner.id))).length,
      1,
    );
});

// ── Missed windows and the founder note ─────────────────────────────────────

test('a missed window skips its period, records it and raises one P2, with no late send', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2027-02-15T12:00:00.000Z');
  const alerts = alertRecorder();
  const partner = await digestPartner();
  // The schedule takes effect mid-February; February 1st was never owed.
  assert.deepEqual(await digestJob(time.clock, alerts.transport).run(), {
    queued: 0,
    state: 'not_due',
  });
  assert.equal(await runRecord('2027-01'), null);

  // The worker is down for the whole of the 1 March window.
  time.set('2027-03-02T09:00:00.000Z');
  assert.deepEqual(await digestJob(time.clock, alerts.transport).run(), {
    queued: 0,
    state: 'skipped',
  });
  assert.deepEqual(await runRecord('2027-02'), {
    state: 'skipped',
    skip_reason: 'missed_window',
    alerted_at: time.clock(),
  });
  assert.deepEqual(
    alerts.sent.map(({ event, severity, detail }) => ({
      event,
      severity,
      detail,
    })),
    [
      {
        event: 'partner_digest_period_skipped',
        severity: 'P2',
        detail: { period: '2027-02', reason: 'missed_window' },
      },
    ],
  );
  assert.deepEqual(
    await rows(partnerDigestBusinessKey('2027-02', partner.id)),
    [],
  );

  // Later runs neither send it late nor alert again; the next period sends.
  time.set('2027-03-10T09:00:00.000Z');
  await digestJob(time.clock, alerts.transport).run();
  time.set('2027-04-01T09:30:00.000Z');
  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 1);
  assert.equal(alerts.sent.length, 1);
  await emailService(time.clock).dispatch(100);
  assert.deepEqual(
    await rows(partnerDigestBusinessKey('2027-02', partner.id)),
    [],
  );

  // An earlier window found unsent when a later one runs is also recorded.
  time.set('2027-06-01T10:00:00.000Z');
  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 1);
  assert.equal((await runRecord('2027-04'))?.skip_reason, 'missed_window');
  assert.deepEqual(
    alerts.sent.slice(1).map(({ detail }) => detail),
    [{ period: '2027-04', reason: 'missed_window' }],
  );
});

test('an empty founder note skips the period with one P2, and a note added later does not revive it', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2027-07-01T09:00:00.000Z');
  const alerts = alertRecorder();
  const partner = await digestPartner();
  let current: string | null = null;
  const job = () =>
    digestJob(time.clock, alerts.transport, { note: () => current });
  assert.deepEqual(await job().run(), { queued: 0, state: 'skipped' });
  assert.equal((await runRecord('2027-06'))?.skip_reason, 'note_missing');
  assert.deepEqual(
    alerts.sent.map(({ severity, detail }) => ({ severity, detail })),
    [{ severity: 'P2', detail: { period: '2027-06', reason: 'note_missing' } }],
  );
  current = note;
  time.set('2027-07-01T10:00:00.000Z');
  assert.deepEqual(await job().run(), { queued: 0, state: 'skipped' });
  assert.equal(alerts.sent.length, 1);
  assert.deepEqual(
    await rows(partnerDigestBusinessKey('2027-06', partner.id)),
    [],
  );
});

// ── Opt-out ─────────────────────────────────────────────────────────────────

test('a partner who opted out before queueing receives none, nor does any other ineligible partner', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2027-08-01T09:00:00.000Z');
  const alerts = alertRecorder();
  const optedIn = await digestPartner();
  const optedOut = await digestPartner({ optedIn: false });
  const paused = await digestPartner();
  await fixture.owner.execute({
    text: "UPDATE partner SET status = 'paused', status_changed_at = $2 WHERE id = $1",
    values: [paused.id, time.clock()],
  });
  const suppressed = await digestPartner();
  await fixture.owner.execute({
    text: "INSERT INTO suppression (email_normalised, reason, source) VALUES (lower($1), 'complaint', 'brevo')",
    values: [suppressed.email],
  });
  // Marketing consent is neither required nor enough (D-071).
  const marketingOnly = await digestPartner({
    optedIn: false,
    marketing: true,
  });

  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 1);
  assert.equal(
    (await rows(partnerDigestBusinessKey('2027-07', optedIn.id))).length,
    1,
  );
  for (const partner of [optedOut, paused, suppressed, marketingOnly])
    assert.deepEqual(
      await rows(partnerDigestBusinessKey('2027-07', partner.id)),
      [],
    );
});

test('an opt-out written between queueing and dispatch stops the send', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2027-09-01T09:00:00.000Z');
  const alerts = alertRecorder();
  const optingOut = await digestPartner();
  const terminated = await digestPartner();
  const staying = await digestPartner();
  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 3);

  await fixture.owner.execute({
    text: 'UPDATE partner SET nonessential_email_enabled = false WHERE id = $1',
    values: [optingOut.id],
  });
  await fixture.owner.execute({
    text: "UPDATE partner SET status = 'terminated', status_changed_at = $2 WHERE id = $1",
    values: [terminated.id, time.clock()],
  });
  const sent: Message[] = [];
  const summary = await emailService(time.clock, sent).dispatch(100);
  assert.equal(summary.sent, 1);
  assert.equal(summary.suppressed, 2);
  assert.deepEqual(
    sent.map((message) => message.to),
    [staying.email],
  );
  for (const partner of [optingOut, terminated]) {
    const [row] = await rows(partnerDigestBusinessKey('2027-08', partner.id));
    assert.equal(row?.state, 'failed');
    assert.equal(row?.last_error, 'recipient_ineligible');
  }
});

test('a digest unsubscribe turns off only the optional-email choice; marketing consent, the waitlist place and transactional mail stay', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2027-10-01T09:00:00.000Z');
  const alerts = alertRecorder();
  const partner = await digestPartner({ marketing: true });
  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 1);
  const [row] = await rows(partnerDigestBusinessKey('2027-09', partner.id));
  assert.ok(row);
  const failures: unknown[] = [];
  const unsubscribe = createUnsubscribeService(fixture.app, {
    clock: time.clock,
    tokenSecret: secret,
    onFailure: async (failure) => {
      failures.push(failure);
    },
  });
  assert.equal(
    await unsubscribe.apply({
      token: deriveEmailToken(row.unsubscribe_token_id, secret),
      action: 'message_unsubscribe',
      ipPrefixHash: 'test-prefix',
    }),
    'accepted',
  );
  assert.deepEqual(failures, []);

  const state = await fixture.owner.readOne<{
    nonessential_email_enabled: boolean;
    status: string;
    marketing: boolean;
    suppressed: boolean;
  }>({
    text: `SELECT p.nonessential_email_enabled, s.status,
        s.marketing_consent_at IS NOT NULL AS marketing,
        EXISTS (SELECT 1 FROM suppression x WHERE x.email_normalised = s.email_normalised) AS suppressed
      FROM partner p JOIN subscriber s ON s.id = p.subscriber_id WHERE p.id = $1`,
    values: [partner.id],
  });
  assert.deepEqual(state, {
    nonessential_email_enabled: false,
    status: 'verified',
    marketing: true,
    suppressed: false,
  });
  const audit = await fixture.owner.list<{
    action: string;
    actor: string;
    subject_type: string;
    detail: Record<string, string>;
  }>(
    {
      text: `SELECT action, actor, subject_type, detail FROM audit_log
        WHERE subject_id = $1 ORDER BY at`,
      values: [partner.subscriberId],
    },
    10,
  );
  assert.deepEqual(audit, [
    {
      action: 'partner.optional_email_withdrawn',
      actor: 'subscriber',
      subject_type: 'subscriber',
      detail: { source_template: partnerDigestTemplate, send_id: row.id },
    },
  ]);

  // The queued digest itself no longer goes out, and the next one is not queued.
  const sent: Message[] = [];
  await emailService(time.clock, sent).dispatch(100);
  assert.equal(sent.length, 0);
  time.set('2027-11-01T09:00:00.000Z');
  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 0);

  // The partner's transactional mail still reaches them.
  const status = await createVerificationService(fixture.app, {
    clock: time.clock,
    tokenSecret: secret,
  }).issue(partner.subscriberId, 'status');
  const service = emailService(time.clock, sent);
  assert.equal(
    await service.queue({
      template: partnerFirstSignupTemplate,
      subscriberId: partner.subscriberId,
      businessKey: `test-transactional:${partner.id}`,
      provider: 'resend',
      payload: { status_token_id: status.id },
    }),
    true,
  );
  assert.equal((await service.dispatch(100)).sent, 1);
  assert.deepEqual(
    sent.map((message) => message.to),
    [partner.email],
  );

  // A replay of the same link changes nothing more.
  assert.equal(
    await unsubscribe.apply({
      token: deriveEmailToken(row.unsubscribe_token_id, secret),
      action: 'message_unsubscribe',
      ipPrefixHash: 'test-prefix',
    }),
    'already',
  );
});

test('leaving the waitlist from a digest’s confirmation page still suppresses globally', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2027-12-01T09:00:00.000Z');
  const alerts = alertRecorder();
  const partner = await digestPartner({ marketing: true });
  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 1);
  const [row] = await rows(partnerDigestBusinessKey('2027-11', partner.id));
  assert.ok(row);
  assert.equal(
    await createUnsubscribeService(fixture.app, {
      clock: time.clock,
      tokenSecret: secret,
      onFailure: async () => assert.fail('unsubscribe failed'),
    }).apply({
      token: deriveEmailToken(row.unsubscribe_token_id, secret),
      action: 'leave_waitlist',
      ipPrefixHash: 'test-prefix',
    }),
    'accepted',
  );
  const state = await fixture.owner.readOne<{
    status: string;
    suppressed: boolean;
  }>({
    text: `SELECT s.status, EXISTS (SELECT 1 FROM suppression x
        WHERE x.email_normalised = s.email_normalised) AS suppressed
      FROM subscriber s WHERE s.id = $1`,
    values: [partner.subscriberId],
  });
  assert.deepEqual(state, { status: 'unsubscribed', suppressed: true });
});

// ── Flags ───────────────────────────────────────────────────────────────────

test('with any of the three flags off nothing is queued, and a flag turned off after queueing stops the send', async () => {
  const time = testClock('2028-01-01T09:00:00.000Z');
  const alerts = alertRecorder();
  for (const key of [
    'partners.enabled',
    'partners.digest',
    'email.broadcast',
  ] as const) {
    await resetDigestState();
    await flagsOn();
    await digestPartner();
    await setFlag(key, false);
    assert.deepEqual(await digestJob(time.clock, alerts.transport).run(), {
      queued: 0,
      state: 'paused',
    });
    assert.deepEqual(await digestRows('2027-12'), []);
    assert.equal(await runRecord('2027-12'), null);
  }
  assert.deepEqual(alerts.sent, []);

  // The registry's code default keeps the digest off.
  await resetDigestState();
  await flagsOn();
  await fixture.owner.execute({
    text: "DELETE FROM campaign_flag WHERE key = 'partners.digest'",
  });
  assert.equal(
    (await digestJob(time.clock, alerts.transport).run()).state,
    'paused',
  );

  // Queued, then the digest flag goes off: dispatch sends nothing.
  await flagsOn();
  const partner = await digestPartner();
  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 1);
  await setFlag('partners.digest', false);
  const sent: Message[] = [];
  await emailService(time.clock, sent).dispatch(100);
  assert.deepEqual(sent, []);
  const [row] = await rows(partnerDigestBusinessKey('2027-12', partner.id));
  assert.equal(row?.last_error, 'recipient_ineligible');

  // Queued, then email.broadcast goes off: the broadcast waits unsent.
  await resetDigestState();
  await flagsOn();
  const waiting = await digestPartner();
  time.set('2028-02-01T09:00:00.000Z');
  assert.equal((await digestJob(time.clock, alerts.transport).run()).queued, 1);
  const paused = await emailService(time.clock, sent, {
    broadcast: false,
  }).dispatch(100);
  assert.ok(paused.broadcastPaused >= 1);
  assert.deepEqual(sent, []);
  assert.equal(
    (await rows(partnerDigestBusinessKey('2028-01', waiting.id)))[0]?.state,
    'queued',
  );
});

// ── The cadence change ──────────────────────────────────────────────────────

test('switching to weekly is a configuration change: no earlier week is reported missed, and the next Monday sends', async () => {
  await resetDigestState();
  await flagsOn();
  const time = testClock('2028-03-01T09:00:00.000Z');
  const alerts = alertRecorder();
  const partner = await digestPartner();
  assert.equal(
    (await digestJob(time.clock, alerts.transport, { schedule: monthly }).run())
      .queued,
    1,
  );
  await emailService(time.clock).dispatch(100);

  // Mid-week, the founder switches the configuration to weekly.
  time.set('2028-03-08T12:00:00.000Z');
  const weeklyJob = () =>
    digestJob(time.clock, alerts.transport, {
      schedule: getPartnerDigestConfiguration({
        PARTNER_DIGEST_CADENCE: 'weekly',
      }),
    });
  assert.deepEqual(await weeklyJob().run(), { queued: 0, state: 'not_due' });
  time.set('2028-03-13T08:59:00.000Z');
  assert.deepEqual(await weeklyJob().run(), { queued: 0, state: 'early' });
  time.set('2028-03-13T09:00:00.000Z');
  assert.deepEqual(await weeklyJob().run(), { queued: 1, state: 'completed' });
  const [row] = await rows(partnerDigestBusinessKey('2028-W10', partner.id));
  assert.equal(row?.payload.period, '2028-W10');
  assert.deepEqual(alerts.sent, [], 'no earlier week is reported missed');
  assert.equal(
    (
      await fixture.owner.readOne<{ count: string }>({
        text: `SELECT count(*)::text AS count FROM partner_digest_run WHERE state = 'skipped'`,
      })
    )?.count,
    '0',
  );
});

// ── Rendering ───────────────────────────────────────────────────────────────

test('the rendered digest reports the closed period from confirmed people only and names no one', async () => {
  // A database of its own, so the waitlist totals are exact.
  const own = await createPartnerFixture('partner-digest-render');
  try {
    const time = testClock('2028-05-01T09:00:00.000Z');
    const alerts = alertRecorder();
    for (const key of [
      'partners.enabled',
      'partners.digest',
      'email.broadcast',
    ] as const)
      await createCampaignFlagRepository(own.app).set(key, true, actor);
    const partner = await insertPartner(own, { status: 'active' });
    const rival = await insertPartner(own, { status: 'active' });
    await own.owner.execute({
      text: 'UPDATE partner SET nonessential_email_enabled = true WHERE id = $1',
      values: [partner.id],
    });
    const april = (day: number) =>
      new Date(`2028-04-${String(day).padStart(2, '0')}T10:00:00.000Z`);
    // Confirmed in April (2), confirmed in March (1), voided (1), pending (1).
    const inPeriod = [
      await insertReferral(own, partner.subscriberId, {
        createdAt: april(2),
        confirmedAt: april(3),
        email: 'friend-one@example.test',
      }),
      await insertReferral(own, partner.subscriberId, {
        createdAt: april(10),
        confirmedAt: april(11),
        email: 'friend-two@example.test',
      }),
    ];
    const earlier = await insertReferral(own, partner.subscriberId, {
      createdAt: new Date('2028-03-05T10:00:00.000Z'),
      email: 'friend-three@example.test',
    });
    await insertReferral(own, partner.subscriberId, {
      createdAt: april(12),
      confirmedAt: april(13),
      voided: true,
      email: 'friend-voided@example.test',
    });
    await insertReferral(own, partner.subscriberId, {
      state: 'attributed',
      createdAt: april(14),
      email: 'friend-pending@example.test',
    });
    // The rival ranks first with four confirmed signups.
    for (let index = 0; index < 4; index += 1)
      await insertReferral(own, rival.subscriberId, {
        createdAt: new Date('2028-03-10T10:00:00.000Z'),
      });
    for (const [friend, categories] of [
      [inPeriod[0]!, ['ai', 'software']],
      [earlier, ['ai']],
    ] as const)
      await own.owner.execute({
        text: 'INSERT INTO survey_response (id, subscriber_id, version, answers, first_answered_at) VALUES ($1, $2, $3, $4, $5)',
        values: [
          randomUUID(),
          friend.referredId,
          '2026-10-19',
          { category_preference: categories },
          april(20),
        ],
      });
    // Waitlist: verified in April and earlier, and an unverified person.
    await insertMember(own, { at: april(20) });
    await insertMember(own, { status: 'pending', at: april(21) });
    // Friends verify when they confirm; the rest verified in November 2026.
    for (const [friend, at] of [
      [inPeriod[0]!, april(3)],
      [inPeriod[1]!, april(11)],
    ] as const)
      await own.owner.execute({
        text: 'UPDATE subscriber SET verified_at = $2 WHERE id = $1',
        values: [friend.referredId, at],
      });
    // Verified: two partners, four of the partner's friends, four of the
    // rival's and the April member. The pending friend and member are not.
    const verified = { total: 11, april: 3 };

    await createPartnerLeaderboardJob(
      own.app,
      async () => true,
      time.clock,
    ).run();

    const sent: Message[] = [];
    const service = createEmailService(own.app, {
      clock: time.clock,
      tokenSecret: secret,
      baseUrl: origin,
      providers: new Map([
        ['brevo', provider('brevo', 'mail.valstara.com', sent)],
      ]),
      renderers: new Map([
        [
          partnerDigestTemplate,
          partnerDigestRenderer({
            baseUrl: origin,
            sendingDomain: 'mail.valstara.com',
            data: partnerDigestData(own.app),
            note: () => note,
          }),
        ],
      ]),
      isBroadcastEnabled: async () => true,
      operatorTask: async ({ code }) => assert.fail(code),
    });
    const job = createPartnerDigestJob({
      database: own.app,
      flags: {
        async isEnabled() {
          return true;
        },
      },
      email: { queue: (input, connection) => service.queue(input, connection) },
      alerts: alerts.transport,
      clock: time.clock,
      schedule: monthly,
      note: () => note,
      tokenSecret: secret,
    });
    assert.deepEqual(await job.run(), { queued: 1, state: 'completed' });
    assert.equal((await service.dispatch(100)).sent, 1);
    const [message] = sent;
    assert.ok(message);
    const copy = partnersCopy.email.digest;
    assert.equal(message.to, partner.email);
    assert.equal(
      message.from,
      `${emailCopy.senderName} <hello@mail.valstara.com>`,
    );
    assert.equal(message.subject, copy.subject('April 2028'));
    const html = message.html ?? '';
    const lines = [
      copy.firstLine('April 2028'),
      copy.noteHeading,
      note,
      copy.confirmedInPeriod('April 2028', 2),
      copy.confirmedTotal(3),
      copy.categories,
      copy.category('AI tools', 2),
      copy.category('Software', 1),
      copy.category('Game keys', 0),
      copy.waitlistInPeriod('April 2028', verified.april),
      copy.waitlistTotal(verified.total),
      copy.choice,
    ];
    for (const line of lines) {
      assert.ok(message.text.includes(line), `text: ${line}`);
      assert.ok(
        html.includes(line.replaceAll('&', '&amp;').replaceAll("'", '&#39;')),
        `html: ${line}`,
      );
    }
    assert.match(
      message.text,
      /Your partner leaderboard rank: 2 \(as of May 1, 2028, 09:00 AM UTC\)/u,
    );
    // It links the replacement request and /me, and issues no dashboard link.
    assert.ok(
      message.text.includes(
        `${origin}/partners/apply?operation=dashboard-recovery`,
      ),
    );
    assert.match(message.text, /https:\/\/valstara\.com\/me\?t=/u);
    assert.doesNotMatch(`${message.text}${html}`, /partners\/dashboard\?t=/u);
    // No referred person appears, by address or by name.
    for (const address of [
      'friend-one@example.test',
      'friend-two@example.test',
      'friend-three@example.test',
      'friend-voided@example.test',
      'friend-pending@example.test',
    ]) {
      assert.ok(!message.text.includes(address), address);
      assert.ok(!html.includes(address), address);
    }
    const names = await own.owner.list<{ full_name: string }>(
      {
        text: 'SELECT full_name FROM partner WHERE id = $1',
        values: [rival.id],
      },
      1,
    );
    assert.ok(!`${message.text}${html}`.includes(names[0]!.full_name));

    // A missing note at dispatch fails the send rather than sending without it.
    const failed: string[] = [];
    const withoutNote = createEmailService(own.app, {
      clock: time.clock,
      tokenSecret: secret,
      baseUrl: origin,
      providers: new Map([
        ['brevo', provider('brevo', 'mail.valstara.com', sent)],
      ]),
      renderers: new Map([
        [
          partnerDigestTemplate,
          partnerDigestRenderer({
            baseUrl: origin,
            sendingDomain: 'mail.valstara.com',
            data: partnerDigestData(own.app),
            note: () => null,
          }),
        ],
      ]),
      isBroadcastEnabled: async () => true,
      operatorTask: async ({ code }) => {
        failed.push(code);
      },
    });
    time.set('2028-06-01T09:00:00.000Z');
    assert.equal(
      (
        await createPartnerDigestJob({
          database: own.app,
          flags: { isEnabled: async () => true },
          email: {
            queue: (input, connection) => withoutNote.queue(input, connection),
          },
          alerts: alerts.transport,
          clock: time.clock,
          schedule: monthly,
          note: () => note,
          tokenSecret: secret,
        }).run()
      ).queued,
      1,
    );
    sent.length = 0;
    await withoutNote.dispatch(100);
    assert.deepEqual(sent, []);
    assert.deepEqual(failed, ['render_failed']);
  } finally {
    await own.dispose();
  }
});
