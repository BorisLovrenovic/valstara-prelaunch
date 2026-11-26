// E11.8-02: the per-platform signup report, unit and against a real database
// with an injected clock. The Tests line: reconciliation against seeded data
// · the unlisted-value red path · normalisation · the no-UTM split · range
// bounds · authentication and audit · the convention file's validation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';

import type { APIContext } from 'astro';

import { adminCopy } from '../src/copy/admin.ts';
import { createSourceReportRoute } from '../src/pages/api/admin/reports/sources.ts';
import {
  adminActor,
  createAdminAuthenticator,
} from '../src/server/admin-auth/authenticate.ts';
import { createAdminAuthMiddleware } from '../src/server/admin-auth/middleware.ts';
import { adminRouteRegistry } from '../src/server/admin-auth/route-registry.ts';
import { generateTotp } from '../src/server/admin-auth/totp.ts';
import {
  AdminCommandError,
  adminCommands,
  runAdminCommand,
} from '../src/server/admin/cli.ts';
import { auditActions } from '../src/server/audit/actions.ts';
import { DatabaseUnavailableError } from '../src/server/db/errors.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { utmConvention } from '../src/server/source-report/convention.ts';
import {
  parseUtmConvention,
  sourceReportLabels,
  utmConventionProblems,
} from '../src/server/source-report/convention-rules.ts';
import { createSourceReportHandler } from '../src/server/source-report/http.ts';
import {
  createSourceReportService,
  type SourceReport,
  SourceReportRefusedError,
  sourceReportMaximumRows,
  sourceReportRange,
  utcCalendarDay,
} from '../src/server/source-report/report.ts';

