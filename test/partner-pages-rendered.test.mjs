// E11.7-05: /partners and /partners/apply served by the built app. Asserts
// the programme page's terms and positioning line, the form's controls
// against the field schema, the refused-code round trip as a plain HTML form
// POST with no JavaScript (values kept, alternatives shown), the accepted
// answer, the emailed link's confirmation, and flag off.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { Pool } from 'pg';
import { partnersCopy } from '../src/copy/partners.ts';
import { partnerApplicationFieldNames } from '../src/server/partner/fields.ts';
import { createPool } from '../src/server/db/pool.ts';
import { displayNameDisclosureVersion } from '../src/server/partner/config.ts';
import { createPartnerLeaderboardJob } from '../src/server/partner/leaderboard.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { seedPartnerDashboard } from './helpers/partner-dashboard-fixture.mjs';
import { insertPartner } from './helpers/partner-review-fixture.ts';
import { startAppServer } from './helpers/listen-port.mjs';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

// Turnstile's siteverify, stubbed inside the app process: every non-empty
// token passes, so no request leaves the machine.
const siteverifyStub = `data:text/javascript,${encodeURIComponent(`
  // Exit normally on teardown so V8 records coverage for the built routes.
  process.once('SIGTERM', () => process.exit(0));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      return (body.get('response') ?? '') === ''
        ? Response.json({ success: false, 'error-codes': ['missing-input-response'] })
        : Response.json({ success: true });
    }
    return realFetch(input, init);
  };
`)}`;

const decode = (value) =>
  value
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
const visibleText = (html) =>
  decode(
    html
      .replace(/<(style|script)\b[\s\S]*?<\/\1>/gu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' '),
  );

let admin;
let database;
let name;
let appUrl;
let app;

async function startApp() {
  return startAppServer({
    label: 'Partner pages',
    readyPath: '/privacy',
    cwd: root,
    nodeArguments: ['--import', siteverifyStub],
    env: () => ({
      ADMIN_CREDENTIAL: 'partner-pages-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: appUrl,
      HOST: '127.0.0.1',
      IP_PREFIX_PEPPER: 'partner-pages-prefix-pepper',
      P1_ALERT_WEBHOOK_URL: 'http://127.0.0.1:9/alert',
      P1_ALERT_WEBHOOK_TOKEN: 'partner-pages-alert-token',
      REFERRAL_SIGNING_SECRET: 'partner-pages-referral-secret',
      RESEND_API_KEY: 'partner-pages-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'partner-pages-turnstile-secret',
    }),
  });
}

before(async () => {
  await ensureAppBuild();
  name = 'valstara_partner_pages_' + randomUUID().replaceAll('-', '');
  const adminUrl = new URL(databaseUrl);
  const fixtureUrl = new URL(adminUrl);
  fixtureUrl.pathname = '/' + name;
  const application = new URL(fixtureUrl);
  application.username = 'valstara_app';
  application.password = appPassword;
  appUrl = application.toString();
  admin = new Pool({ connectionString: adminUrl.toString() });
  await admin.query('CREATE DATABASE "' + name + '"');
  database = new Pool({ connectionString: fixtureUrl.toString() });
  await executeFile(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'e11-7-05-pages-test'],
    {
      cwd: root,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: fixtureUrl.toString(),
        VALSTARA_APP_DB_PASSWORD: appPassword,
      },
    },
  );
  app = await startApp();
});

after(async () => {
  await app?.stop();
  await database?.end();
  if (admin !== undefined) {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    await admin.query('DROP DATABASE "' + name + '"');
    await admin.end();
  }
});

const origin = () => 'http://127.0.0.1:' + app.port;
const get = (path) => globalThis.fetch(origin() + path);
// A plain HTML form submission, as a browser with JavaScript off sends it.
// The addresses are at a domain with a published MX record, as the signup
// rendered tests use, because the app runs the real domain screen.
const post = (path, fields) =>
  globalThis.fetch(origin() + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin(),
    },
    body: new globalThis.URLSearchParams(fields),
  });

