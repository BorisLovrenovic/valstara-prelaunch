// E11.7-15: the partner programme's local seed script, run as its command in
// CI against a scratch database (the ticket's Tests line). It asserts that the
// seed writes every partner type and status, member and partner referrals
// with voids, the ladder's stages and the welcome discounts, all consistent
// with the rules the services enforce; that every link it prints opens its
// own state; and that it refuses a database it has seeded, a database on
// another machine and a production environment.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertLocalSeedTarget,
  seedActor,
  seedEmailDomain,
  seedFirstWaveSize,
  type SeedManifest,
} from '../scripts/seed-partner-programme.ts';
import {
  computeCouponLadder,
  waveOneReferralThreshold,
} from '../src/server/referral/config.ts';
import { partnerWelcomeDiscount } from '../src/server/referral/partner-perks.ts';
import { partnerStatuses } from '../src/server/partner/review.ts';
import { partnerTypes } from '../src/server/partner/config.ts';
import { hashEmailToken } from '../src/server/verification/token-derivation.ts';

import {
  createPartnerFixture,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const tokenSecret = 'partner-seed-test-email-token-secret-32';

let fixture: PartnerFixture;
let directory: string;
let manifest: SeedManifest;
let firstRun: { stdout: string; stderr: string };

function runSeed(
  databaseUrl: string,
  extra: Readonly<Record<string, string>> = {},
  argumentsList: readonly string[] = [],
) {
  return executeFile(
    process.execPath,
    ['--import', 'tsx', 'scripts/seed-partner-programme.ts', ...argumentsList],
    {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        EMAIL_TOKEN_SECRET: tokenSecret,
        EMAIL_BASE_URL: 'http://localhost:4321',
        NODE_ENV: 'development',
        ...extra,
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function rows<Row extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<readonly Row[]> {
  return fixture.owner.list<Row>({ text, values }, 10_000);
}

before(async () => {
  fixture = await createPartnerFixture('partner-seed');
  directory = await mkdtemp(join(tmpdir(), 'partner-seed-'));
  firstRun = await runSeed(fixture.appDatabaseUrl, {}, [
    `--json=${join(directory, 'manifest.json')}`,
  ]);
  manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  ) as SeedManifest;
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
  await fixture?.dispose();
});

test('the seed writes every partner type and every lifecycle status', async () => {
  const partners = await rows<{ status: string; partner_type: string }>(
    'SELECT status, partner_type FROM partner',
  );
  assert.deepEqual(
    [...new Set(partners.map((row) => row.status))].sort(),
    [...partnerStatuses].sort(),
  );
  assert.deepEqual(
    [...new Set(partners.map((row) => row.partner_type))].sort(),
    [...partnerTypes].sort(),
  );
  // Every type has a live partner, so each dashboard variant has data.
  for (const type of partnerTypes)
    assert.ok(
      partners.some(
        (row) => row.partner_type === type && row.status === 'active',
      ),
      `an active ${type}`,
    );
  // Only signed partners hold a live code, and every live code is a
  // partner's code for an active partner.
  const codes = await rows<{ status: string; active: boolean }>(
    `SELECT p.status, c.active FROM referral_code c
      JOIN partner p ON p.id = c.owner_id WHERE c.owner_kind = 'partner'`,
  );
  assert.ok(codes.length >= 7);
  for (const code of codes)
    assert.equal(code.active, code.status === 'active', code.status);
  // Every sample person is on the reserved test domain.
  const domains = await rows<{ email_domain: string }>(
    'SELECT DISTINCT email_domain FROM subscriber',
  );
  assert.deepEqual(
    domains.map((row) => row.email_domain),
    [seedEmailDomain],
  );
});

test('the seed writes member and partner referrals by link and code, pending, voided and retroactive', async () => {
  const edges = await rows<{
    partner_id: string | null;
    attribution_method: string;
    state: string;
    voided: boolean;
    void_reason: string | null;
    voided_by: string | null;
    referred_status: string;
  }>(
    `SELECT e.partner_id, e.attribution_method, e.state,
        e.voided_at IS NOT NULL AS voided, e.void_reason, e.voided_by,
        s.status AS referred_status
      FROM referral_edge e JOIN subscriber s ON s.id = e.referred_id`,
  );
  const member = edges.filter((edge) => edge.partner_id === null);
  const partner = edges.filter((edge) => edge.partner_id !== null);
  for (const [kind, set] of [
    ['member', member],
    ['partner', partner],
  ] as const) {
    assert.ok(
      set.some((edge) => edge.attribution_method === 'link'),
      `${kind} link`,
    );
    assert.ok(
      set.some((edge) => edge.attribution_method === 'code'),
      `${kind} code`,
    );
    assert.ok(
      set.some((edge) => edge.state === 'attributed'),
      `${kind} pending`,
    );
    assert.ok(
      set.some((edge) => edge.state === 'confirmed' && edge.voided),
      `${kind} voided`,
    );
  }
  assert.ok(partner.some((edge) => edge.attribution_method === 'retroactive'));
  // A confirmed edge's friend is verified, and a pending one's is not.
  for (const edge of edges)
    assert.equal(
      edge.referred_status,
      edge.state === 'confirmed' ? 'verified' : 'pending',
    );
  // Every void carries its reason and the founder actor.
  for (const edge of edges.filter((item) => item.voided)) {
    assert.ok(edge.void_reason && edge.void_reason.length > 0);
    assert.equal(edge.voided_by, seedActor);
  }
  // An un-void is recorded with its reason.
  const audit = await rows<{ action: string; actor: string }>(
    `SELECT action, actor FROM audit_log
      WHERE action IN ('referral.voided', 'referral.unvoided')`,
  );
  assert.ok(audit.some((row) => row.action === 'referral.voided'));
  assert.ok(audit.some((row) => row.action === 'referral.unvoided'));
  for (const row of audit) assert.equal(row.actor, seedActor);
});

test('every welcome discount follows the founder rule from its signup count, and only partner edges carry one', async () => {
  const edges = await rows<{
    partner_type: string | null;
    welcome_discount_pct: number | null;
    signup_confirmed_count: number | null;
    voided: boolean;
  }>(
    `SELECT p.partner_type, e.welcome_discount_pct, e.signup_confirmed_count,
        e.voided_at IS NOT NULL AS voided
      FROM referral_edge e LEFT JOIN partner p ON p.id = e.partner_id`,
  );
  const discounts = new Set<number>();
  for (const edge of edges) {
    if (edge.partner_type === null) {
      assert.equal(edge.welcome_discount_pct, null, 'a member edge');
      continue;
    }
    if (edge.voided) continue;
    assert.notEqual(edge.welcome_discount_pct, null);
    assert.notEqual(edge.signup_confirmed_count, null);
    assert.equal(
      edge.welcome_discount_pct,
      partnerWelcomeDiscount(edge.signup_confirmed_count!, edge.partner_type),
      `${edge.partner_type} at ${edge.signup_confirmed_count}`,
    );
    discounts.add(edge.welcome_discount_pct!);
    if (edge.partner_type === 'student_ambassador')
      assert.ok(edge.welcome_discount_pct! >= 15, 'the ambassador floor');
  }
  assert.deepEqual([...discounts].sort(), [10, 15, 20]);
  // The ambassador floor is shown where it matters: below 21 referrals.
  assert.ok(
    edges.some(
      (edge) =>
        edge.partner_type === 'student_ambassador' &&
        edge.signup_confirmed_count! < 21 &&
        edge.welcome_discount_pct === 15,
    ),
  );
});

test('every member holds exactly the ladder of their confirmed, non-voided count, and never a settled coupon', async () => {
  const members = await rows<{
    id: string;
    confirmed_referrals: number;
    counted: number;
  }>(
    `SELECT s.id, s.confirmed_referrals,
        (SELECT count(*)::int FROM referral_edge e
          WHERE e.referrer_id = s.id AND e.state = 'confirmed'
            AND e.voided_at IS NULL) AS counted
      FROM subscriber s`,
  );
  const coupons = await rows<{
    subscriber_id: string;
    coupon_number: number;
    percent: number | null;
    state: string;
  }>(
    'SELECT subscriber_id, coupon_number, percent, state FROM referral_coupon ORDER BY coupon_number',
  );
  const stages = new Set<number>();
  for (const member of members) {
    assert.equal(member.confirmed_referrals, member.counted, member.id);
    const held = coupons
      .filter((row) => row.subscriber_id === member.id && row.state === 'held')
      .map((row) => ({ number: row.coupon_number, percent: row.percent }));
    assert.deepEqual(
      held,
      computeCouponLadder(member.counted).map((coupon) => ({
        number: coupon.number,
        percent: coupon.percent,
      })),
      member.id,
    );
    stages.add(held.length);
  }
  assert.deepEqual([...stages].sort(), [0, 1, 2, 3]);
  // A void that dropped a member below the first unlock left coupon 1 void.
  assert.ok(coupons.some((row) => row.state === 'void'));
  assert.deepEqual([...new Set(coupons.map((row) => row.state))].sort(), [
    'held',
    'void',
  ]);
  // The ladder's figures the sample shows: 5, 10, 15 and 30 for coupon 1.
  for (const percent of [5, 10, 15, 30])
    assert.ok(
      coupons.some((row) => row.coupon_number === 1 && row.percent === percent),
      `coupon 1 at ${percent}%`,
    );
});

test('wave 1 is held for each of its reasons, and members outside it remain', async () => {
  const members = await rows<{
    access_window: string | null;
    verification_order_window: string | null;
    confirmed_referrals: number;
    live_partner: boolean;
    partner_friend: boolean;
  }>(
    `SELECT s.access_window, s.verification_order_window, s.confirmed_referrals,
        EXISTS (SELECT 1 FROM partner p WHERE p.subscriber_id = s.id
          AND p.status = 'active') AS live_partner,
        EXISTS (SELECT 1 FROM referral_edge e WHERE e.referred_id = s.id
          AND e.partner_id IS NOT NULL AND e.voided_at IS NULL
          AND e.state = 'confirmed') AS partner_friend
      FROM subscriber s WHERE s.status = 'verified'`,
  );
  const wave = (row: (typeof members)[number]) => row.access_window;
  const byOrder = members.filter(
    (row) => row.verification_order_window === 'wave-1',
  );
  assert.equal(byOrder.length, seedFirstWaveSize);
  for (const row of byOrder) assert.equal(wave(row), 'wave-1');
  assert.ok(
    members.some(
      (row) =>
        row.verification_order_window !== 'wave-1' &&
        !row.live_partner &&
        row.confirmed_referrals >= waveOneReferralThreshold &&
        wave(row) === 'wave-1',
    ),
    'wave 1 by referrals',
  );
  assert.ok(
    members.some(
      (row) =>
        row.live_partner &&
        row.confirmed_referrals < waveOneReferralThreshold &&
        wave(row) === 'wave-1',
    ),
    'wave 1 as an active partner',
  );
  assert.ok(
    members.some(
      (row) =>
        row.partner_friend &&
        row.confirmed_referrals === 0 &&
        row.verification_order_window !== 'wave-1' &&
        wave(row) === 'wave-1',
    ),
    'wave 1 through a partner',
  );
  assert.ok(
    members.some((row) => wave(row) !== 'wave-1'),
    'members outside wave 1',
  );
  // Nobody below the threshold and without another reason is in wave 1.
  for (const row of members)
    if (
      row.verification_order_window !== 'wave-1' &&
      row.confirmed_referrals < waveOneReferralThreshold &&
      !row.live_partner &&
      !row.partner_friend
    )
      assert.notEqual(wave(row), 'wave-1');
});

test('the seed queues the programme emails, the leaderboard snapshot and the survey answers', async () => {
  const templates = await rows<{ template: string; state: string }>(
    'SELECT DISTINCT template, state FROM email_send',
  );
  for (const template of [
    'partner_application_confirm',
    'partner_application_received',
    'partner_approved',
    'partner_rejected',
    'partner_welcome',
    'partner_first_signup',
    'welcome',
  ])
    assert.ok(
      templates.some((row) => row.template === template),
      `${template} queued`,
    );
  // Queued only: the seed sends nothing.
  assert.deepEqual([...new Set(templates.map((row) => row.state))], ['queued']);
  const snapshot = await rows<{ as_of: Date | null }>(
    'SELECT as_of FROM partner_leaderboard_snapshot',
  );
  assert.ok(snapshot.length === 1 && snapshot[0]!.as_of !== null);
  const survey = await rows<{ count: number }>(
    'SELECT count(*)::int AS count FROM survey_response',
  );
  assert.ok(survey[0]!.count > 50);
});

test('every printed link opens its own sample state', async () => {
  assert.match(firstRun.stdout, /Partner programme sample data seeded/u);
  const memberKeys = manifest.members.map((entry) => entry.key);
  for (const key of [
    'first-signups-no-referrals',
    'no-referrals',
    'two-referrals',
    'three-referrals',
    'seven-referrals',
    'ten-referrals',
    'twenty-one-referrals',
    'thirty-nine-referrals',
    'voided-below-threshold',
    'unvoided-restored',
  ])
    assert.ok(memberKeys.includes(key), key);
  // Each link's token is a live, single-purpose token of its own person.
  const token = (path: string) =>
    new URL(path, manifest.baseUrl).searchParams.get(
      path.startsWith('/verify') ? 'token' : 't',
    )!;
  async function owner(path: string, purpose: string) {
    const found = await rows<{ subscriber_id: string; expires_at: Date }>(
      'SELECT subscriber_id, expires_at FROM verification_token WHERE token_hash = $1 AND purpose = $2',
      [hashEmailToken(token(path)), purpose],
    );
    assert.equal(found.length, 1, path);
    return found[0]!.subscriber_id;
  }
  const memberCounts = await rows<{ id: string; confirmed_referrals: number }>(
    'SELECT id, confirmed_referrals FROM subscriber',
  );
  const countOf = new Map(
    memberCounts.map((row) => [row.id, row.confirmed_referrals]),
  );
  const expected: Record<string, number> = {
    'first-signups-no-referrals': 0,
    'no-referrals': 0,
    'two-referrals': 2,
    'three-referrals': 3,
    'seven-referrals': 7,
    'ten-referrals': 10,
    'twenty-one-referrals': 21,
    'thirty-nine-referrals': 39,
    'voided-below-threshold': 2,
    'unvoided-restored': 3,
  };
  for (const entry of manifest.members)
    assert.equal(
      countOf.get(await owner(entry.path, 'status')),
      expected[entry.key],
      entry.key,
    );
  for (const entry of manifest.friends) await owner(entry.path, 'status');
  for (const entry of manifest.verifyReplays) await owner(entry.path, 'verify');
  // Each linked partner's link is its partner's current dashboard link.
  for (const partner of manifest.partners) {
    if (partner.dashboardPath === null) {
      assert.ok(
        [
          'approved',
          'contract_sent',
          'applied',
          'rejected',
          'unconfirmed',
        ].includes(partner.status),
      );
      continue;
    }
    const linkHash = hashEmailToken(token(partner.dashboardPath));
    const current = await rows<{ status: string; partner_type: string }>(
      `SELECT p.status, p.partner_type FROM partner p
        JOIN verification_token t ON t.id = p.dashboard_token_id
        WHERE t.token_hash = $1 AND t.purpose = 'partner_dashboard'`,
      [linkHash],
    );
    assert.equal(partner.shortLinkPath, `/r/${partner.code}`);
    if (partner.status === 'terminated') {
      // The link held while active exists, and termination cancelled it.
      await owner(partner.dashboardPath, 'partner_dashboard');
      assert.deepEqual(current, []);
      continue;
    }
    assert.deepEqual(current, [
      { status: partner.status, partner_type: partner.type },
    ]);
  }
});

test('the seed refuses a database it has already seeded, and changes nothing', async () => {
  const count = async () =>
    (
      await rows<{ subscribers: number; partners: number; edges: number }>(
        `SELECT (SELECT count(*)::int FROM subscriber) AS subscribers,
          (SELECT count(*)::int FROM partner) AS partners,
          (SELECT count(*)::int FROM referral_edge) AS edges`,
      )
    )[0];
  const before = await count();
  await assert.rejects(runSeed(fixture.appDatabaseUrl), (error: unknown) => {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1);
    assert.match(failure.stderr ?? '', /already holds the partner seed/u);
    return true;
  });
  assert.deepEqual(await count(), before);
});

test('the seed refuses a database on another machine and a production environment before connecting', async () => {
  // An unroutable host would hang a connection attempt; the refusal is
  // immediate because the check runs first.
  await assert.rejects(
    runSeed('postgresql://valstara_app:secret@db.example.com:5432/valstara'),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(
        failure.stderr ?? '',
        /only against a database on this machine/u,
      );
      return true;
    },
  );
  await assert.rejects(
    runSeed(fixture.appDatabaseUrl, { NODE_ENV: 'production' }),
    /never runs with NODE_ENV=production/u,
  );
  assert.throws(
    () => assertLocalSeedTarget('postgresql://u:p@10.0.0.5/db', {}),
    /not 10\.0\.0\.5/u,
  );
  assert.throws(
    () => assertLocalSeedTarget('not a url', {}),
    /not a valid URL/u,
  );
  for (const host of ['localhost', '127.0.0.1', '[::1]'])
    assert.doesNotThrow(() =>
      assertLocalSeedTarget(`postgresql://u:p@${host}:5434/db`, {}),
    );
});