import {
  createPartnerFixture,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const run = promisify(execFile);

// ── The convention file's validation ────────────────────────────────────────

test('the committed convention lists the ticket’s sources and media, and is valid', async () => {
  const committed = JSON.parse(
    await readFile('config/utm-convention.json', 'utf8'),
  ) as unknown;
  assert.deepEqual(utmConventionProblems(committed), []);
  assert.deepEqual(utmConvention, {
    utm_source: [
      'tiktok',
      'instagram',
      'youtube',
      'x',
      'reddit',
      'telegram',
      'discord',
      'linkedin',
      'facebook',
      'threads',
      'newsletter',
      'press',
    ],
    utm_medium: ['social', 'email', 'referral', 'paid'],
  });
  assert.ok(Object.isFrozen(utmConvention));
  assert.ok(Object.isFrozen(utmConvention.utm_source));
});

test('the convention’s validation refuses every malformed file with its reason', () => {
  const valid = { utm_source: ['tiktok'], utm_medium: ['social'] };
  const redPaths: readonly [string, unknown, RegExp][] = [
    ['a list', [], /must be a JSON object/u],
    ['null', null, /must be a JSON object/u],
    [
      'an unknown key',
      { ...valid, utm_campaign: ['x'] },
      /unknown key "utm_campaign"/u,
    ],
    [
      'a missing list',
      { utm_source: ['tiktok'] },
      /utm_medium must be a list/u,
    ],
    [
      'an empty list',
      { ...valid, utm_source: [] },
      /utm_source lists no value/u,
    ],
    [
      'a number',
      { ...valid, utm_medium: [7] },
      /utm_medium holds a value that is not text/u,
    ],
    [
      'upper case',
      { ...valid, utm_source: ['TikTok'] },
      /"TikTok" must be lower case/u,
    ],
    [
      'surrounding space',
      { ...valid, utm_source: [' tiktok'] },
      /" tiktok" must be lower case/u,
    ],
    [
      'a leading hyphen',
      { ...valid, utm_source: ['-x'] },
      /"-x" must be lower case/u,
    ],
    [
      'an email address',
      { ...valid, utm_source: ['a@b.test'] },
      /"a@b\.test" must be lower case/u,
    ],
    [
      '65 characters',
      { ...valid, utm_source: ['a'.repeat(65)] },
      /must be lower case/u,
    ],
    [
      'a duplicate',
      { ...valid, utm_source: ['tiktok', 'tiktok'] },
      /utm_source lists "tiktok" twice/u,
    ],
    [
      'the other label',
      { ...valid, utm_medium: ['other'] },
      /"other" is a label the report prints itself/u,
    ],
    [
      'the none label',
      { ...valid, utm_source: ['none'] },
      /"none" is a label the report prints itself/u,
    ],
  ];
  for (const [name, candidate, reason] of redPaths) {
    const problems = utmConventionProblems(candidate);
    assert.ok(
      problems.some((problem) => reason.test(problem)),
      `${name}: ${problems.join('; ')}`,
    );
    assert.throws(
      () => parseUtmConvention(candidate),
      /config\/utm-convention\.json is invalid/u,
      name,
    );
  }
  // 64 characters, digits, hyphens and underscores are allowed.
  assert.deepEqual(
    utmConventionProblems({
      utm_source: ['a'.repeat(64), 'x2', 'a-b_c'],
      utm_medium: ['paid'],
    }),
    [],
  );
});

test('npm run check validates the convention file, and fails on a broken one', async (t) => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts.check ?? '',
    /tsx scripts\/ci\/utm-convention-check\.ts && /u,
  );
  const root = await mkdtemp(join(tmpdir(), 'valstara-utm-convention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  const tsx = resolve('node_modules/.bin/tsx');
  const script = resolve('scripts/ci/utm-convention-check.ts');
  const check = async (content: string) => {
    await writeFile(join(root, 'config/utm-convention.json'), content);
    try {
      await run(tsx, [script], { cwd: root });
      return { code: 0, stderr: '' };
    } catch (error) {
      const failed = error as { code: number; stderr: string };
      return { code: failed.code, stderr: failed.stderr };
    }
  };
  assert.deepEqual(
    await check(await readFile('config/utm-convention.json', 'utf8')),
    { code: 0, stderr: '' },
  );
  const broken = await check(
    JSON.stringify({ utm_source: ['TikTok', 'x', 'x'], utm_medium: [] }),
  );
  assert.equal(broken.code, 1);
  assert.match(
    broken.stderr,
    /config\/utm-convention\.json failed its checks/u,
  );
  assert.match(
    broken.stderr,
    /- utm_source value "TikTok" must be lower case/u,
  );
  assert.match(broken.stderr, /- utm_source lists "x" twice/u);
  assert.match(broken.stderr, /- utm_medium lists no value/u);
  const notJson = await check('{ "utm_source": [');
  assert.equal(notJson.code, 1);
  assert.match(notJson.stderr, /- not valid JSON/u);
});

// ── Range bounds, as pure rules ─────────────────────────────────────────────

test('range bounds: whole UTC calendar days, from the first instant to the instant after the last', () => {
  assert.deepEqual(sourceReportRange('2027-03-01', '2027-03-31'), {
    start: new Date('2027-03-01T00:00:00.000Z'),
    end: new Date('2027-04-01T00:00:00.000Z'),
  });
  assert.deepEqual(sourceReportRange('2027-03-01', '2027-03-01'), {
    start: new Date('2027-03-01T00:00:00.000Z'),
    end: new Date('2027-03-02T00:00:00.000Z'),
  });
  // Across a leap day and a year end.
  assert.deepEqual(sourceReportRange('2028-02-29', '2028-12-31'), {
    start: new Date('2028-02-29T00:00:00.000Z'),
    end: new Date('2029-01-01T00:00:00.000Z'),
  });
  for (const value of [
    '2027-02-29',
    '2027-04-31',
    '2027-13-01',
    '2027-00-10',
    '2027-3-01',
    '2027-03-01T00:00:00Z',
    ' 2027-03-01',
    '',
  ])
    assert.equal(utcCalendarDay(value), null, value);
  assert.equal(sourceReportRange('2027-03-02', '2027-03-01'), null);
  assert.equal(sourceReportRange('2027-03-01', '2027-02-30'), null);
});

// ── Seeded database ─────────────────────────────────────────────────────────

const now = new Date('2027-05-02T09:00:00.000Z');
const clock = () => now;
let fixture: PartnerFixture;

before(async () => {
  fixture = await createPartnerFixture('source-report');
});

after(async () => {
  await fixture?.dispose();
});

interface Signup {
  readonly at: string;
  readonly status?: 'verified' | 'pending' | 'expired';
  readonly utm?: Record<string, string> | null;
  readonly ref?: boolean;
}

const ids: string[] = [];
const emails: string[] = [];

async function signup(options: Signup): Promise<string> {
  const id = randomUUID();
  const email = `signup-${id.slice(0, 8)}@example.test`;
  const status = options.status ?? 'verified';
  await fixture.owner.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
        status, created_at, verified_at, expired_at, referral_code, utm,
        signup_had_ref)
      VALUES ($1, $2, lower($2), 'example.test', $3, $4,
        CASE WHEN $3 = 'verified' THEN $4::timestamptz END,
        CASE WHEN $3 = 'expired' THEN $4::timestamptz END,
        CASE WHEN $3 = 'verified' THEN $5 END,
        $6::jsonb, $7)`,
    values: [
      id,
      email,
      status,
      new Date(options.at),
      `V${randomUUID().replaceAll('-', '').slice(0, 11).toUpperCase()}`,
      options.utm === undefined || options.utm === null
        ? null
        : JSON.stringify(options.utm),
      options.ref === true,
    ],
  });
  ids.push(id);
  emails.push(email);
  return id;
}

/** A referral edge from `referrerId` to a new member who joined in April. */
async function referral(
  referrerId: string,
  state: 'confirmed' | 'voided' | 'attributed' | 'rejected',
): Promise<void> {
  const referred = await signup({
    at: '2027-04-10T10:00:00.000Z',
    ref: true,
  });
  const voided = state === 'voided';
  const edgeState = voided ? 'confirmed' : state;
  await fixture.owner.execute({
    text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state,
        reward_state, rejected_reason, confirmed_at, voided_at, void_reason,
        voided_by, attribution_method)
      VALUES ($1, $2, $3, $4,
        CASE WHEN $4 = 'confirmed' THEN 'settled' ELSE 'none' END,
        CASE WHEN $4 = 'rejected' THEN 'self_referral' END,
        CASE WHEN $4 <> 'attributed' THEN now() END,
        CASE WHEN $5::boolean THEN now() END,
        CASE WHEN $5::boolean THEN 'Test void' END,
        CASE WHEN $5::boolean THEN 'admin.operator' END,
        'link')`,
    values: [randomUUID(), referrerId, referred, edgeState, voided],
  });
}

