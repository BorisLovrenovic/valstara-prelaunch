// E11.7-05: the partner application, against a real database. The Tests line:
// Turnstile-first and rate limit · the field schema · each conditional rule ·
// the refused code (the no-JavaScript round trip itself is in
// test/partner-pages-rendered.test.mjs) · confirmation creating or linking a
// member · unconfirmed expiry · DSR reconciliation · the purge · flag off.
// The forbidden-copy red path is the `partner-copy-forbidden` entry of
// test/fixtures/security/gates.json.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { eventRegistry } from '../src/server/analytics/registry.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createFraudFlagRepository } from '../src/server/db/fraud-flag.ts';
import { partnerPurgeBatchLimit } from '../src/server/db/partner.ts';
import { createPartnerRepository } from '../src/server/db/partner.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createPurgeJobRunRepository } from '../src/server/db/purge-job-run.ts';
import { subjectExportTables } from '../src/server/db/dsr-export.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { exportSubject } from '../src/server/dsr/export.ts';
import { createErasureService } from '../src/server/dsr/service.ts';
import {
  createPartnerApplicationHandler,
  createPartnerSubmitService,
  partnerConfirmationBusinessKey,
  partnerReceivedBusinessKey,
  type PartnerApplicationHandlerDependencies,
} from '../src/server/partner/application.ts';
import {
  partnerApplicationIpLimit,
  partnerApplicationIpWindowMs,
  partnerApplicationStrictIpLimit,
} from '../src/server/partner/config.ts';
import { createPartnerConfirmationService } from '../src/server/partner/confirm.ts';
import {
  parsePartnerApplication,
  partnerApplicationFieldNames,
  readPartnerApplicationValues,
} from '../src/server/partner/fields.ts';
import { createPartnerApplicationPurgeJob } from '../src/server/partner/retention.ts';
import { createPartnerCodeRules } from '../src/server/referral/partner-code.ts';
import { consumeRateLimit } from '../src/server/ratelimit/consume.ts';
import { createUnverifiedExpiryJob } from '../src/server/subscriber/expiry.ts';
import { createFinalReminderJob } from '../src/server/subscriber/final-reminder.ts';
import { createRecordedPurgeJob } from '../src/server/subscriber/purge-run.ts';
import { createVerificationReminderJob } from '../src/server/subscriber/reminder.ts';
import type { TurnstileOutcome } from '../src/server/turnstile/verify.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const DAY_MS = 24 * 60 * 60 * 1_000;
const submittedAt = new Date('2026-11-22T10:00:00.000Z');
const giveawayRules = {
  rulesVersion: 'VAL-GW-LAUNCH-20261009-r1',
  sha256: 'd35678f459daa99560613337a923b7f2cb5f0347fceae3d77a1ad67bc8b908e4',
};

interface Fixture {
  readonly owner: DatabasePool;
  readonly app: DatabasePool;
  dispose(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const name = `valstara_e1175_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword,
    release: 'e11-7-05-test',
  });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    async dispose() {
      await app.close();
      await owner.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [name],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${name}"` });
      await admin.close();
    },
  };
}

function applicationForm(
  overrides: Record<string, string | readonly string[] | null> = {},
): FormData {
  const fields: Record<string, string | readonly string[] | null> = {
    turnstile_token: 'turnstile-ok',
    full_name: 'Maya Example',
    email_address: 'maya@example.test',
    country_of_residence: 'SE',
    partner_type: 'creator',
    channels: ['tiktok', 'youtube'],
    handles: '@maya, https://youtube.example/@maya',
    audience_size: '10k_50k',
    promotion_plan: 'Short videos comparing subscription prices.',
    requested_code: 'MAYA',
    age_confirmed: 'yes',
    programme_terms_agreed: 'yes',
    ...overrides,
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) continue;
    for (const entry of typeof value === 'string' ? [value] : value)
      form.append(key, entry);
  }
  return form;
}

const allowAll = async () => ({ flags: [] as const });

function realHandler(
  fixture: Fixture,
  overrides: Partial<PartnerApplicationHandlerDependencies> & {
    readonly turnstile?: TurnstileOutcome;
    readonly clock?: () => Date;
  } = {},
) {
  const clock = overrides.clock ?? (() => submittedAt);
  return createPartnerApplicationHandler({
    verifyTurnstile: async () => overrides.turnstile ?? 'verified',
    isEnabled: async () => true,
    hashIpPrefix: (address) =>
      createHash('sha256').update(`prefix:${address}`).digest(),
    consumeIpRateLimit: (prefixHash, now, strict) =>
      consumeRateLimit(
        fixture.app,
        `partner:apply:ip:${strict ? 'strict:' : ''}${prefixHash}`,
        partnerApplicationIpWindowMs,
        now,
      ),
    checkCode: (requested) =>
      createPartnerCodeRules(fixture.app).check(requested),
    submit: createPartnerSubmitService(fixture.app, {
      clock,
      screenEmailDomain: allowAll,
      raiseFraudFlag: async () => undefined,
      async flagChallengeTimeout(subscriberId) {
        await createFraudFlagRepository(fixture.app).insertChallengeTimeoutFlag(
          { id: randomUUID(), subscriberId },
        );
      },
    }),
    clock,
    monotonicClock: () => 0,
    sleep: async () => undefined,
    ...overrides,
  });
}