function applicationFields(overrides = {}) {
  const fields = [
    ['turnstile_token', 'turnstile-ok'],
    ['full_name', 'Rendered Maya'],
    ['email_address', 'renderedmaya@gmail.com'],
    ['country_of_residence', 'SE'],
    ['partner_type', 'creator'],
    ['channels', 'tiktok'],
    ['channels', 'discord'],
    ['handles', '@rendered-maya'],
    ['audience_size', '1k_10k'],
    ['promotion_plan', 'Weekly price round-ups for my community.'],
    ['requested_code', 'RENDERMAYA'],
    ['age_confirmed', 'yes'],
    ['programme_terms_agreed', 'yes'],
  ].filter(([key]) => !(key in overrides));
  for (const [key, value] of Object.entries(overrides))
    if (value !== null) fields.push([key, value]);
  return fields;
}

function applicationForm(html) {
  const match =
    /<form\b[^>]*data-partner-application[^>]*>([\s\S]*?)<\/form>/u.exec(html);
  assert.ok(match, 'the application form renders');
  return match[1];
}

test('/partners states the founder’s terms and positioning line, with an apply link', async () => {
  const response = await get('/partners');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  const text = visibleText(html);
  for (const statement of [
    'You recommend. Your audience saves. You earn 10% of what they buy.',
    'until one year after public launch, on 1 October 2028',
    'One level only',
    "covered by Valstara's guarantee",
    'there is no lifetime lock',
    'Earnings start with early access in September 2027.',
    "more than triple GameSeal's commission rate",
    'double the rate of G2A and Eneba',
  ])
    assert.ok(text.includes(statement), statement);
  // The brief's superseded terms are gone (epic decisions 2 and 3).
  for (const retired of [
    /12 months/u,
    /about double/iu,
    /founding partners keep/iu,
    /July 2027/u,
  ])
    assert.doesNotMatch(text, retired);
  assert.match(html, /href="\/partners\/apply"/u);
  assert.equal((html.match(/<h1\b/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /challenges\.cloudflare\.com/u);
});

test('/partners/apply renders exactly the field schema’s controls, with Turnstile and the membership line', async () => {
  const response = await get('/partners/apply');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const html = await response.text();
  const form = applicationForm(html);
  const names = [
    ...new Set(
      [
        ...form.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/gu),
      ].map((match) => match[1]),
    ),
  ].sort();
  assert.deepEqual(names, [...partnerApplicationFieldNames].sort());
  assert.match(form, /class="cf-turnstile"/u);
  assert.match(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/u);
  // The country is a plain dropdown, with no preselected country.
  assert.match(form, /<select\b[^>]*name="country_of_residence"/u);
  assert.doesNotMatch(form, /<option value="[A-Z]{2}"[^>]*selected/u);
  const text = visibleText(form);
  assert.ok(text.includes(partnersCopy.apply.membership.waitlist));
  assert.ok(text.includes(partnersCopy.apply.ageStatement));
  // giveaway.open is off by default, so no giveaway claim is made.
  assert.ok(!text.includes(partnersCopy.apply.freeEntryDisclosure));
});

// E11.7-12: the auto-invite's link fills in the invited member's address.
test('the auto-invite link pre-fills the email field only, and a malformed value fills nothing', async () => {
  const address = 'invited.member+tag@example.test';
  const response = await get(
    `/partners/apply?email=${encodeURIComponent(address)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  // The address in the URL never leaves in a referrer.
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const form = applicationForm(await response.text());
  const values = [
    ...form.matchAll(/<input\b[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"/gu),
  ]
    .filter(([, , value]) => value !== '')
    .map(([, name, value]) => [name, decode(value)]);
  // Checkbox options carry their own fixed values; no typed field but the
  // address is filled.
  const typed = values.filter(
    ([name]) =>
      !['channels', 'age_confirmed', 'programme_terms_agreed'].includes(name),
  );
  assert.deepEqual(typed, [['email_address', address]]);

  for (const malformed of [
    'not-an-address',
    '"><b>x</b>@',
    'a'.repeat(250) + '@example.test',
  ]) {
    const html = await (
      await get(`/partners/apply?email=${encodeURIComponent(malformed)}`)
    ).text();
    assert.doesNotMatch(
      applicationForm(html),
      /name="email_address"[^>]*\bvalue="[^"]+"/u,
      malformed,
    );
  }
});

test('a refused code returns the form with the typed values and the alternatives, with no JavaScript', async () => {
  const response = await post(
    '/partners/apply',
    applicationFields({ requested_code: 'netflixdeals' }),
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  const form = applicationForm(html);
  assert.match(form, /name="full_name"[^>]*value="Rendered Maya"/u);
  assert.match(
    form,
    /name="email_address"[^>]*value="renderedmaya@gmail.com"/u,
  );
  assert.match(form, /name="requested_code"[^>]*value="netflixdeals"/u);
  assert.match(form, /name="handles"[^>]*value="@rendered-maya"/u);
  assert.match(form, /<option value="SE" selected/u);
  assert.match(form, /<option value="creator" selected/u);
  assert.match(form, /<option value="1k_10k" selected/u);
  assert.match(form, /value="tiktok" checked/u);
  assert.match(form, /value="discord" checked/u);
  assert.doesNotMatch(form, /value="youtube" checked/u);
  assert.ok(visibleText(form).includes(partnersCopy.apply.errors.blocked));
  const alternatives = /data-code-alternatives[^>]*>([\s\S]*?)<\/div>/u.exec(
    form,
  );
  assert.ok(alternatives, 'the alternatives are listed');
  const codes = [
    ...alternatives[1].matchAll(
      /<li class="partner-apply__alternative[^"]*"[^>]*>([A-Z0-9]{4,16})<\/li>/gu,
    ),
  ].map((match) => match[1]);
  assert.ok(codes.length >= 1 && codes.length <= 3, String(codes));
  // Nothing was stored for the refused application.
  const stored = await database.query(
    `SELECT count(*)::int AS count FROM subscriber WHERE email_normalised = 'renderedmaya@gmail.com'`,
  );
  assert.equal(stored.rows[0].count, 0);

  // The visitor takes an alternative and submits again: accepted.
  const accepted = await post(
    '/partners/apply',
    applicationFields({ requested_code: codes[0] }),
  );
  assert.equal(accepted.status, 200);
  const acceptedHtml = await accepted.text();
  assert.match(acceptedHtml, /data-task-state="accepted"/u);
  assert.ok(
    visibleText(acceptedHtml).includes(partnersCopy.apply.accepted.line),
  );
  const partner = await database.query(
    `SELECT p.status, p.requested_code, p.confirmation_token_id
     FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
     WHERE s.email_normalised = 'renderedmaya@gmail.com'`,
  );
  assert.equal(partner.rows.length, 1);
  assert.equal(partner.rows[0].status, 'unconfirmed');
  assert.equal(partner.rows[0].requested_code, codes[0]);

  // The emailed link: GET shows a confirmation form and consumes nothing;
  // the POST confirms.
  const token = deriveEmailToken(
    partner.rows[0].confirmation_token_id,
    process.env.EMAIL_TOKEN_SECRET,
  );
  const link = await get('/partners/apply?token=' + encodeURIComponent(token));
  assert.equal(link.status, 200);
  const linkHtml = await link.text();
  assert.match(linkHtml, /data-task-state="confirm"/u);
  assert.match(linkHtml, /<input type="hidden" name="token"/u);
  assert.doesNotMatch(linkHtml, /challenges\.cloudflare\.com/u);
  const confirmed = await post('/partners/apply', { token });
  assert.equal(confirmed.status, 200);
  assert.match(await confirmed.text(), /data-task-state="confirmed"/u);
  const after = await database.query(
    `SELECT p.status, s.status AS member FROM partner p
     JOIN subscriber s ON s.id = p.subscriber_id
     WHERE s.email_normalised = 'renderedmaya@gmail.com'`,
  );
  assert.deepEqual(after.rows, [{ status: 'applied', member: 'verified' }]);
  const invalid = await post('/partners/apply', { token: 'not-a-real-link' });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /data-task-state="link-invalid"/u);
});

test('dashboard recovery is Turnstile-first and returns the same rendered acknowledgement for eligible and unknown addresses', async () => {
  const subscriberId = randomUUID();
  const address = 'rendereddashboard@gmail.com';
  await database.query(
    `INSERT INTO subscriber (id, email, email_normalised, email_domain, status, verified_at, referral_code)
      VALUES ($1, $2, $2, 'gmail.com', 'verified', CURRENT_TIMESTAMP, 'DBVIEWER2345')`,
    [subscriberId, address],
  );
  const original = await seedPartnerDashboard(
    database,
    subscriberId,
    process.env.EMAIL_TOKEN_SECRET,
  );
  const referredId = randomUUID();
  const referredEmail = 'dashboard-referred@example.test';
  await database.query(
    `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
      verified_at, referral_code, referred_by_id)
     VALUES ($1, $2, $2, 'example.test', 'verified', '2026-11-05T10:01:00Z',
      'DBFRIEND2345', $3)`,
    [referredId, referredEmail, subscriberId],
  );
  await database.query(
    `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state,
      created_at, confirmed_at, partner_id, welcome_discount_pct, signup_confirmed_count)
     VALUES ($1, $2, $3, 'confirmed', 'none', '2026-11-05T10:00:00Z',
      '2026-11-05T10:01:00Z', $4, 15, 0)`,
    [randomUUID(), subscriberId, referredId, original.partnerId],
  );
  await database.query(
    "UPDATE partner SET display_name = 'Earlier Name', show_on_leaderboard = true WHERE id = $1",
    [original.partnerId],
  );
  const ownerUrl = new URL(databaseUrl);
  ownerUrl.pathname = '/' + name;
  const owner = createPool(ownerUrl.toString());
  const rankingPool = createPool(appUrl);
  let otherPartner;
  try {
    otherPartner = await insertPartner(
      { owner },
      {
        status: 'active',
        fullName: 'Private Application Name',
      },
    );
    await owner.execute({
      text: "UPDATE partner SET display_name = 'Current Nickname', display_name_disclosure_version = $2 WHERE id = $1",
      values: [otherPartner.id, displayNameDisclosureVersion],
    });
    await createPartnerLeaderboardJob(
      rankingPool,
      async () => true,
      () => new Date('2026-11-24T08:00:00Z'),
    ).run();
  } finally {
    await Promise.all([rankingPool.close(), owner.close()]);
  }
  const recoveryPath = '/partners/apply?operation=dashboard-recovery';
  const dashboardPath = '/partners/dashboard';
  const form = await (
    await get(recoveryPath + '&t=never-render-this-bearer')
  ).text();
  assert.match(form, /name="email_address"/u);
  assert.match(form, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/u);
  assert.doesNotMatch(
    form,
    /never-render-this-bearer|name="token"|name="full_name"/u,
  );

  const bucketCount = () =>
    database.query(
      "SELECT count(*)::int AS count FROM rate_limit_bucket WHERE key LIKE 'partner-dashboard:recover:%'",
    );
  const startBuckets = await bucketCount();
  const challengeFailed = await post(recoveryPath, { email_address: address });
  assert.equal(challengeFailed.status, 400);
  assert.match(
    visibleText(await challengeFailed.text()),
    /confirm that request/u,
  );
  assert.deepEqual((await bucketCount()).rows, startBuckets.rows);

  const known = await post(recoveryPath, {
    email_address: 'R.E.N.D.E.R.E.D.DASHBOARD+alias@gmail.com',
    turnstile_token: 'ok',
  });
  const unknown = await post(recoveryPath, {
    email_address: 'unknown-rendered@example.test',
    turnstile_token: 'ok',
  });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, known.status);
  const acknowledgement = await known.text();
  assert.equal(await unknown.text(), acknowledgement);
  assert.match(
    acknowledgement,
    /match your address to an eligible partnership/u,
  );
  assert.doesNotMatch(
    acknowledgement,
    /challenges\.cloudflare\.com|rendereddashboard@gmail/u,
  );
  assert.equal(known.headers.get('set-cookie'), null);

  const limited = await post(recoveryPath, {
    email_address: address,
    turnstile_token: 'ok',
  });
  assert.equal(limited.status, 429);
  const sends = await database.query(
    "SELECT payload FROM email_send WHERE template = 'partner_dashboard_link' AND subscriber_id = $1",
    [subscriberId],
  );
  assert.equal(sends.rows.length, 1);
  const replacementId = sends.rows[0].payload.token_id;
  assert.deepEqual(sends.rows[0].payload, { token_id: replacementId });
  const replacement = deriveEmailToken(
    replacementId,
    process.env.EMAIL_TOKEN_SECRET,
  );

  const show = (token) => get(`${dashboardPath}?t=${token}`);
  const valid = await show(replacement);
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('set-cookie'), null);
  assert.equal(valid.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(valid.headers.get('cache-control'), 'private, no-store');
  assert.equal(valid.headers.get('x-robots-tag'), 'noindex');
  const html = await valid.text();
  assert.match(visibleText(html), /https:\/\/valstara\.com\/r\/DASHBOARD2345/u);
  assert.match(
    visibleText(html),
    /Earnings start with early access in September 2027\./u,
  );
  assert.match(visibleText(html), /fixture-v1/u);
  assert.match(
    visibleText(html),
    /Partner leaderboard As of 2026-11-24T08:00:00.000Z Your rank 1 Rank Partner Confirmed signups 1 Partner 1 2 C\. N\. 0/u,
  );
  assert.match(html, /value="Earlier Name"/u);
  assert.match(
    visibleText(html),
    /Saving a display name lets other partners see your initials on the leaderboard\./u,
  );
  assert.match(visibleText(html), /Use this name for leaderboard sharing/u);
  for (const control of ['confirm_leaderboard_name', 'show_on_leaderboard']) {
    const checkbox = html.match(
      new RegExp(`<input[^>]*name="${control}"[^>]*>`, 'u'),
    );
    assert.ok(checkbox, control);
    assert.doesNotMatch(checkbox[0], /\bchecked\b/u);
  }

  assert.match(
    visibleText(html),
    /\bConfirmed 1 Pending confirmation 0 Voided 0\b/u,
  );
  assert.ok(
    !html.includes(referredId),
    'the referred subscriber ID stays private',
  );
  assert.ok(
    !html.includes(referredEmail),
    'the referred subscriber email stays private',
  );
  assert.doesNotMatch(
    html,
    /page-view\.js|challenges\.cloudflare\.com|rendereddashboard@gmail|Dashboard Fixture/u,
  );
  const oldClaims = `${original.partnerId}.${replacementId}.${randomUUID()}`;
  const oldSignature = deriveEmailToken(
    `partner_dashboard_settings:${oldClaims}`,
    process.env.EMAIL_TOKEN_SECRET,
  );
  const earlier = await post(dashboardPath, {
    settings_token: `${oldClaims}.${oldSignature}`,
    display_name: 'Old form overwrite',
    show_on_leaderboard: 'yes',
  });
  assert.equal(earlier.status, 400);
  assert.match(await earlier.text(), /settings form has expired/u);
  assert.match(await (await show(replacement)).text(), /value="Earlier Name"/u);
  assert.ok(!html.includes(otherPartner.id));
  assert.ok(!html.includes(otherPartner.subscriberId));
  assert.ok(!html.includes(otherPartner.email));
  assert.doesNotMatch(html, /Private Application Name|Current Nickname/u);
  const getRobots = await get('/robots.txt');
  assert.match(await getRobots.text(), /^Disallow: \/partners\/dashboard$/mu);
  const sitemap = await get('/sitemaps/pages.xml');
  assert.doesNotMatch(await sitemap.text(), /\/partners\/dashboard/u);

  const invalid = await show('invalid');
  const retired = await show(original.token);
  assert.equal(retired.status, invalid.status);
  const invalidHtml = await invalid.text();
  assert.doesNotMatch(
    invalidHtml,
    /Partner leaderboard|Earlier Name|Your rank/u,
  );
  const noBearer = await get(dashboardPath);
  assert.equal(await noBearer.text(), invalidHtml);
  for (const path of ['/partners/leaderboard', '/api/partners/leaderboard']) {
    const outside = await get(`${path}?t=${replacement}`);
    assert.equal(outside.status, 404, path);
    assert.doesNotMatch(await outside.text(), /Partner leaderboard|Your rank/u);
  }

  assert.equal(await retired.text(), invalidHtml);
  await database.query(
    "UPDATE verification_token SET expires_at = '2026-01-01T00:00:00Z' WHERE id = $1",
    [replacementId],
  );
  const expired = await show(replacement);
  assert.equal(expired.status, invalid.status);
  assert.equal(await expired.text(), invalidHtml);
  await database.query(
    "UPDATE partner SET status = 'terminated', status_changed_at = CURRENT_TIMESTAMP WHERE id = $1",
    [original.partnerId],
  );
  const terminated = await show(replacement);
  assert.equal(terminated.status, invalid.status);
  assert.equal(await terminated.text(), invalidHtml);
});

test('D-064 rejects other origins and metadata and still requires a valid settings token', async () => {
  const send = (headers, path = '/partners/dashboard') =>
    globalThis.fetch(origin() + path, {
      method: 'POST',
      headers,
      body: new globalThis.URLSearchParams({
        display_name: 'Blocked',
        settings_token: 'invalid',
      }),
    });
  for (const headers of [
    { 'Sec-Fetch-Site': 'same-origin' },
    { Origin: 'https://foreign.example', 'Sec-Fetch-Site': 'same-origin' },
    { Origin: 'null' },
    { Origin: 'null', 'Sec-Fetch-Site': 'same-site' },
    { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    assert.equal((await send(headers)).status, 403, JSON.stringify(headers));
  }
  const matched = { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };
  assert.equal(
    (await send(matched, '/partners/apply?operation=dashboard-recovery'))
      .status,
    403,
  );
  const invalidToken = await send(matched);
  assert.equal(invalidToken.status, 400);
  assert.match(await invalidToken.text(), /settings form has expired/u);
});

test('flag off shows an honest paused message and accepts nothing', async () => {
  await app.stop();
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('partners.enabled', false, 'partner-pages-test')`,
  );
  app = await startApp();
  const page = await get('/partners/apply');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-task-state="paused"/u);
  assert.ok(visibleText(html).includes(partnersCopy.apply.paused));
  assert.doesNotMatch(html, /data-partner-application/u);
  assert.doesNotMatch(html, /challenges\.cloudflare\.com/u);

  const submitted = await post(
    '/partners/apply',
    applicationFields({ email_address: 'pausedrender@gmail.com' }),
  );
  assert.equal(submitted.status, 200);
  assert.match(await submitted.text(), /data-task-state="paused"/u);
  const stored = await database.query(
    `SELECT count(*)::int AS count FROM subscriber WHERE email_normalised = 'pausedrender@gmail.com'`,
  );
  assert.equal(stored.rows[0].count, 0);
  const confirm = await post('/partners/apply', { token: 'any-link' });
  assert.match(
    await confirm.text(),
    /data-task-state="(?:paused|link-invalid)"/u,
  );
  const dashboard = await get('/partners/dashboard?t=invalid');
  assert.equal(dashboard.status, 503);
  assert.match(await dashboard.text(), /The partner programme is paused/u);
  const recovery = await get('/partners/apply?operation=dashboard-recovery');
  assert.equal(recovery.status, 503);
  assert.doesNotMatch(await recovery.text(), /challenges\.cloudflare\.com/u);
});