async function survey(subscriberId: string, answered: boolean): Promise<void> {
  await fixture.owner.execute({
    text: `INSERT INTO survey_response (id, subscriber_id, version, answers,
        first_answered_at)
      VALUES ($1, $2, '2026-09-08', $3::jsonb, $4)`,
    values: [
      randomUUID(),
      subscriberId,
      JSON.stringify(
        answered
          ? { category_preference: ['apparel'], shopping_frequency: 'monthly' }
          : { category_preference: null, shopping_frequency: null },
      ),
      answered ? new Date('2027-03-20T10:00:00.000Z') : null,
    ],
  });
}

// Every visitor-supplied value planted in the seed that must never print,
// compared case-insensitively.
const planted = [
  'someone',
  'example.com',
  'spring',
  'myspace',
  'cpc',
  'café',
  'bob',
  'example.org',
  'a'.repeat(65),
  '<script',
  'utm content',
  'term-value',
  'gone',
] as const;
// A listed value as it was stored, before normalisation, compared exactly.
const unnormalised = [
  'TikTok',
  'TIKTOK',
  'Launch-Week',
  'LAUNCH-WEEK',
  'INSTAGRAM',
  'SOCIAL',
  'Social',
] as const;

async function seed(): Promise<void> {
  // tiktok / social / launch-week: normalised from mixed case and padding,
  // on both edges of March.
  const first = await signup({
    at: '2027-03-01T00:00:00.000Z',
    utm: {
      source: ' TikTok ',
      medium: 'SOCIAL',
      campaign: 'Launch-Week',
      content: 'utm content',
      term: 'term-value',
    },
  });
  const second = await signup({
    at: '2027-03-31T23:59:59.999Z',
    utm: { source: 'tiktok', medium: 'social', campaign: 'launch-week' },
  });
  await signup({
    at: '2027-03-10T10:00:00.000Z',
    status: 'pending',
    utm: { source: 'TIKTOK', medium: 'Social', campaign: 'LAUNCH-WEEK' },
  });
  // Left the waitlist (below): a signup, no longer a verified one.
  const left = await signup({
    at: '2027-03-11T10:00:00.000Z',
    utm: { source: 'tiktok', medium: 'social', campaign: 'launch-week' },
  });
  // The first made one confirmed referral; a voided, an unconfirmed and a
  // rejected one do not count. The left member's confirmed one still does.
  await referral(first, 'confirmed');
  await referral(first, 'voided');
  await referral(first, 'attributed');
  await referral(first, 'rejected');
  await referral(left, 'confirmed');
  await fixture.owner.execute({
    text: `UPDATE subscriber SET status = 'unsubscribed',
      unsubscribed_at = '2027-03-25T10:00:00Z' WHERE id = $1`,
    values: [left],
  });
  // One answered the survey; a skipped survey is not a completion.
  await survey(first, true);
  await survey(second, false);

  // instagram / social, without a campaign.
  const insta = await signup({
    at: '2027-03-05T10:00:00.000Z',
    utm: { source: 'INSTAGRAM', medium: 'social' },
  });
  await referral(insta, 'confirmed');
  await referral(insta, 'confirmed');
  await survey(insta, true);

  // Unlisted sources: an email address and an unknown platform, both other.
  await signup({
    at: '2027-03-06T10:00:00.000Z',
    utm: {
      source: 'someone@example.com',
      medium: 'social',
      campaign: 'launch-week',
    },
  });
  await signup({
    at: '2027-03-06T11:00:00.000Z',
    status: 'pending',
    utm: { source: 'myspace', medium: 'social', campaign: 'launch-week' },
  });
  // Malformed campaigns: punctuation, too long, non-ASCII, an email address
  // and markup.
  for (const campaign of [
    'Spring Sale!',
    'a'.repeat(65),
    'café',
    'bob@example.org',
    '<script>',
  ])
    await signup({
      at: '2027-03-07T10:00:00.000Z',
      utm: { source: 'tiktok', medium: 'social', campaign },
    });
  // An unlisted medium.
  await signup({
    at: '2027-03-08T10:00:00.000Z',
    utm: { source: 'youtube', medium: 'cpc', campaign: 'launch-week' },
  });
  // A signed ref with UTM values counts under its UTM row, not the split.
  await signup({
    at: '2027-03-09T09:00:00.000Z',
    utm: { source: 'reddit', medium: 'social', campaign: 'launch-week' },
    ref: true,
  });
  // UTM values present, but no source or medium: (not set).
  await signup({
    at: '2027-03-09T10:00:00.000Z',
    utm: { campaign: 'launch-week' },
  });

  // Without UTM values: through a valid signed ref, and with none.
  const referred = await signup({ at: '2027-03-12T10:00:00.000Z', ref: true });
  await referral(referred, 'confirmed');
  await signup({
    at: '2027-03-13T10:00:00.000Z',
    status: 'pending',
    ref: true,
  });
  const direct = await signup({ at: '2027-03-14T10:00:00.000Z' });
  await survey(direct, true);
  await signup({ at: '2027-03-15T10:00:00.000Z', status: 'pending' });
  await signup({ at: '2027-03-16T10:00:00.000Z', status: 'expired' });

  // Outside March: never counted.
  await signup({
    at: '2027-02-28T23:59:59.999Z',
    utm: { source: 'tiktok', medium: 'social', campaign: 'launch-week' },
  });
  await signup({
    at: '2027-04-01T00:00:00.000Z',
    utm: { source: 'tiktok', medium: 'social', campaign: 'launch-week' },
  });
  // A pending erasure in March: no longer processed, so never counted.
  await withTransaction(fixture.owner, async (connection) => {
    const id = randomUUID();
    await connection.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
          status, created_at, utm, signup_had_ref)
        VALUES ($1, $2, $2, 'example.test', 'erasure_pending',
          '2027-03-17T10:00:00Z', $3::jsonb, false)`,
      values: [
        id,
        `erasing-${id.slice(0, 8)}@example.test`,
        JSON.stringify({
          source: 'tiktok',
          medium: 'social',
          campaign: 'gone',
        }),
      ],
    });
    await connection.execute({
      text: `INSERT INTO dsr_erasure (subscriber_id, requested_at, next_attempt_at)
        VALUES ($1, '2027-03-18T10:00:00Z', '2027-03-18T10:00:00Z')`,
      values: [id],
    });
    ids.push(id);
  });
}

const counts = (
  signups: number,
  verifiedSignups: number,
  confirmedReferrals: number,
  firstSurveyCompletions: number,
) => ({ signups, verifiedSignups, confirmedReferrals, firstSurveyCompletions });

// The expected March report, written out by hand from the seed.
const expectedMarch = {
  from: '2027-03-01',
  to: '2027-03-31',
  countedAt: now,
  // Most signups first, then by label.
  rows: [
    // The five malformed campaigns.
    {
      source: 'tiktok',
      medium: 'social',
      campaign: 'other',
      ...counts(5, 5, 0, 0),
    },
    // first, second, the pending one, the one who left.
    {
      source: 'tiktok',
      medium: 'social',
      campaign: 'launch-week',
      ...counts(4, 2, 2, 1),
    },
    // The email-address source and myspace.
    {
      source: 'other',
      medium: 'social',
      campaign: 'launch-week',
      ...counts(2, 1, 0, 0),
    },
    {
      source: '(not set)',
      medium: '(not set)',
      campaign: 'launch-week',
      ...counts(1, 1, 0, 0),
    },
    {
      source: 'instagram',
      medium: 'social',
      campaign: '(not set)',
      ...counts(1, 1, 2, 1),
    },
    {
      source: 'reddit',
      medium: 'social',
      campaign: 'launch-week',
      ...counts(1, 1, 0, 0),
    },
    {
      source: 'youtube',
      medium: 'other',
      campaign: 'launch-week',
      ...counts(1, 1, 0, 0),
    },
  ],
  withoutUtm: {
    referral: counts(2, 1, 1, 0),
    none: counts(3, 1, 0, 1),
  },
  totals: counts(20, 14, 5, 3),
  rowCount: 9,
};

let seeded = false;
async function seedOnce(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await seed();
}

async function audits(): Promise<
  {
    actor: string;
    subject_type: string;
    subject_id: string | null;
    detail: unknown;
  }[]
> {
  return fixture.owner.list<{
    actor: string;
    subject_type: string;
    subject_id: string | null;
    detail: unknown;
  }>(
    {
      text: `SELECT actor, subject_type, subject_id, detail FROM audit_log
        WHERE action = 'report.sources_counted' ORDER BY at, id`,
    },
    100,
  ) as Promise<
    {
      actor: string;
      subject_type: string;
      subject_id: string | null;
      detail: unknown;
    }[]
  >;
}

function service() {
  return createSourceReportService(fixture.app, {
    convention: utmConvention,
    clock,
  });
}

/** Asserts that nothing planted, and no person, appears in `text`. */
function assertNothingPlanted(text: string, where: string): void {
  for (const value of planted)
    assert.equal(
      text.toLowerCase().includes(value.toLowerCase()),
      false,
      `${where} carries ${value}`,
    );
  for (const raw of unnormalised)
    assert.equal(text.includes(raw), false, `${where} carries ${raw}`);
  assert.doesNotMatch(text, /@/u, where);
  for (const id of ids) assert.equal(text.includes(id), false, where);
  for (const email of emails) assert.equal(text.includes(email), false, where);
}

test('reconciliation against seeded data: every count matches, per source, medium and campaign', async () => {
  await seedOnce();
  const before_ = (await audits()).length;
  const report = await service().report({
    from: '2027-03-01',
    to: '2027-03-31',
    actor: 'founder:test',
  });
  assert.deepEqual(report, expectedMarch);
  // The totals equal the plain definitions, computed independently: every
  // March signup still held, the verified ones, the confirmed non-voided
  // edges they made, and their first survey completions.
  const independent = await fixture.owner.readOne<{
    signups: number;
    verified: number;
    referrals: number;
    surveys: number;
  }>({
    text: `WITH march AS (
        SELECT id, status FROM subscriber
        WHERE created_at >= '2027-03-01T00:00:00Z'
          AND created_at < '2027-04-01T00:00:00Z'
          AND status NOT IN ('erasure_pending', 'erased'))
      SELECT
        (SELECT count(*)::int FROM march) AS signups,
        (SELECT count(*)::int FROM march WHERE status = 'verified') AS verified,
        (SELECT count(*)::int FROM referral_edge e JOIN march m
          ON m.id = e.referrer_id
          WHERE e.state = 'confirmed' AND e.voided_at IS NULL) AS referrals,
        (SELECT count(*)::int FROM survey_response r JOIN march m
          ON m.id = r.subscriber_id
          WHERE r.first_answered_at IS NOT NULL) AS surveys`,
  });
  assert.deepEqual(independent, {
    signups: report.totals.signups,
    verified: report.totals.verifiedSignups,
    referrals: report.totals.confirmedReferrals,
    surveys: report.totals.firstSurveyCompletions,
  });
  // Each row and bucket adds up to the totals.
  const sum = (key: keyof ReturnType<typeof counts>) =>
    [...report.rows, report.withoutUtm.referral, report.withoutUtm.none].reduce(
      (total, row) => total + row[key],
      0,
    );
  for (const key of [
    'signups',
    'verifiedSignups',
    'confirmedReferrals',
    'firstSurveyCompletions',
  ] as const)
    assert.equal(sum(key), report.totals[key], key);
  // The run is audited with the actor, the range and the row count, and
  // nothing else.
  const recorded = (await audits()).slice(before_);
  assert.deepEqual(recorded, [
    {
      actor: 'founder:test',
      subject_type: 'source_report',
      subject_id: null,
      detail: { from: '2027-03-01', to: '2027-03-31', row_count: 9 },
    },
  ]);
});

test('the unlisted-value red path: no planted value, email address or person ever reaches the output', async () => {
  await seedOnce();
  const report = await service().report({
    from: '2027-03-01',
    to: '2027-03-31',
    actor: 'founder:test',
  });
  const labels = new Set<string>([
    ...utmConvention.utm_source,
    ...utmConvention.utm_medium,
    sourceReportLabels.other,
    sourceReportLabels.notSet,
  ]);
  for (const row of report.rows) {
    assert.ok(labels.has(row.source), row.source);
    assert.ok(labels.has(row.medium), row.medium);
    assert.ok(
      row.campaign === sourceReportLabels.other ||
        row.campaign === sourceReportLabels.notSet ||
        /^[a-z0-9-]{1,64}$/u.test(row.campaign),
      row.campaign,
    );
  }
  assertNothingPlanted(JSON.stringify(report), 'the report');
  // The HTTP body and the founder command's table and CSV print only what
  // the report holds.
  const handler = createSourceReportHandler(service());
  const response = await handler({
    actor: 'founder:test',
    url: new URL(
      'https://valstara.com/api/admin/reports/sources?from=2027-03-01&to=2027-03-31',
    ),
  });
  const body = await response.text();
  assertNothingPlanted(body, 'the response');
  const command = adminCommands['report sources'];
  assert.ok(command?.complete !== undefined);
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const table = await command.complete(parsed, ['--from', 'x', '--to', 'y']);
  const csv = await command.complete(parsed, ['--csv']);
  assertNothingPlanted(table.join('\n'), 'the table');
  assertNothingPlanted(csv.join('\n'), 'the CSV');
  assertNothingPlanted(JSON.stringify(await audits()), 'the audit log');
});

test('normalisation: values are trimmed and lower-cased before they are compared', async () => {
  await seedOnce();
  // A day holding only the mixed-case, padded signup: it counts as listed.
  const firstDay = await service().report({
    from: '2027-03-01',
    to: '2027-03-01',
    actor: 'founder:test',
  });
  assert.deepEqual(firstDay.rows, [
    {
      source: 'tiktok',
      medium: 'social',
      campaign: 'launch-week',
      ...counts(1, 1, 1, 1),
    },
  ]);
  // Lower-casing folds A–Z only: a non-ASCII letter that lower-cases to an
  // ASCII one in some locales never makes a listed value.
  await signup({
    at: '2027-07-01T10:00:00.000Z',
    utm: {
      source: 'T\u0130KTOK',
      medium: '\u017focial',
      campaign: 'LAUNCH-WEEK',
    },
  });
  await signup({
    at: '2027-07-01T11:00:00.000Z',
    utm: {
      source: '\u00a0tiktok',
      medium: '\tsocial\n',
      campaign: 'k\u212a',
    },
  });
  const july = await service().report({
    from: '2027-07-01',
    to: '2027-07-01',
    actor: 'founder:test',
  });
  assert.deepEqual(july.rows, [
    {
      source: 'other',
      medium: 'other',
      campaign: 'launch-week',
      ...counts(1, 1, 0, 0),
    },
    // ASCII white space is trimmed; a non-breaking space is not.
    {
      source: 'other',
      medium: 'social',
      campaign: 'other',
      ...counts(1, 1, 0, 0),
    },
  ]);
});

test('the no-UTM split: a valid signed ref is "referral link or code", anything else is "none", and the two add up exactly', async () => {
  await seedOnce();
  const report = await service().report({
    from: '2027-03-12',
    to: '2027-03-16',
    actor: 'founder:test',
  });
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.withoutUtm, expectedMarch.withoutUtm);
  assert.equal(
    report.withoutUtm.referral.signups + report.withoutUtm.none.signups,
    report.totals.signups,
  );
  assert.equal(report.rowCount, 2);
  // The reddit signup on 9 March carried a signed ref and UTM values: it is
  // counted under its UTM row, never in the split.
  const ninth = await service().report({
    from: '2027-03-09',
    to: '2027-03-09',
    actor: 'founder:test',
  });
  assert.deepEqual(
    ninth.rows.map((row) => [row.source, row.signups]),
    [
      ['(not set)', 1],
      ['reddit', 1],
    ],
  );
  assert.equal(ninth.withoutUtm.referral.signups, 0);
  // The eight referred members of 10 April carry a signed ref and no UTM.
  const april = await service().report({
    from: '2027-04-10',
    to: '2027-04-10',
    actor: 'founder:test',
  });
  assert.equal(april.withoutUtm.referral.signups, 8);
  assert.equal(april.withoutUtm.none.signups, 0);
  // An empty range reports both buckets as zero.
  const empty = await service().report({
    from: '2030-01-01',
    to: '2030-01-31',
    actor: 'founder:test',
  });
  assert.deepEqual(empty.withoutUtm, {
    referral: counts(0, 0, 0, 0),
    none: counts(0, 0, 0, 0),
  });
  assert.deepEqual(empty.totals, counts(0, 0, 0, 0));
  assert.equal(empty.rowCount, 2);
});

test('range bounds: the first and last instants count, the instants either side do not, and a bad range is refused unaudited', async () => {
  await seedOnce();
  const tiktok = (report: SourceReport) =>
    report.rows.find(
      (row) =>
        row.source === 'tiktok' &&
        row.medium === 'social' &&
        row.campaign === 'launch-week',
    )?.signups ?? 0;
  const day = (from: string, to = from) =>
    service().report({ from, to, actor: 'founder:test' });
  // 28 February 23:59:59.999 and 1 April 00:00 sit just outside March.
  assert.equal(tiktok(await day('2027-02-28')), 1);
  assert.equal(tiktok(await day('2027-04-01')), 1);
  assert.equal(tiktok(await day('2027-03-01')), 1);
  assert.equal(tiktok(await day('2027-03-31')), 1);
  assert.equal(tiktok(await day('2027-02-28', '2027-04-01')), 6);
  // The pending erasure on 17 March is never counted.
  assert.equal((await day('2027-03-17')).totals.signups, 0);

  const before_ = (await audits()).length;
  for (const [from, to, actor, refusal] of [
    ['2027-03-31', '2027-03-01', 'founder:test', 'range'],
    ['2027-02-30', '2027-03-01', 'founder:test', 'range'],
    ['2027-03-01', '2027-3-31', 'founder:test', 'range'],
    ['March', '2027-03-31', 'founder:test', 'range'],
    ['2027-03-01', '2027-03-31', 'system:maintenance', 'actor'],
    ['2027-03-01', '2027-03-31', ' ', 'actor'],
  ] as const)
    await assert.rejects(
      service().report({ from, to, actor }),
      (error: unknown) =>
        error instanceof SourceReportRefusedError && error.refusal === refusal,
      `${from} ${to} ${actor}`,
    );
  assert.equal((await audits()).length, before_);
});

test('the report is batch-capped: a range with more rows than one report prints is refused whole, and unaudited', async () => {
  await seedOnce();
  // Two no-UTM rows are always printed, so 1,998 campaigns fill the cap.
  const campaigns = (day: string, first: number, last: number) =>
    fixture.owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
          status, created_at, utm, signup_had_ref)
        SELECT gen_random_uuid(), 'cap-' || $1 || '-' || g || '@example.test',
          'cap-' || $1 || '-' || g || '@example.test', 'example.test',
          'pending', $2::timestamptz,
          jsonb_build_object('source', 'tiktok', 'medium', 'social',
            'campaign', 'c-' || g),
          false
        FROM generate_series($3::int, $4::int) g`,
      values: [day, `${day}T10:00:00Z`, first, last],
    });
  await campaigns('2027-08-01', 1, sourceReportMaximumRows - 2);
  const full = await service().report({
    from: '2027-08-01',
    to: '2027-08-01',
    actor: 'founder:test',
  });
  assert.equal(full.rowCount, sourceReportMaximumRows);
  assert.equal(full.rows.length, sourceReportMaximumRows - 2);
  assert.equal(full.totals.signups, sourceReportMaximumRows - 2);
  // One more campaign is one row over the cap.
  await campaigns(
    '2027-08-02',
    sourceReportMaximumRows - 1,
    sourceReportMaximumRows - 1,
  );
  const before_ = (await audits()).length;
  await assert.rejects(
    service().report({
      from: '2027-08-01',
      to: '2027-08-02',
      actor: 'founder:test',
    }),
    (error: unknown) =>
      error instanceof SourceReportRefusedError &&
      error.refusal === 'too_many_rows',
  );
  assert.equal((await audits()).length, before_);
});