function confirmation(
  fixture: Fixture,
  options: {
    readonly clock?: () => Date;
    readonly enabled?: () => boolean;
    readonly giveawayOpen?: boolean;
  } = {},
) {
  const clock = options.clock ?? (() => submittedAt);
  return createPartnerConfirmationService(fixture.app, {
    clock,
    isEnabled: async () => options.enabled?.() ?? true,
    consumeIpRateLimit: (prefixHash, now) =>
      consumeRateLimit(
        fixture.app,
        `partner:confirm:ip:${prefixHash}`,
        partnerApplicationIpWindowMs,
        now,
      ),
    giveaway: {
      flags: {
        isEnabled: async (key) =>
          key === 'giveaway.open' && options.giveawayOpen === true,
      },
      currentRules: () => giveawayRules,
    },
  });
}

/** The plaintext confirmation link token of an application. */
async function confirmationToken(
  fixture: Fixture,
  email: string,
): Promise<string> {
  const row = await fixture.owner.readOne<{ id: string }>({
    text: `SELECT p.confirmation_token_id AS id FROM partner p
      JOIN subscriber s ON s.id = p.subscriber_id
      WHERE s.email_normalised = $1 ORDER BY p.submitted_at DESC, p.id`,
    values: [email],
  });
  assert.ok(row?.id, `${email} has a confirmation token`);
  return deriveEmailToken(row.id, process.env.EMAIL_TOKEN_SECRET!);
}

async function subscriberRow(fixture: Fixture, email: string) {
  return fixture.owner.readOne<{
    id: string;
    status: string;
    verified_at: Date | null;
    referral_code: string | null;
    verification_order_window: string | null;
  }>({
    text: `SELECT id, status, verified_at, referral_code, verification_order_window
      FROM subscriber WHERE email_normalised = $1`,
    values: [email],
  });
}

async function partnerRows(fixture: Fixture, subscriberId: string) {
  return fixture.owner.list<{
    id: string;
    status: string;
    created_subscriber: boolean;
    applied_at: Date | null;
    requested_code: string | null;
  }>(
    {
      text: `SELECT id, status, created_subscriber, applied_at, requested_code
        FROM partner WHERE subscriber_id = $1 ORDER BY submitted_at, id`,
      values: [subscriberId],
    },
    20,
  );
}

async function templates(fixture: Fixture, subscriberId: string) {
  return (
    await fixture.owner.list<{ template: string; business_key: string }>(
      {
        text: `SELECT template, business_key FROM email_send
          WHERE subscriber_id = $1 ORDER BY created_at, template`,
        values: [subscriberId],
      },
      50,
    )
  ).map((row) => row.template);
}

