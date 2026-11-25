// E11.7-15: the partner-programme audit's checks that need no browser, over
// the programme the local seed writes (scripts/seed-partner-programme.ts) in
// a scratch database. Evidence: docs/testing/e11-7-partner-programme-audit.md.
//
// - The cookie inventory has two entries, and the islands are three.
// - The reward-gating enumeration, re-run over the seeded programme: no
//   coupon is settled, only the cheap confirmation reward settles, and the
//   attribution export carries every coupon held.
// - Every new and changed email template, rendered from the seeded database
//   through the dispatch path, follows the copy rules, links only to the
//   site, loads nothing from elsewhere and names no other person.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { emailPreviewRenderers } from '../scripts/design/email-previews.ts';
import { referralLadderCopy } from '../src/copy/referral-ladder.ts';
import { siteOrigin } from '../src/server/seo.ts';
import {
  attributionExportJsonFile,
  exportAttribution,
} from '../src/server/partner/attribution-export.ts';
import { partnerDigestTemplate } from '../src/server/partner/config.ts';
import {
  couponTransitions,
  prelaunchRewardTransitions,
} from '../src/server/referral/reward-state.ts';

import {
  copyIssues,
  sentenceCaseIssues,
} from './helpers/partner-copy-audit.mjs';
import {
  auditDigestNote,
  auditedTemplates,
  renderAuditedEmails,
} from './helpers/partner-emails.ts';
import {
  createPartnerFixture,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const actor = 'founder:e11-7-15-audit';
const tokenSecret = process.env.EMAIL_TOKEN_SECRET!;
const baseUrl = process.env.EMAIL_BASE_URL!;

let fixture: PartnerFixture;

before(async () => {
  assert.ok(tokenSecret && baseUrl, 'npm test sets the email environment');
  fixture = await createPartnerFixture('e11-7-15-audit');
  await executeFile(
    process.execPath,
    ['--import', 'tsx', 'scripts/seed-partner-programme.ts'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: fixture.appDatabaseUrl },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
});

after(async () => {
  await fixture?.dispose();
});

async function rows<Row extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<readonly Row[]> {
  return fixture.owner.list<Row>({ text, values }, 10_000);
}

function tableEntries(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .slice(2);
}

test('the cookie inventory has two entries, and the islands are three', async () => {
  // The published inventory, which /privacy and /privacy/storage render.
  const inventory = tableEntries(await read('src/content/privacy-storage.md'));
  assert.deepEqual(
    inventory.map((entry) => entry[0]),
    ['`valstara-theme`', '`cf.turnstile.u`'],
  );
  // ADR-001's three islands, and no fourth.
  const islands = (await readdir(new URL('../src/islands/', import.meta.url)))
    .filter((name) => name.endsWith('.astro'))
    .sort();
  assert.deepEqual(islands, [
    'Leaderboard.astro',
    'SignupForm.astro',
    'ThemeToggle.astro',
  ]);
  // No partner page or route mounts an island or hydrates a component.
  async function sources(directory: string): Promise<string[]> {
    const entries = await readdir(
      new URL(`../${directory}/`, import.meta.url),
      {
        withFileTypes: true,
      },
    );
    const nested = await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sources(`${directory}/${entry.name}`)
          : Promise.resolve([`${directory}/${entry.name}`]),
      ),
    );
    return nested.flat();
  }
  const partnerSources = [
    ...(await sources('src/pages/partners')),
    ...(await sources('src/pages/r')),
  ];
  assert.ok(partnerSources.length >= 5, partnerSources.join(', '));
  for (const path of partnerSources) {
    const source = await read(path);
    assert.doesNotMatch(source, /\/islands\//u, path);
    assert.doesNotMatch(source, /\bclient:[a-z]+/u, path);
  }
});

test('reward gating over the seeded programme: no coupon settles, only the cheap confirmation reward settles, and the export carries every coupon held', async () => {
  // The enumerations the reward-gating suites assert, unchanged.
  assert.deepEqual(
    couponTransitions.map(({ from, to }) => `${from}->${to}`),
    ['none->held', 'held->held', 'held->void', 'void->held'],
  );
  assert.deepEqual(
    prelaunchRewardTransitions
      .filter((transition) => transition.to === 'settled')
      .map(({ classification, source }) => `${classification}:${source}`),
    ['cheap:confirmation'],
  );
  // Over the programme's real rows.
  const coupons = await rows<{ state: string; count: number }>(
    'SELECT state, count(*)::int AS count FROM referral_coupon GROUP BY state ORDER BY state',
  );
  assert.deepEqual(
    coupons.map((row) => row.state),
    ['held', 'void'],
  );
  const settledEdges = await rows<{ state: string; voided: boolean }>(
    `SELECT state, voided_at IS NOT NULL AS voided FROM referral_edge
      WHERE reward_state = 'settled'`,
  );
  // The cheap reward settles on a confirmation only.
  for (const edge of settledEdges) assert.equal(edge.state, 'confirmed');
  assert.deepEqual(
    await rows(
      "SELECT id FROM referral_edge WHERE state <> 'confirmed' AND reward_state = 'settled'",
    ),
    [],
  );
  const awards = await rows<{ count: number }>(
    "SELECT count(*)::int AS count FROM milestone_award WHERE state = 'settled'",
  );
  assert.equal(awards[0]!.count, 0);

  // The attribution export of the seeded programme: every coupon held with
  // its expiry, welcome discounts only on partner edges, voids flagged.
  const chunks = new Map<string, string>();
  await exportAttribution(fixture.app, actor, async (file, chunk) => {
    chunks.set(file, (chunks.get(file) ?? '') + chunk);
  });
  const exported = JSON.parse(chunks.get(attributionExportJsonFile)!) as {
    coupons: { state: string; expires_at: string; percent: number }[];
    referrals: {
      referrer_type: string;
      welcome_discount_pct: number | null;
      voided: boolean;
    }[];
    partners: { status: string }[];
  };
  const storedHeld = coupons.find((row) => row.state === 'held')!.count;
  assert.equal(exported.coupons.length, storedHeld);
  for (const coupon of exported.coupons) {
    assert.equal(coupon.state, 'held');
    assert.ok(coupon.expires_at);
  }
  assert.ok(exported.referrals.some((referral) => referral.voided));
  for (const referral of exported.referrals)
    if (referral.referrer_type === 'member' || referral.voided)
      assert.equal(referral.welcome_discount_pct, null);
  assert.deepEqual(
    [...new Set(exported.partners.map((partner) => partner.status))].sort(),
    ['active', 'paused', 'terminated'],
  );
});

const decode = (value: string) =>
  value
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&nbsp;', ' ');
const visible = (html: string) =>
  decode(
    html
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<!doctype[^>]*>/giu, ' ')
      .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' '),
  );