// ── The route's shape ───────────────────────────────────────────────────────

const zeroCounts = counts(0, 0, 0, 0);
const okReport = async (): Promise<SourceReport> => ({
  from: '2027-03-01',
  to: '2027-03-31',
  countedAt: now,
  rows: [
    {
      source: 'tiktok',
      medium: 'social',
      campaign: 'launch-week',
      ...counts(4, 2, 1, 1),
    },
  ],
  withoutUtm: { referral: counts(2, 1, 0, 0), none: zeroCounts },
  totals: counts(6, 3, 1, 1),
  rowCount: 3,
});

test('the route returns labels and counts only, refuses any other query, and never forwards a database error', async () => {
  const handler = (report: () => Promise<SourceReport>) =>
    createSourceReportHandler({ report });
  const url = (query: string) =>
    new URL(`https://valstara.com/api/admin/reports/sources${query}`);
  const ok = await handler(okReport)({
    actor: adminActor,
    url: url('?to=2027-03-31&from=2027-03-01'),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await ok.json(), {
    from: '2027-03-01',
    to: '2027-03-31',
    counted_at: now.toISOString(),
    rows: [
      {
        source: 'tiktok',
        medium: 'social',
        campaign: 'launch-week',
        signups: 4,
        verified_signups: 2,
        confirmed_referrals: 1,
        first_survey_completions: 1,
      },
    ],
    without_utm: [
      {
        bucket: 'referral link or code',
        signups: 2,
        verified_signups: 1,
        confirmed_referrals: 0,
        first_survey_completions: 0,
      },
      {
        bucket: 'none',
        signups: 0,
        verified_signups: 0,
        confirmed_referrals: 0,
        first_survey_completions: 0,
      },
    ],
    totals: {
      signups: 6,
      verified_signups: 3,
      confirmed_referrals: 1,
      first_survey_completions: 1,
    },
    row_count: 3,
    retention: adminCopy.sourceReport.retention,
  });
  assert.match(adminCopy.sourceReport.retention, /kept for 12 months/u);
  for (const query of [
    '',
    '?from=2027-03-01',
    '?from=2027-03-01&to=2027-03-31&to=2027-04-01',
    '?from=2027-03-01&to=2027-03-31&csv=1',
    '?month=2027-03',
  ]) {
    const refused = await handler(okReport)({
      actor: adminActor,
      url: url(query),
    });
    assert.equal(refused.status, 400, query);
    assert.deepEqual(await refused.json(), {
      error: { code: 'invalid_input', message: adminCopy.sourceReport.query },
    });
  }
  for (const [refusal, message] of [
    ['range', adminCopy.sourceReport.range],
    ['actor', adminCopy.sourceReport.actor],
    ['too_many_rows', adminCopy.sourceReport.tooManyRows],
  ] as const) {
    const refused = await handler(async () => {
      throw new SourceReportRefusedError(refusal);
    })({ actor: adminActor, url: url('?from=2027-03-01&to=2027-03-31') });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), {
      error: { code: 'invalid_input', message },
    });
  }
  const unavailable = await handler(async () => {
    throw new DatabaseUnavailableError(
      new Error('connection refused at 10.0.0.1'),
    );
  })({ actor: adminActor, url: url('?from=2027-03-01&to=2027-03-31') });
  assert.equal(unavailable.status, 503);
  const internal = await handler(async () => {
    throw new Error('column "someone@example.com" does not exist');
  })({ actor: adminActor, url: url('?from=2027-03-01&to=2027-03-31') });
  assert.equal(internal.status, 500);
  for (const response of [unavailable, internal]) {
    const text = await response.text();
    assert.doesNotMatch(text, /10\.0\.0\.1|refused|someone|column/u);
    assert.match(text, /temporarily unavailable/u);
  }
});