async function insertSubscriber(
  fixture: Fixture,
  email: string,
  status: string,
  createdAt = submittedAt,
): Promise<string> {
  const id = randomUUID();
  await fixture.owner.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
        status, created_at, verified_at, referral_code)
      VALUES ($1, $2, $2, 'example.test', $3, $4,
        CASE WHEN $3 = 'verified' THEN $4::timestamptz END,
        CASE WHEN $3 = 'verified' THEN $5 END)`,
    values: [
      id,
      email,
      status,
      createdAt,
      `V${randomUUID().replaceAll('-', '').slice(0, 11).toUpperCase()}`,
    ],
  });
  return id;
}

test('Turnstile is verified before any other work, then the flag, then the rate limit', async () => {
  const calls: string[] = [];
  const handler = (turnstile: TurnstileOutcome) =>
    createPartnerApplicationHandler({
      async verifyTurnstile() {
        calls.push('turnstile');
        return turnstile;
      },
      async isEnabled() {
        calls.push('flag');
        return true;
      },
      hashIpPrefix: () => Buffer.from('prefix'),
      async consumeIpRateLimit() {
        calls.push('rate');
        return 1;
      },
      async checkCode(requested) {
        calls.push('code');
        return { outcome: 'available', code: requested.toUpperCase() };
      },
      async submit() {
        calls.push('submit');
        return { kind: 'accepted', subscriberId: null };
      },
      monotonicClock: () => 0,
      sleep: async () => undefined,
    });

  assert.equal(
    (
      await handler('verified')(
        applicationForm({ turnstile_token: null }),
        '203.0.113.9',
      )
    ).kind,
    'challenge_failed',
  );
  assert.deepEqual(calls, [], 'a missing token reaches nothing');
  assert.equal(
    (await handler('rejected')(applicationForm(), '203.0.113.9')).kind,
    'challenge_failed',
  );
  assert.deepEqual(
    calls,
    ['turnstile'],
    'a rejected token reaches nothing else',
  );
  calls.length = 0;
  assert.equal(
    (await handler('verified')(applicationForm(), '203.0.113.9')).kind,
    'accepted',
  );
  assert.deepEqual(calls, ['turnstile', 'flag', 'rate', 'code', 'submit']);
});

test('the application is rate-limited per hashed prefix, strictly and flagged when Turnstile is unavailable', async () => {
  const fixture = await createFixture();
  try {
    const handler = realHandler(fixture);
    for (let attempt = 1; attempt <= partnerApplicationIpLimit; attempt += 1) {
      assert.equal(
        (
          await handler(
            applicationForm({ email_address: `rate-${attempt}@example.test` }),
            '203.0.113.10',
          )
        ).kind,
        'accepted',
        `attempt ${attempt}`,
      );
    }
    const limited = await handler(
      applicationForm({ email_address: 'rate-over@example.test' }),
      '203.0.113.10',
    );
    assert.equal(limited.kind, 'rate_limited');
    assert.equal(await subscriberRow(fixture, 'rate-over@example.test'), null);
    // The address is unattributable: limited, never let through.
    assert.equal(
      (
        await realHandler(fixture, { hashIpPrefix: () => null })(
          applicationForm({ email_address: 'no-prefix@example.test' }),
          'not-an-address',
        )
      ).kind,
      'rate_limited',
    );

    const unavailable = realHandler(fixture, { turnstile: 'unavailable' });
    for (
      let attempt = 1;
      attempt <= partnerApplicationStrictIpLimit;
      attempt += 1
    ) {
      assert.equal(
        (
          await unavailable(
            applicationForm({
              email_address: `strict-${attempt}@example.test`,
            }),
            '198.51.100.20',
          )
        ).kind,
        'accepted',
      );
    }
    assert.equal(
      (
        await unavailable(
          applicationForm({ email_address: 'strict-over@example.test' }),
          '198.51.100.20',
        )
      ).kind,
      'rate_limited',
    );
    const flagged = await subscriberRow(fixture, 'strict-1@example.test');
    const flag = await fixture.owner.readOne<{ kind: string }>({
      text: 'SELECT kind FROM fraud_flag WHERE subscriber_id = $1',
      values: [flagged?.id],
    });
    assert.equal(flag?.kind, 'challenge_timeout');
  } finally {
    await fixture.dispose();
  }
});

test('the field schema is exactly the brief’s fields, with no address, phone, payout or tax field', async () => {
  const fixture = await createFixture();
  try {
    const columns = (
      await fixture.owner.list<{ column_name: string }>(
        {
          text: `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'partner'
            ORDER BY column_name`,
        },
        100,
      )
    ).map((row) => row.column_name);
    const lifecycle = [
      'id',
      'subscriber_id',
      'status',
      'status_changed_at',
      'submitted_at',
      'applied_at',
      'created_subscriber',
      'confirmation_token_id',
      'personal_data_purged_at',
      'created_at',
      // E11.7-06: the founder's contract record and notes, set by command.
      'contract_sent_at',
      'contract_signed_at',
      'contract_version',
      'contract_reference',
      'notes',
    ];
    // The form's controls, less the email (the linked subscriber's own).
    const applicationColumns = partnerApplicationFieldNames.filter(
      (field) => field !== 'email_address',
    );
    assert.deepEqual(columns, [...lifecycle, ...applicationColumns].sort());
    for (const column of columns)
      assert.doesNotMatch(
        column,
        /address|street|postcode|zip|phone|mobile|payout|bank|iban|paypal|tax|vat|invoice/iu,
        column,
      );
    // The country lives on partner, and otherwise only on a provisional
    // winner's award record (ADR-026, as amended by E11.7-05).
    const countryColumns = await fixture.owner.list<{ table_name: string }>(
      {
        text: `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name LIKE '%country%'
          ORDER BY table_name`,
      },
      20,
    );
    assert.deepEqual(
      countryColumns.map((row) => row.table_name),
      ['giveaway_award', 'partner'],
    );
    // No analytics event can carry it.
    for (const [name, definition] of Object.entries(eventRegistry))
      for (const property of Object.keys(definition.properties))
        assert.doesNotMatch(property, /country/iu, `${name}.${property}`);
    // Unknown controls are ignored, never stored.
    const values = readPartnerApplicationValues(
      applicationForm({ phone: '+46 70 000 00 00', street: 'Main Street 1' }),
    );
    assert.equal(JSON.stringify(values).includes('Main Street'), false);
    assert.equal(JSON.stringify(values).includes('+46'), false);
  } finally {
    await fixture.dispose();
  }
});

test('a student ambassador needs a university; a business name and a student email stay optional', async () => {
  const parse = (overrides: Record<string, string | null>) =>
    parsePartnerApplication(
      readPartnerApplicationValues(applicationForm(overrides)),
    );
  const ambassador = parse({ partner_type: 'student_ambassador' });
  assert.equal(ambassador.ok, false);
  assert.deepEqual(ambassador.ok ? {} : ambassador.errors, {
    university: 'required',
  });
  const withUniversity = parse({
    partner_type: 'student_ambassador',
    university: 'Lund University',
    student_email: 'maya@student.example.test',
  });
  assert.ok(withUniversity.ok);
  assert.equal(withUniversity.fields.university, 'Lund University');
  assert.equal(withUniversity.fields.studentEmail, 'maya@student.example.test');
  assert.equal(
    parse({
      partner_type: 'student_ambassador',
      university: 'Lund University',
      student_email: 'not-an-email',
    }).ok,
    false,
  );
  // Another type keeps no university or student email.
  const standard = parse({
    partner_type: 'standard',
    university: 'Lund University',
    student_email: 'maya@student.example.test',
  });
  assert.ok(standard.ok);
  assert.equal(standard.fields.university, null);
  assert.equal(standard.fields.studentEmail, null);
  // A business name is optional either way.
  const noCompany = parse({ partner_type: 'standard', company_name: null });
  assert.ok(noCompany.ok);
  assert.equal(noCompany.fields.companyName, null);
  const company = parse({ company_name: 'Maya Media AB' });
  assert.ok(company.ok);
  assert.equal(company.fields.companyName, 'Maya Media AB');
  // Every required field is required, and each closed set is closed.
  const empty = parsePartnerApplication(
    readPartnerApplicationValues(new FormData()),
  );
  assert.equal(empty.ok, false);
  assert.deepEqual(Object.keys(empty.ok ? {} : empty.errors).sort(), [
    'age_confirmed',
    'audience_size',
    'channels',
    'country_of_residence',
    'email_address',
    'full_name',
    'handles',
    'partner_type',
    'programme_terms_agreed',
    'promotion_plan',
    'requested_code',
  ]);
  assert.deepEqual(
    (() => {
      const result = parse({
        country_of_residence: 'XX',
        partner_type: 'influencer',
        audience_size: 'huge',
        promotion_plan: 'x'.repeat(501),
      });
      return result.ok ? {} : result.errors;
    })(),
    {
      country_of_residence: 'invalid',
      partner_type: 'invalid',
      audience_size: 'invalid',
      promotion_plan: 'too_long',
    },
  );
  const channels = parsePartnerApplication(
    readPartnerApplicationValues(applicationForm({ channels: ['myspace'] })),
  );
  assert.deepEqual(channels.ok ? {} : channels.errors, { channels: 'invalid' });

  // The database holds the same rule.
  const fixture = await createFixture();
  try {
    const subscriberId = await insertSubscriber(
      fixture,
      'db-ambassador@example.test',
      'pending',
    );
    await assert.rejects(
      fixture.app.execute({
        text: `INSERT INTO partner (id, subscriber_id, status_changed_at,
            submitted_at, full_name, country_of_residence, partner_type,
            channels, handles, audience_size, promotion_plan, requested_code,
            age_confirmed, programme_terms_agreed)
          VALUES ($1, $2, $3, $3, 'A', 'SE', 'student_ambassador',
            ARRAY['tiktok'], ARRAY['@a'], 'under_1k', 'Plan', 'AMBASSADOR',
            true, true)`,
        values: [randomUUID(), subscriberId, submittedAt],
      }),
      { code: '23514' },
    );
  } finally {
    await fixture.dispose();
  }
});

test('a refused code returns the values and available alternatives, and stores nothing', async () => {
  const fixture = await createFixture();
  try {
    // A taken code: an existing member's code in the shared registry.
    const member = await insertSubscriber(
      fixture,
      'member@example.test',
      'verified',
    );
    await fixture.owner.execute({
      text: `UPDATE subscriber SET referral_code = 'TAKENCODE' WHERE id = $1`,
      values: [member],
    });
    const handler = realHandler(fixture);
    for (const [requested, reason] of [
      ['NETFLIXDEALS', 'blocked'],
      ['takencode', 'taken'],
      ['no', 'format'],
    ] as const) {
      const outcome = await handler(
        applicationForm({
          email_address: 'refused@example.test',
          requested_code: requested,
          channels: ['discord'],
        }),
        '192.0.2.30',
      );
      assert.equal(outcome.kind, 'refused', requested);
      if (outcome.kind !== 'refused') continue;
      assert.equal(outcome.errors.requested_code, reason, requested);
      assert.equal(outcome.values.requestedCode, requested);
      assert.equal(outcome.values.fullName, 'Maya Example');
      assert.deepEqual(outcome.values.channels, ['discord']);
      assert.ok(outcome.alternatives.length >= 1);
      assert.ok(outcome.alternatives.length <= 3);
      for (const alternative of outcome.alternatives)
        assert.deepEqual(
          await createPartnerCodeRules(fixture.app).check(alternative),
          { outcome: 'available', code: alternative },
        );
    }
    assert.equal(await subscriberRow(fixture, 'refused@example.test'), null);
    // The code is checked, not reserved: an accepted application writes no
    // referral_code row (D-050 Q3).
    assert.equal(
      (await handler(applicationForm({ requested_code: 'maya' }), '192.0.2.30'))
        .kind,
      'accepted',
    );
    const stored = await fixture.owner.readOne<{
      requested_code: string;
      registered: boolean;
    }>({
      text: `SELECT requested_code, EXISTS (
          SELECT 1 FROM referral_code WHERE code = 'MAYA') AS registered
        FROM partner`,
    });
    assert.deepEqual(stored, { requested_code: 'MAYA', registered: false });
  } finally {
    await fixture.dispose();
  }
});

test('confirmation creates or links a member: new, existing pending, existing verified, and a neutral answer otherwise', async () => {
  const fixture = await createFixture();
  try {
    const handler = realHandler(fixture);
    const confirm = confirmation(fixture, { giveawayOpen: true });
    const later = new Date(submittedAt.getTime() + 60 * 60 * 1_000);

    // 1. A new address: a pending subscriber is created, and confirming the
    // application's link is its double opt-in. It becomes a member like any
    // waitlist signup.
    assert.equal(
      (
        await handler(
          applicationForm({ email_address: 'new@example.test' }),
          '192.0.2.1',
        )
      ).kind,
      'accepted',
    );
    const created = await subscriberRow(fixture, 'new@example.test');
    assert.equal(created?.status, 'pending');
    const [unconfirmed] = await partnerRows(fixture, created!.id);
    assert.equal(unconfirmed?.status, 'unconfirmed');
    assert.equal(unconfirmed?.created_subscriber, true);
    assert.deepEqual(await templates(fixture, created!.id), [
      'partner_application_confirm',
    ]);
    // Unconfirmed, it is no confirmed member and cannot be moved to applied.
    await assert.rejects(
      fixture.app.execute({
        text: `UPDATE partner SET status = 'applied', applied_at = $2,
          status_changed_at = $2 WHERE id = $1`,
        values: [unconfirmed!.id, later],
      }),
      /only an application confirmed by a verified member/u,
    );
    const token = await confirmationToken(fixture, 'new@example.test');
    // GET never consumes: the token is consumed only by this POST service.
    assert.deepEqual(await confirm(token, 'prefix-a'), { kind: 'confirmed' });
    const verified = await subscriberRow(fixture, 'new@example.test');
    assert.equal(verified?.status, 'verified');
    assert.notEqual(verified?.referral_code, null);
    assert.equal(verified?.verification_order_window, 'wave-1');
    const [applied] = await partnerRows(fixture, created!.id);
    assert.equal(applied?.status, 'applied');
    assert.notEqual(applied?.applied_at, null);
    assert.deepEqual((await templates(fixture, created!.id)).sort(), [
      'giveaway_entry_receipt',
      'partner_application_confirm',
      'partner_application_received',
      'welcome',
    ]);
    const entry = await fixture.owner.readOne<{ method: string }>({
      text: 'SELECT method FROM giveaway_entry WHERE subscriber_id = $1',
      values: [created!.id],
    });
    assert.equal(entry?.method, 'base');
    // A replay is the same success and repeats nothing.
    assert.deepEqual(await confirm(token, 'prefix-a'), { kind: 'confirmed' });
    assert.equal((await templates(fixture, created!.id)).length, 4);
    const keys = await fixture.owner.list<{ business_key: string }>(
      {
        text: `SELECT business_key FROM email_send WHERE template LIKE 'partner_%'
          AND subscriber_id = $1 ORDER BY business_key`,
        values: [created!.id],
      },
      10,
    );
    assert.deepEqual(
      keys.map((row) => row.business_key).sort(),
      [
        partnerConfirmationBusinessKey(applied!.id),
        partnerReceivedBusinessKey(applied!.id),
      ].sort(),
    );

    // 2. An existing pending waitlist signup is linked, not created.
    const pendingId = await insertSubscriber(
      fixture,
      'pending@example.test',
      'pending',
    );
    assert.equal(
      (
        await handler(
          applicationForm({ email_address: 'Pending@Example.test' }),
          '192.0.2.2',
        )
      ).kind,
      'accepted',
    );
    const [linkedPending] = await partnerRows(fixture, pendingId);
    assert.equal(linkedPending?.created_subscriber, false);
    assert.deepEqual(
      await confirm(
        await confirmationToken(fixture, 'pending@example.test'),
        'prefix-b',
      ),
      { kind: 'confirmed' },
    );
    assert.equal(
      (await subscriberRow(fixture, 'pending@example.test'))?.status,
      'verified',
    );
    assert.equal((await partnerRows(fixture, pendingId))[0]?.status, 'applied');

    // 3. An existing verified member is linked unchanged.
    const verifiedId = await insertSubscriber(
      fixture,
      'verified@example.test',
      'verified',
      new Date('2026-10-02T00:00:00.000Z'),
    );
    const before = await subscriberRow(fixture, 'verified@example.test');
    assert.equal(
      (
        await handler(
          applicationForm({ email_address: 'verified@example.test' }),
          '192.0.2.3',
        )
      ).kind,
      'accepted',
    );
    assert.deepEqual(
      await confirm(
        await confirmationToken(fixture, 'verified@example.test'),
        'prefix-c',
      ),
      { kind: 'confirmed' },
    );
    assert.deepEqual(
      await subscriberRow(fixture, 'verified@example.test'),
      before,
    );
    assert.equal(
      (await partnerRows(fixture, verifiedId))[0]?.status,
      'applied',
    );
    assert.deepEqual(await templates(fixture, verifiedId), [
      'partner_application_confirm',
      'partner_application_received',
    ]);
    // A second application from a member with a confirmed one: the same
    // neutral answer, with no row and no mail.
    assert.equal(
      (
        await realHandler(fixture, {
          clock: () => new Date(submittedAt.getTime() + DAY_MS),
        })(
          applicationForm({ email_address: 'verified@example.test' }),
          '192.0.2.4',
        )
      ).kind,
      'accepted',
    );
    assert.equal((await partnerRows(fixture, verifiedId)).length, 1);

    // 4. Any other status gets the same neutral answer, with no mail.
    for (const status of [
      'expired',
      'unsubscribed',
      'bounced',
      'disqualified',
    ]) {
      const email = `${status}@example.test`;
      const id = await insertSubscriber(fixture, email, status);
      const outcome = await handler(
        applicationForm({ email_address: email }),
        '192.0.2.5',
      );
      assert.deepEqual(outcome, { kind: 'accepted' }, status);
      assert.deepEqual(await partnerRows(fixture, id), [], status);
      assert.deepEqual(await templates(fixture, id), [], status);
      const tokens = await fixture.owner.readOne<{ count: string }>({
        text: 'SELECT count(*)::text AS count FROM verification_token WHERE subscriber_id = $1',
        values: [id],
      });
      assert.equal(tokens?.count, '0', status);
    }
  } finally {
    await fixture.dispose();
  }
});

test('an unconfirmed application expires with its link, gets no waitlist reminders, and its subscriber expires by the 30-day sweep', async () => {
  const fixture = await createFixture();
  try {
    // A waitlist signup made earlier keeps its reminders.
    const waitlistId = await insertSubscriber(
      fixture,
      'waitlist@example.test',
      'pending',
    );
    await realHandler(fixture)(
      applicationForm({ email_address: 'unconfirmed@example.test' }),
      '192.0.2.40',
    );
    const applicant = await subscriberRow(fixture, 'unconfirmed@example.test');
    const token = await confirmationToken(fixture, 'unconfirmed@example.test');

    const dayLater = () => new Date(submittedAt.getTime() + 4 * DAY_MS);
    const reminders = await createVerificationReminderJob(fixture.app, {
      clock: dayLater,
    }).run(100);
    assert.ok(reminders.queued > 0);
    assert.deepEqual(await templates(fixture, applicant!.id), [
      'partner_application_confirm',
    ]);
    assert.ok(
      (await templates(fixture, waitlistId)).includes('verification_reminder'),
    );

    // The final reminder before freeze passes it over too.
    const final = await createFinalReminderJob(fixture.app, dayLater).run(
      null,
      100,
    );
    assert.equal(final.queued, 1);
    assert.deepEqual(await templates(fixture, applicant!.id), [
      'partner_application_confirm',
    ]);
    const finalKeys = await fixture.owner.list<{ subscriber_id: string }>(
      {
        text: `SELECT subscriber_id FROM email_send
          WHERE business_key LIKE 'verify-reminder-final:%'
            AND template = 'verification_reminder'`,
      },
      10,
    );
    assert.deepEqual(
      finalKeys.map((row) => row.subscriber_id),
      [waitlistId],
    );

    // After its seven days the link confirms nothing.
    const expiredAt = () => new Date(submittedAt.getTime() + 8 * DAY_MS);
    assert.deepEqual(
      await confirmation(fixture, { clock: expiredAt })(token, 'prefix-e'),
      { kind: 'invalid' },
    );
    assert.equal(
      (await subscriberRow(fixture, 'unconfirmed@example.test'))?.status,
      'pending',
    );
    assert.equal(
      (await partnerRows(fixture, applicant!.id))[0]?.status,
      'unconfirmed',
    );
    // It is never listed for review: nothing past unconfirmed exists.
    const reviewable = await fixture.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM partner WHERE status <> 'unconfirmed'`,
    });
    assert.equal(reviewable?.count, '0');

    // The subscriber the application created expires by the existing sweep.
    await createUnverifiedExpiryJob(fixture.app, {
      clock: () => new Date(submittedAt.getTime() + 31 * DAY_MS),
    }).run(100);
    assert.equal(
      (await subscriberRow(fixture, 'unconfirmed@example.test'))?.status,
      'expired',
    );
  } finally {
    await fixture.dispose();
  }
});