test('every new and changed email renders from the seeded programme through the dispatch path, under the copy rules', async () => {
  const messages = await renderAuditedEmails(fixture.app, {
    baseUrl,
    tokenSecret,
    actor,
  });
  assert.deepEqual(
    [...new Set(messages.map(({ row }) => row.template))].sort(),
    [...auditedTemplates].sort(),
  );
  // Each audited template is on the review sheet's preview set too.
  const previews = emailPreviewRenderers('https://valstara.com');
  for (const template of auditedTemplates)
    assert.ok(previews.has(template), `${template} has a preview`);

  const addresses = (
    await rows<{ email: string }>('SELECT email FROM subscriber')
  ).map((row) => row.email.toLowerCase());
  // The site's own origins: the emailed links' base, and the public origin
  // a member's shareable referral link always uses.
  const origins = new Set([new URL(baseUrl).origin, siteOrigin]);
  const problems: string[] = [];
  const rendered = new Map<string, number>();
  for (const { row, message } of messages) {
    rendered.set(row.template, (rendered.get(row.template) ?? 0) + 1);
    const label = `${row.template} ${row.id}`;
    assert.ok(message.html, `${label}: an HTML part`);
    const html = message.html;
    const text = message.text;
    for (const issue of [
      ...copyIssues(`${message.subject}\n${text}`),
      ...copyIssues(visible(html)),
      ...sentenceCaseIssues(message.subject),
    ])
      problems.push(`${label}: ${issue}`);
    // Every link is the site's own; nothing loads from elsewhere.
    for (const [, href] of html.matchAll(/\bhref="([^"]*)"/gu)) {
      const url = new URL(decode(href!));
      if (!origins.has(url.origin))
        problems.push(`${label}: link ${url.origin}`);
    }
    for (const [, source] of html.matchAll(/\bsrc="([^"]*)"/gu))
      problems.push(`${label}: loads ${source}`);
    // No address but the recipient's own (the auto-invite's prefill link
    // carries it, D-070), and no other person's.
    const own = row.email.toLowerCase();
    const body = `${html}\n${text}`.toLowerCase();
    for (const address of addresses) {
      if (address === own) continue;
      if (body.includes(address) || body.includes(encodeURIComponent(address)))
        problems.push(`${label}: names another person`);
    }
    if (row.template !== 'partner_invite' && body.includes(own))
      problems.push(`${label}: prints the recipient's address`);
  }
  assert.deepEqual(problems, []);
  assert.ok(rendered.get('welcome')! > 100, 'every welcome of the seed');

  // The welcome of a partner-referred friend states the partner's code and
  // the friend's fixed discount; no other welcome carries a perk line.
  const perks = await rows<{
    subscriber_id: string;
    code: string;
    welcome_discount_pct: number;
  }>(
    `SELECT e.referred_id AS subscriber_id, c.code, e.welcome_discount_pct
      FROM referral_edge e JOIN referral_code c
        ON c.owner_id = e.partner_id AND c.owner_kind = 'partner'
      WHERE e.partner_id IS NOT NULL AND e.voided_at IS NULL
        AND e.state = 'confirmed'`,
  );
  const perkOf = new Map(perks.map((row) => [row.subscriber_id, row]));
  let withPerk = 0;
  for (const { row, message } of messages) {
    if (row.template !== 'welcome') continue;
    const perk = perkOf.get(row.subscriber_id);
    if (perk === undefined) {
      assert.ok(
        !message.text.includes(referralLadderCopy.partnerWelcome.named),
        `${row.id}: no perk line`,
      );
      continue;
    }
    withPerk += 1;
    assert.ok(
      message.text.includes(
        referralLadderCopy.partnerWelcome.named + perk.code,
      ),
      `${row.id}: names ${perk.code}`,
    );
    assert.match(
      message.text,
      new RegExp(`\\b${perk.welcome_discount_pct}%`, 'u'),
    );
  }
  assert.ok(withPerk >= 40, `${withPerk} partner-referred welcomes`);

  // The digest names its founder note and counts only, never a person.
  const digest = messages.find(
    ({ row }) => row.template === partnerDigestTemplate,
  )!.message;
  assert.ok(digest.text.includes(auditDigestNote));
});