// ── Authentication and audit ────────────────────────────────────────────────

const credential = 'test-admin-credential-with-32-characters';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const code = generateTotp(totpSecret, now);

async function adminServer(): Promise<{
  origin: string;
  requests: () => number;
  close(): Promise<void>;
}> {
  const route = createSourceReportRoute(service());
  const middleware = createAdminAuthMiddleware(
    createAdminAuthenticator({ credential, totpSecret }, clock),
  );
  let count = 0;
  const server: Server = createServer(async (incoming, outgoing) => {
    count += 1;
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (typeof value === 'string') headers.set(key, value);
    const request = new Request(url, { method: incoming.method, headers });
    const locals = {};
    const response = await middleware({ locals, request, url }, async () =>
      request.method === 'GET' && url.pathname === '/api/admin/reports/sources'
        ? route({ locals, params: {}, request, url } as unknown as APIContext)
        : new Response(null, { status: 404 }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests: () => count,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function io(typed: string) {
  const lines: string[] = [];
  const notices: string[] = [];
  const prompts: string[] = [];
  return {
    lines,
    notices,
    prompts,
    io: {
      async prompt(question: string) {
        prompts.push(question);
        return typed;
      },
      write(line: string) {
        lines.push(line);
      },
      notice(line: string) {
        notices.push(line);
      },
      writeChunk() {},
    },
  };
}

test('authentication and audit: the route and the command are refused without the authenticator code, and each run is audited with the actor, range and row count', async (t) => {
  await seedOnce();
  const server = await adminServer();
  t.after(() => server.close());
  const environment = {
    ADMIN_API_ORIGIN: server.origin,
    ADMIN_CREDENTIAL: credential,
  };
  const march = [
    'report',
    'sources',
    '--from',
    '2027-03-01',
    '--to',
    '2027-03-31',
  ];
  assert.deepEqual(
    adminRouteRegistry.find(
      (entry) => entry.pathname === '/api/admin/reports/sources',
    ),
    {
      source: 'src/pages/api/admin/reports/sources.ts',
      pathname: '/api/admin/reports/sources',
      methods: [{ method: 'GET', audit: 'required' }],
    },
  );
  assert.ok(auditActions.includes('report.sources_counted'));
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['report:sources'],
    'node ./src/server/admin/cli.ts report sources',
  );
  const before_ = (await audits()).length;

  // At the command line, no code or a malformed one sends nothing.
  for (const typed of ['', '12345', 'abcdef']) {
    const terminal = io(typed);
    await assert.rejects(
      runAdminCommand(march, environment, terminal.io, fetch),
      (error: unknown) =>
        error instanceof AdminCommandError &&
        /A six-digit authenticator code is required\. Nothing was sent\./u.test(
          error.message,
        ),
    );
    assert.deepEqual(terminal.lines, []);
  }
  assert.equal(server.requests(), 0);
  // A missing or malformed range, or an unknown option, is refused before
  // anything is asked.
  for (const args of [
    ['report', 'sources'],
    ['report', 'sources', '--from', '2027-03-01'],
    ['report', 'sources', '--from', '2027-3-1', '--to', '2027-03-31'],
    [...march, '--limit', '5'],
    [...march, 'extra'],
    [...march, '--csv', '--csv'],
  ]) {
    const terminal = io(code);
    await assert.rejects(
      runAdminCommand(args, environment, terminal.io, fetch),
      AdminCommandError,
      args.join(' '),
    );
    assert.deepEqual(terminal.prompts, [], args.join(' '));
  }
  assert.equal(server.requests(), 0);

  // At the API, a missing or wrong code, or a wrong key, is 401 and nothing
  // is audited.
  const path = '/api/admin/reports/sources?from=2027-03-01&to=2027-03-31';
  for (const [key, totp] of [
    [credential, null],
    [credential, '000000'],
    ['wrong', code],
  ] as const) {
    const response = await fetch(new URL(path, server.origin), {
      headers: {
        Authorization: `Bearer ${key}`,
        ...(totp === null ? {} : { 'X-Valstara-TOTP': totp }),
      },
    });
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, 'unauthorized');
    assert.doesNotMatch(text, /tiktok|signups/u);
  }
  const anonymous = await fetch(new URL(path, server.origin));
  assert.equal(anonymous.status, 401);
  assert.equal((await audits()).length, before_);

  // With the code: the table, audited as the authenticated operator.
  const terminal = io(code);
  await runAdminCommand(march, environment, terminal.io, fetch);
  assert.deepEqual(terminal.lines, [
    `Signups created 2027-03-01 to 2027-03-31 (UTC days), counted at ${now.toISOString()}.`,
    '',
    'source     medium     campaign     signups  verified  confirmed referrals  first surveys',
    'tiktok     social     other        5        5         0                    0',
    'tiktok     social     launch-week  4        2         2                    1',
    'other      social     launch-week  2        1         0                    0',
    '(not set)  (not set)  launch-week  1        1         0                    0',
    'instagram  social     (not set)    1        1         2                    1',
    'reddit     social     launch-week  1        1         0                    0',
    'youtube    other      launch-week  1        1         0                    0',
    '',
    'Without UTM values:',
    '                       signups  verified  confirmed referrals  first surveys',
    'referral link or code  2        1         1                    0',
    'none                   3        1         0                    1',
    'total, all signups     20       14        5                    3',
    '',
    '9 rows.',
    adminCopy.sourceReport.retention,
  ]);
  assert.deepEqual(terminal.notices, []);

  // With --csv: a CSV on standard output, the retention note beside it.
  const csv = io(code);
  await runAdminCommand([...march, '--csv'], environment, csv.io, fetch);
  assert.deepEqual(csv.lines, [
    '"source","medium","campaign","signups","verified_signups","confirmed_referrals","first_survey_completions"',
    '"tiktok","social","other","5","5","0","0"',
    '"tiktok","social","launch-week","4","2","2","1"',
    '"other","social","launch-week","2","1","0","0"',
    '"(not set)","(not set)","launch-week","1","1","0","0"',
    '"instagram","social","(not set)","1","1","2","1"',
    '"reddit","social","launch-week","1","1","0","0"',
    '"youtube","other","launch-week","1","1","0","0"',
    '"referral link or code","","","2","1","1","0"',
    '"none","","","3","1","0","1"',
  ]);
  assert.deepEqual(csv.notices, [adminCopy.sourceReport.retention]);

  // A refused range at the API is shown and audits nothing.
  const reversed = io(code);
  await assert.rejects(
    runAdminCommand(
      ['report', 'sources', '--from', '2027-03-31', '--to', '2027-03-01'],
      environment,
      reversed.io,
      fetch,
    ),
    new RegExp(`invalid_input: ${adminCopy.sourceReport.range}`, 'u'),
  );

  const recorded = (await audits()).slice(before_);
  assert.deepEqual(
    recorded,
    [1, 2].map(() => ({
      actor: adminActor,
      subject_type: 'source_report',
      subject_id: null,
      detail: { from: '2027-03-01', to: '2027-03-31', row_count: 9 },
    })),
  );
  // The key and the code never reach the audit log.
  const serialised = JSON.stringify(recorded);
  assert.equal(serialised.includes(credential), false);
  assert.equal(serialised.includes(code), false);
});

test('no analytics event changes and no public surface carries the report: it is reachable only through the admin boundary', async () => {
  const files = [
    'src/server/source-report/convention-rules.ts',
    'src/server/source-report/convention.ts',
    'src/server/source-report/report.ts',
    'src/server/source-report/http.ts',
    'src/server/source-report/runtime.ts',
    'src/server/db/source-report.ts',
    'src/pages/api/admin/reports/sources.ts',
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /^import[^;]*from '[^']*(?:analytics|funnel|umami)[^']*';/mu,
      file,
    );
  }
  // The route is the only page under the report path, and it is an admin
  // route the E5-03a middleware guards.
  assert.ok(
    adminRouteRegistry.some(
      (entry) => entry.source === 'src/pages/api/admin/reports/sources.ts',
    ),
  );
  // The command line loads under plain Node, as the founder runs it
  // (memory: node-type-stripping-erasable-only).
  await run(process.execPath, [
    '--import',
    './src/server/admin/cli.ts',
    '-e',
    '0',
  ]);
});