test('the DSR export carries the member’s applications, and erasure clears every personal field', async () => {
  const fixture = await createFixture();
  try {
    await realHandler(fixture)(
      applicationForm({
        email_address: 'dsr@example.test',
        partner_type: 'student_ambassador',
        university: 'Lund University',
        student_email: 'dsr-student@example.test',
        company_name: 'DSR Media',
      }),
      '192.0.2.50',
    );
    const subject = await subscriberRow(fixture, 'dsr@example.test');
    assert.ok(subject);
    assert.equal(subjectExportTables.partner, 'subscriber_id=$1');

    const lines: string[] = [];
    for await (const line of exportSubject(fixture.app, subject.id))
      lines.push(line);
    const rows = lines
      .map(
        (line) =>
          JSON.parse(line) as { table: string; data: Record<string, unknown> },
      )
      .filter((row) => row.table === 'partner');
    assert.equal(rows.length, 1);
    const columns = await fixture.owner.list<{ column_name: string }>(
      {
        text: `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'partner'
          ORDER BY column_name`,
      },
      100,
    );
    assert.deepEqual(
      Object.keys(rows[0]!.data).sort(),
      columns.map((column) => column.column_name),
    );
    assert.equal(rows[0]!.data.full_name, 'Maya Example');
    assert.equal(rows[0]!.data.student_email, 'dsr-student@example.test');

    const erasure = createErasureService(fixture.app, {
      clock: () => submittedAt,
      alerts: { send: async () => undefined },
      deleteContact: async () => undefined,
    });
    await withTransaction(fixture.app, (connection) =>
      erasure.request(connection, subject.id),
    );
    assert.equal(await erasure.run(), 1);
    const erased = await fixture.owner.readOne<Record<string, unknown>>({
      text: 'SELECT * FROM partner',
    });
    assert.ok(erased);
    for (const column of [
      'subscriber_id',
      'confirmation_token_id',
      'full_name',
      'country_of_residence',
      'channels',
      'handles',
      'audience_size',
      'promotion_plan',
      'requested_code',
      'university',
      'student_email',
      'company_name',
      'age_confirmed',
      'programme_terms_agreed',
    ])
      assert.equal(erased[column], null, column);
    assert.notEqual(erased.personal_data_purged_at, null);
    assert.equal(
      JSON.stringify(erased).includes('dsr-student@example.test'),
      false,
    );
    const after: string[] = [];
    for await (const line of exportSubject(fixture.app, subject.id))
      after.push(line);
    assert.equal(
      after.some((line) => line.startsWith('{"table":"partner"')),
      false,
    );
  } finally {
    await fixture.dispose();
  }
});

