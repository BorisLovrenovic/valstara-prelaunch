import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { Pool } from 'pg';

import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { marketingOptInWordingByVersion } from '../src/copy/marketing.ts';
import { memberStatusCopy } from '../src/copy/member-status.ts';
import { partnersCopy } from '../src/copy/partners.ts';
import { signupFormCopy } from '../src/copy/signup.ts';
import { flagCacheTtlMilliseconds } from '../src/server/flags/service.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import { startAppServer } from './helpers/listen-port.mjs';

// E11.8-06: the age statement, the boxes and the giveaway status on every
// surface, served by the real built app. Off, every signup placement is the
// 18+ form it was; with `waitlist.age_13` on, every surface that states the
// joining age says "13 and over", every giveaway mention says 18 and over,
// the 16+ marketing box carries its new version, the 18+ giveaway box is
// separate and unticked, and /me states each member's real entry status.

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const thirteen = signupFormCopy.ageThirteen;
const signupPlacements = ['/', '/prices/spotify/sweden'];

let admin;
let database;
let databaseName;
let server;
const members = {};
const tokens = {};

before(async () => {
  await ensureAppBuild();
  databaseName = `valstara_age13_render_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  await execFileAsync(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'e11-8-06-rendered-test'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: url.toString(),
        VALSTARA_APP_DB_PASSWORD: appPassword,
      },
    },
  );
  database = new Pool({ connectionString: url.toString() });
  // Three verified members: one admitted at 13 who skipped the box, one who
  // joined at 18 before the flag and holds an entry without it, and one who
  // ticked the box and holds an entry.
  const member = async (label, admission, optIn, entries) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
         verified_at, created_at, referral_code, admission_age_policy,
         giveaway_opt_in_at, giveaway_opt_in_source)
       VALUES ($1, $2, $2, 'example.test', 'verified', $3, $3, $4, $5, $6, $7)`,
      [
        id,
        `age13-${label}@example.test`,
        new Date('2026-10-06T09:00:00.000Z'),
        `AGE${label.toUpperCase().padEnd(9, 'X').slice(0, 9)}`,
        admission,
        optIn ? new Date('2026-10-06T09:00:00.000Z') : null,
        optIn ? 'signup' : null,
      ],
    );
    for (let index = 0; index < entries; index += 1)
      await database.query(
        `INSERT INTO giveaway_entry (id, subscriber_id, method, entries,
           rules_version, rules_sha256)
         VALUES ($1, $2, 'base', 1, 'VAL-GW-LAUNCH-20261126-r1', $3)`,
        [randomUUID(), id, Buffer.alloc(32, 7)],
      );
    const tokenId = randomUUID();
    const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET);
    await database.query(
      `INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, $3, 'status', '2099-01-01')`,
      [tokenId, id, createHash('sha256').update(token).digest()],
    );
    members[label] = id;
    tokens[label] = token;
  };
  await member('skipped', '13_plus', false, 0);
  await member('earlier', '18_plus', false, 1);
  await member('ticked', '13_plus', true, 1);
  server = await startAppServer({
    label: 'E11.8-06 rendered',
    cwd: projectRoot,
    env: (port) => ({
      ADMIN_CREDENTIAL: 'age13-rendered-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: (() => {
        const appUrl = new URL(url);
        appUrl.username = 'valstara_app';
        appUrl.password = appPassword;
        return appUrl.toString();
      })(),
      EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
      IP_PREFIX_PEPPER: 'age13-rendered-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'age13-rendered-referral-secret',
      RESEND_API_KEY: 'age13-rendered-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'age13-rendered-turnstile-secret',
      HOST: '127.0.0.1',
    }),
  });
});