test('the copy check catches each planted problem, and passes the site’s own forms', () => {
  // Each problem, planted.
  assert.match(copyIssues('Earn passive income.').join(), /passive income/u);
  assert.match(copyIssues('Grow your downline.').join(), /downline/u);
  assert.match(copyIssues('Unlimited earnings').join(), /unlimited/u);
  assert.match(copyIssues('Join the team today').join(), /"team"/u);
  assert.match(copyIssues('Welcome aboard!').join(), /exclamation/u);
  assert.match(copyIssues('Your code: {code}').join(), /placeholder/u);
  assert.match(copyIssues('Rank undefined').join(), /placeholder/u);
  assert.match(copyIssues('Only 3 left').join(), /urgency/u);
  assert.match(copyIssues('Hurry, it ends in 2 days').join(), /urgency/u);
  assert.deepEqual(sentenceCaseIssues('Join The Partner Programme'), [
    '"The" in "Join The Partner Programme"',
    '"Partner" in "Join The Partner Programme"',
    '"Programme" in "Join The Partner Programme"',
  ]);
  // Word-bounded, as the forbidden-copy gate matches: "steam" is not "team".
  assert.deepEqual(copyIssues('Steam gift cards and teammates'), []);
  // Names, months, codes, numbered labels, list markers and the brand's
  // named programmes keep their capitals.
  for (const line of [
    'Early access from September 2027',
    'Coupon 1: 30% · Coupon 2: 10% · 2 more confirmed referrals to 15%.',
    '3 more confirmed referrals to Coupon 1 at 5%.',
    'You joined through MAYASTUDIO',
    'Share it on TikTok or YouTube',
    'I. Delivered within 24 hours.',
    'The Triple Guarantee',
    'More than triple GameSeal’s commission rate',
  ])
    assert.deepEqual(sentenceCaseIssues(line), [], line);
});