test('the retention purge clears rejected and unconfirmed applications after 90 days, batch-capped and recorded', async () => {
  const fixture = await createFixture();
  try {
    const old = new Date(submittedAt.getTime() - 91 * DAY_MS);
    const recent = new Date(submittedAt.getTime() - 10 * DAY_MS);
    const insert = async (
      label: string,
      status: 'unconfirmed' | 'applied' | 'rejected',
      at: Date,
    ) => {
      const subscriberId = await insertSubscriber(
        fixture,
        `${label}@example.test`,
        status === 'unconfirmed' ? 'pending' : 'verified',
        at,
      );
      const id = randomUUID();
      await fixture.owner.execute({
        text: `INSERT INTO partner (id, subscriber_id, status, status_changed_at,
            submitted_at, applied_at, full_name, country_of_residence,
            partner_type, channels, handles, audience_size, promotion_plan,
            requested_code, age_confirmed, programme_terms_agreed)
          VALUES ($1, $2, $3, $4, $4,
            CASE WHEN $3 = 'unconfirmed' THEN NULL ELSE $4::timestamptz END,
            $5, 'SE', 'standard', ARRAY['other'], ARRAY['@x'], 'under_1k',
            'Plan', 'CODE' || upper(substr(md5($5), 1, 6)), true, true)`,
        values: [id, subscriberId, status, at, label],
      });
      return id;
    };
    const oldUnconfirmed = await insert('old-unconfirmed', 'unconfirmed', old);
    const oldRejected = await insert('old-rejected', 'rejected', old);
    const thirdOld = await insert('old-unconfirmed-2', 'unconfirmed', old);
    const recentUnconfirmed = await insert('recent', 'unconfirmed', recent);
    const oldApplied = await insert('old-applied', 'applied', old);

    const job = createRecordedPurgeJob(
      createPartnerApplicationPurgeJob(fixture.app, {
        clock: () => submittedAt,
      }),
      createPurgeJobRunRepository(fixture.app),
      'partner_application_purge',
      () => submittedAt,
    );
    // The batch cap: two rows now, the third on the next run.
    assert.equal(await job.run(2), 2);
    assert.equal(await job.run(2), 1);
    assert.equal(await job.run(2), 0);
    const purged = async (id: string) =>
      (await fixture.owner.readOne<{
        purged: boolean;
        full_name: string | null;
        subscriber_id: string | null;
        status: string;
      }>({
        text: `SELECT personal_data_purged_at IS NOT NULL AS purged,
            full_name, subscriber_id, status FROM partner WHERE id = $1`,
        values: [id],
      }))!;
    for (const id of [oldUnconfirmed, oldRejected, thirdOld]) {
      const row = await purged(id);
      assert.equal(row.purged, true);
      assert.equal(row.full_name, null);
      assert.equal(row.subscriber_id, null);
    }
    assert.equal((await purged(oldRejected)).status, 'rejected');
    assert.equal((await purged(recentUnconfirmed)).purged, false);
    assert.equal((await purged(oldApplied)).purged, false);
    await assert.rejects(
      createPartnerRepository(fixture.app).purgeRetired(
        submittedAt,
        submittedAt,
        partnerPurgeBatchLimit + 1,
      ),
      RangeError,
    );
    const run = await fixture.owner.readOne<{
      last_outcome: string;
      rows_purged: number;
    }>({
      text: `SELECT last_outcome, rows_purged FROM purge_job_run
        WHERE job_key = 'partner_application_purge'`,
    });
    assert.deepEqual(run, { last_outcome: 'succeeded', rows_purged: 0 });
  } finally {
    await fixture.dispose();
  }
});