after(async () => {
  await server?.stop();
  await database?.end();
  if (admin !== undefined) {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

async function setFlags(values) {
  for (const [key, enabled] of Object.entries(values))
    await database.query(
      `INSERT INTO campaign_flag (key, enabled, updated_by)
       VALUES ($1, $2, 'e11-8-06-test')
       ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [key, enabled],
    );
  await new Promise((resolve) =>
    globalThis.setTimeout(resolve, flagCacheTtlMilliseconds + 500),
  );
}

async function page(path) {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${server.port}${path}`,
    { signal: globalThis.AbortSignal.timeout(15_000) },
  );
  assert.equal(response.status, 200, path);
  return response.text();
}

function decode(text) {
  return text
    .replace(/&#39;|’/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"');
}

/** The text of every element matching the opening-tag pattern. */
function texts(html, opening, tag) {
  return [
    ...html.matchAll(
      new RegExp(`<${tag}\\b[^>]*${opening}[^>]*>([\\s\\S]*?)</${tag}>`, 'gu'),
    ),
  ].map((match) =>
    decode(match[1].replace(/<[^>]+>/gu, ''))
      .replace(/\s+/gu, ' ')
      .trim(),
  );
}

/** Every `<input>` tag in the signup form, as written. */
function inputs(html) {
  const start = html.indexOf('<form action="/api/signup"');
  const end = html.indexOf('</form>', start);
  assert.ok(start > 0 && end > start, 'the signup form is present');
  return [...html.slice(start, end).matchAll(/<input\b[^>]*>/gu)].map(
    (match) => match[0],
  );
}

const ageLines = (html) => texts(html, 'class="signup-age"', 'p');
const membership = (html) =>
  texts(html, 'data-partner-membership', 'p')[0] ?? '';
/** The giveaway fact's value on /me's status card, or null without one. */
const fact = (html) => {
  const match = html.match(
    /data-member-field="giveawayEntries"[^>]*>[\s\S]*?<dd\b[^>]*>([\s\S]*?)<\/dd>/u,
  );
  return match === null
    ? null
    : decode(match[1].replace(/<[^>]+>/gu, ''))
        .replace(/\s+/gu, ' ')
        .trim();
};

test('flag off: every signup placement is the 18+ form it was, with no giveaway box and no age field', async () => {
  await setFlags({ 'giveaway.open': true });
  for (const path of signupPlacements) {
    const html = await page(path);
    const lines = ageLines(html);
    assert.equal(lines.length, 2, `${path}: the hero and the bar`);
    for (const line of lines) {
      assert.ok(line.startsWith(signupFormCopy.ageStatement), line);
      assert.doesNotMatch(line, /13 and over/u);
    }
    const fields = inputs(html);
    assert.equal(
      fields.filter((tag) => /name="giveaway_opt_in"/u.test(tag)).length,
      0,
    );
    assert.equal(
      fields.filter((tag) => /name="age_policy"/u.test(tag)).length,
      0,
    );
    assert.ok(
      fields.some((tag) => /name="marketing_opt_in"[^>]*value="v1"/u.test(tag)),
    );
    assert.ok(
      decode(html).includes(marketingOptInWordingByVersion.v1),
      `${path}: the 18+ marketing wording`,
    );
    assert.doesNotMatch(decode(html), /16 or over/u);
  }
  // D-050 unchanged: confirming joins the waitlist and enters the giveaway.
  const apply = membership(await page('/partners/apply'));
  assert.ok(
    apply.startsWith(
      `${partnersCopy.apply.membership.waitlistAndGiveaway} ${partnersCopy.apply.ageStatement}`,
    ),
    apply,
  );
});

test('flag off: /me states the real entry status, offers no box, and pauses new marketing grants for a member admitted at 13', async () => {
  const skipped = await page(`/me?t=${encodeURIComponent(tokens.skipped)}`);
  assert.equal(fact(skipped), memberStatusCopy.authenticated.notEntered);
  assert.doesNotMatch(skipped, /<form\b[^>]*data-giveaway-form/u);
  assert.match(skipped, /<p\b[^>]*data-marketing-paused/u);
  assert.doesNotMatch(skipped, /<button\b[^>]*data-marketing-switch/u);
  assert.ok(decode(skipped).includes(memberStatusCopy.marketing.grantPaused));
  const earlier = await page(`/me?t=${encodeURIComponent(tokens.earlier)}`);
  assert.equal(fact(earlier), '1');
  assert.doesNotMatch(earlier, /<form\b[^>]*data-giveaway-form|<p\b[^>]*data-marketing-paused/u);
  assert.match(earlier, /<button\b[^>]*data-marketing-switch/u);
  assert.doesNotMatch(earlier, /name="marketing_age_affirmed"/u);
});

test('flag on: every signup placement says 13 and over, says the giveaway is 18 and over, and carries both unticked boxes and its policy', async () => {
  await setFlags({ 'giveaway.open': true, 'waitlist.age_13': true });
  for (const path of signupPlacements) {
    const html = await page(path);
    const lines = ageLines(html);
    assert.equal(lines.length, 2, `${path}: the hero and the bar`);
    for (const line of lines) {
      assert.ok(
        line.startsWith(
          `${thirteen.ageStatement} ${thirteen.giveawayAgeStatement}`,
        ),
        line,
      );
      assert.doesNotMatch(line, /aged 18 and over\.$|Open to people aged 18/u);
    }
    const fields = inputs(html);
    const box = fields.filter((tag) => /name="giveaway_opt_in"/u.test(tag));
    const marketing = fields.filter((tag) =>
      /name="marketing_opt_in"/u.test(tag),
    );
    assert.equal(box.length, 1, `${path}: one giveaway box`);
    assert.equal(marketing.length, 1, `${path}: one marketing box`);
    for (const tag of [...box, ...marketing]) {
      assert.match(tag, /type="checkbox"/u);
      assert.doesNotMatch(tag, /\bchecked\b|\brequired\b/u, tag);
    }
    assert.match(box[0], /value="yes"/u);
    assert.match(marketing[0], /value="v2"/u);
    assert.notEqual(
      box[0].match(/id="([^"]+)"/u)?.[1],
      marketing[0].match(/id="([^"]+)"/u)?.[1],
    );
    assert.ok(
      fields.some((tag) => /name="age_policy"[^>]*value="13_plus"/u.test(tag)),
    );
    const text = decode(html);
    assert.ok(text.includes(thirteen.giveawayOptIn), `${path}: the box label`);
    assert.ok(text.includes(marketingOptInWordingByVersion.v2), path);
    assert.ok(!text.includes(marketingOptInWordingByVersion.v1), path);
    assert.doesNotMatch(text, /Open to people aged 18 and over/u);
  }
  // The landing's giveaway card still says 18 and over.
  assert.match(decode(await page('/')), /No purchase necessary · 18 and over/u);
  // The application: joining, and entering from /me, at 18 and over.
  const apply = membership(await page('/partners/apply'));
  assert.ok(
    apply.startsWith(partnersCopy.apply.membership.waitlistThenGiveaway),
    apply,
  );
  assert.doesNotMatch(apply, /Open to people aged 18 and over/u);
});

test('flag on: /me shows each member their real status and offers the 18+ box only to members without it', async () => {
  const skipped = decode(
    await page(`/me?t=${encodeURIComponent(tokens.skipped)}`),
  );
  assert.equal(fact(skipped), memberStatusCopy.authenticated.notEntered);
  assert.match(skipped, /<form[^>]*action="\/api\/me\/giveaway"/u);
  assert.ok(skipped.includes(memberStatusCopy.giveaway.body));
  assert.ok(skipped.includes(memberStatusCopy.giveaway.optIn));
  const box = skipped.match(/<input\b[^>]*name="giveaway_opt_in"[^>]*>/u)?.[0];
  assert.ok(box);
  assert.match(box, /\brequired\b/u);
  assert.doesNotMatch(box, /\bchecked\b/u);
  // The 16+ marketing wording and its affirmation.
  assert.ok(skipped.includes(memberStatusCopy.marketing.sixteen.wording));
  assert.match(
    skipped,
    /<input\b[^>]*name="marketing_age_affirmed"[^>]*\brequired\b/u,
  );
  assert.doesNotMatch(skipped, /<p\b[^>]*data-marketing-paused/u);

  const earlier = decode(
    await page(`/me?t=${encodeURIComponent(tokens.earlier)}`),
  );
  assert.equal(fact(earlier), '1');
  assert.match(earlier, /<form\b[^>]*data-giveaway-form/u);
  assert.ok(earlier.includes(memberStatusCopy.giveaway.bodyHeld));
  assert.ok(!earlier.includes(memberStatusCopy.giveaway.body));

  const ticked = decode(
    await page(`/me?t=${encodeURIComponent(tokens.ticked)}`),
  );
  assert.equal(fact(ticked), '1');
  assert.doesNotMatch(ticked, /<form\b[^>]*data-giveaway-form/u);
  assert.ok(!ticked.includes(memberStatusCopy.authenticated.notEntered));
});