test('flag off pauses applications honestly and accepts nothing, and a paused confirmation keeps its link', async () => {
  const fixture = await createFixture();
  try {
    let enabled = false;
    const handler = realHandler(fixture, { isEnabled: async () => enabled });
    assert.deepEqual(
      await handler(
        applicationForm({ email_address: 'paused@example.test' }),
        '192.0.2.60',
      ),
      { kind: 'paused' },
    );
    assert.equal(await subscriberRow(fixture, 'paused@example.test'), null);
    const buckets = await fixture.owner.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM rate_limit_bucket',
    });
    assert.equal(buckets?.count, '0', 'paused before the rate limit');

    enabled = true;
    await handler(
      applicationForm({ email_address: 'paused@example.test' }),
      '192.0.2.60',
    );
    const token = await confirmationToken(fixture, 'paused@example.test');
    enabled = false;
    const confirm = confirmation(fixture, { enabled: () => enabled });
    assert.deepEqual(await confirm(token, 'prefix-p'), { kind: 'paused' });
    assert.equal(
      (await subscriberRow(fixture, 'paused@example.test'))?.status,
      'pending',
    );
    enabled = true;
    assert.deepEqual(await confirm(token, 'prefix-p'), { kind: 'confirmed' });
  } finally {
    await fixture.dispose();
  }
});

test('confirmation consumes its token first and is rate-limited per hashed prefix', async () => {
  const fixture = await createFixture();
  try {
    await realHandler(fixture)(
      applicationForm({ email_address: 'confirm-rate@example.test' }),
      '192.0.2.70',
    );
    const token = await confirmationToken(fixture, 'confirm-rate@example.test');
    const confirm = confirmation(fixture);
    for (let attempt = 0; attempt < 5; attempt += 1)
      assert.deepEqual(await confirm('not-a-real-link', 'prefix-r'), {
        kind: 'invalid',
      });
    assert.deepEqual(await confirm(token, 'prefix-r'), {
      kind: 'rate_limited',
    });
    // The limited attempt rolled back: the link still works elsewhere.
    assert.equal(
      (await subscriberRow(fixture, 'confirm-rate@example.test'))?.status,
      'pending',
    );
    assert.deepEqual(await confirm(token, 'prefix-other'), {
      kind: 'confirmed',
    });
    assert.deepEqual(await confirm(token, ''), { kind: 'rate_limited' });
  } finally {
    await fixture.dispose();
  }
});

test('a concurrent double submission creates one subscriber, one application and one link', async () => {
  const fixture = await createFixture();
  try {
    const handler = realHandler(fixture);
    const outcomes = await Promise.all([
      handler(
        applicationForm({ email_address: 'twice@example.test' }),
        '192.0.2.80',
      ),
      handler(
        applicationForm({ email_address: 'twice@example.test' }),
        '192.0.2.81',
      ),
    ]);
    assert.deepEqual(outcomes, [{ kind: 'accepted' }, { kind: 'accepted' }]);
    const subscribers = await fixture.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM subscriber
        WHERE email_normalised = 'twice@example.test'`,
    });
    assert.equal(subscribers?.count, '1');
    const subscriber = await subscriberRow(fixture, 'twice@example.test');
    assert.equal((await partnerRows(fixture, subscriber!.id)).length, 1);
    assert.deepEqual(await templates(fixture, subscriber!.id), [
      'partner_application_confirm',
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('a second application confirmed after the first answers confirmed, on first use and replay, and stays unconfirmed', async () => {
  const fixture = await createFixture();
  try {
    const email = 'second@example.test';
    await realHandler(fixture)(
      applicationForm({ email_address: email }),
      '192.0.2.90',
    );
    const first = await confirmationToken(fixture, email);
    // The mail window has passed when the second submission arrives.
    await realHandler(fixture, {
      clock: () => new Date(submittedAt.getTime() + DAY_MS),
    })(
      applicationForm({ email_address: email, requested_code: 'SECONDCODE' }),
      '192.0.2.91',
    );
    const second = await confirmationToken(fixture, email);
    assert.notEqual(first, second);
    const confirm = confirmation(fixture);
    assert.deepEqual(await confirm(first, 'prefix-s1'), { kind: 'confirmed' });
    assert.deepEqual(await confirm(second, 'prefix-s2'), { kind: 'confirmed' });
    assert.deepEqual(await confirm(second, 'prefix-s3'), { kind: 'confirmed' });
    const subscriber = await subscriberRow(fixture, email);
    assert.deepEqual(
      (await partnerRows(fixture, subscriber!.id)).map((row) => row.status),
      ['applied', 'unconfirmed'],
    );
    assert.equal(
      (await templates(fixture, subscriber!.id)).filter(
        (template) => template === 'partner_application_received',
      ).length,
      1,
    );
  } finally {
    await fixture.dispose();
  }
});
