import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { Pool } from 'pg';

import { emailCopy } from '../src/copy/email.ts';
import { createTransactionalRenderers } from '../src/server/email/transactional-templates.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { renderLanding } from './helpers/landing-render.mjs';
import { startAppServer } from './helpers/listen-port.mjs';

// E11.7-04: the coupon ladder replaces the retired 3-referral tier on every
// surface. No surface still states "15% off at 3 referrals" or a wave
// upgrade, and every coupon mention carries its first-order condition
// (ADR-012's messaging rule).

const root = fileURLToPath(new URL('..', import.meta.url));
const executeFile = promisify(execFile);
const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

// The retired reward's wording, as any surface stated it before E11.7-04.
const retired = [
  /\b15% off\b/iu,
  /launch discount/iu,
  /move up (?:an|one) (?:access )?wave/iu,
  /\bup one access wave\b/iu,
  /wave[- ]upgrade/iu,
  /earlier access wave/iu,
  /\breferral tier\b/iu,
  /\btier \d\b/iu,
  /\bto tier\b/iu,
  /within \d+ days after (?:store )?launch/iu,
  /settled rewards/iu,
];

function retiredMatches(text) {
  return retired.filter((pattern) => pattern.test(text)).map(String);
}

// A surface that mentions a coupon also states what makes it usable.
function heldConditionMissing(text) {
  return /coupon/iu.test(text) && !/first order/iu.test(text);
}

const visibleText = (html) =>
  html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/gu, ' ');

async function filesUnder(directory) {
  const entries = await readdir(join(root, directory), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath ?? entry.path, entry.name).slice(root.length),
    );
}

test('the old-reward scan catches each retired wording and the held-condition check catches a bare coupon', () => {
  for (const planted of [
    '3 confirmed referrals → move up an access wave and 15% off at launch',
    '0 of 3 to Tier 1',
    'Earlier access wave',
    '15% launch discount',
    'Access-wave upgrade',
    'Referral tier',
    'Held discounts require the referred person’s first order within 90 days after store launch.',
  ])
    assert.ok(retiredMatches(planted).length > 0, planted);
  assert.deepEqual(
    retiredMatches('Coupon 1: 30% · 2 more confirmed referrals to 15%.'),
    [],
  );
  assert.equal(heldConditionMissing('Coupon 1: 5%'), true);
  assert.equal(
    heldConditionMissing(
      'Coupon 1: 5%. Usable once one of your referred friends places their first order.',
    ),
    false,
  );
});

test('no file in the copy layer or the content files states the retired reward', async () => {
  const paths = [
    ...(await filesUnder('src/copy')),
    ...(await filesUnder('src/content')),
  ];
  assert.ok(paths.length > 20, 'the scan reads the whole copy layer');
  const found = [];
  for (const path of paths) {
    const source = await readFile(join(root, path), 'utf8');
    for (const match of retiredMatches(source)) found.push(`${path}: ${match}`);
  }
  assert.deepEqual(found, []);
});

test('the privacy policy describes the coupon ladder and its held condition', async () => {
  const privacy = await readFile(join(root, 'src/content/privacy.md'), 'utf8');
  assert.match(privacy, /coupon/iu);
  assert.ok(!heldConditionMissing(privacy));
  assert.doesNotMatch(privacy, /\bmilestone\b/iu);
});

test('the referral emails state the ladder with its held condition and no retired reward', async () => {
  const status = {
    accessWindow: 'wave-1',
    confirmedReferrals: 4,
    giveawayEntries: 2,
    ownRank: 3,
    referralLink: 'https://valstara.com/?ref=ABCDEF234567',
    subscriberStatus: 'verified',
    verificationOrderWindow: 'wave-2',
  };
  const renderers = createTransactionalRenderers({
    baseUrl: 'https://valstara.test',
    sendingDomain: 'send.valstara.com',
    data: {
      referralStatus: async () => status,
      receiptEntries: async () => 1,
      winnerDetails: async () => ({
        deadline: new Date('2027-04-15T09:00:00.000Z'),
        rulesVersion: 'VAL-GW-LAUNCH-20261009-r1',
      }),
    },
  });
  for (const template of ['welcome', 'milestone_reached']) {
    const message = await renderers.get(template).render({
      email: 'reader@example.test',
      payload: { status_token_id: 'status-id', tier: 1 },
      token: async () => 'status-signature',
      unsubscribePageUrl: 'https://valstara.test/unsubscribe?t=x',
    });
    for (const [part, text] of [
      ['text', message.text],
      ['html', visibleText(message.html)],
      ['subject', message.subject],
    ]) {
      assert.deepEqual(retiredMatches(text), [], `${template} ${part}`);
      assert.equal(heldConditionMissing(text), false, `${template} ${part}`);
    }
    assert.match(message.text, /Coupon 1: 5%/u, template);
  }
  assert.equal(emailCopy.milestone.subject, 'Your Valstara referral rewards');
});

test('the landing, verification and member pages state the ladder, each coupon with its held condition, and no retired reward', async () => {
  await ensureAppBuild();
  const { body: landing } = await renderLanding();
  const databaseName = `valstara_ladder_copy_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = applicationRolePassword;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const database = new Pool({ connectionString: databaseUrl.toString() });
  let app;
  try {
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'e11-7-04-ladder-copy-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: databaseUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: applicationRolePassword,
        },
      },
    );
    // A pending signup to verify, and a member past the first 1,000 with 25
    // confirmed referrals: two coupons, wave 1 through referrals.
    const pendingId = randomUUID();
    const verifyTokenId = randomUUID();
    const verifyToken = deriveEmailToken(
      verifyTokenId,
      process.env.EMAIL_TOKEN_SECRET,
    );
    await database.query(
      "INSERT INTO subscriber (id,email,email_normalised,email_domain,status) VALUES ($1,$2,$2,'example.test','pending')",
      [pendingId, 'ladder-verify@example.test'],
    );
    await database.query(
      "INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'verify','2099-01-01T00:00:00Z')",
      [
        verifyTokenId,
        pendingId,
        createHash('sha256').update(verifyToken).digest(),
      ],
    );
    const memberId = randomUUID();
    const statusTokenId = randomUUID();
    const statusToken = deriveEmailToken(
      statusTokenId,
      process.env.EMAIL_TOKEN_SECRET,
    );
    await database.query(
      "INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,referral_code,confirmed_referrals,access_window,verification_order_window) VALUES ($1,$2,$2,'example.test','verified',CURRENT_TIMESTAMP,'LADDER234567',25,'wave-1','wave-3')",
      [memberId, 'ladder-member@example.test'],
    );
    await database.query(
      "INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'status','2099-01-01T00:00:00Z')",
      [
        statusTokenId,
        memberId,
        createHash('sha256').update(statusToken).digest(),
      ],
    );
    app = await startAppServer({
      label: 'Ladder copy surfaces',
      readyPath: '/verify',
      env: () => ({
        ADMIN_CREDENTIAL: 'ladder-copy-admin-credential-32-chars',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL: appUrl.toString(),
        HOST: '127.0.0.1',
        IP_PREFIX_PEPPER: 'ladder-copy-prefix-pepper',
        REFERRAL_SIGNING_SECRET: 'ladder-copy-referral-secret',
        RESEND_API_KEY: 'ladder-copy-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      }),
    });
    const origin = `http://127.0.0.1:${app.port}`;
    const verified = await globalThis.fetch(`${origin}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: origin,
      },
      body: new globalThis.URLSearchParams({ token: verifyToken }),
    });
    assert.equal(verified.status, 200);
    const verifyHtml = await verified.text();
    const memberHtml = await (
      await globalThis.fetch(
        `${origin}/me?t=${encodeURIComponent(statusToken)}`,
      )
    ).text();

    for (const [surface, html] of [
      ['landing', landing],
      ['verify', verifyHtml],
      ['me', memberHtml],
    ]) {
      const text = visibleText(html);
      assert.deepEqual(retiredMatches(text), [], surface);
      assert.match(text, /coupon/iu, `${surface} states the ladder`);
      assert.equal(heldConditionMissing(text), false, surface);
    }
    // The card that names a coupon is the card that states its condition.
    // Every card is the Card primitive's <article>, and none nests another.
    const card = (html, marker) =>
      visibleText(
        new RegExp(
          `<article[^>]*${marker}[^>]*>[\\s\\S]*?</article>`,
          'u',
        ).exec(html)?.[0] ?? '',
      );
    for (const [surface, html, marker] of [
      ['landing', landing, 'data-referral-card'],
      ['verify', verifyHtml, 'data-referral-card'],
      ['me', memberHtml, 'data-member-card="rewards"'],
    ]) {
      const text = card(html, marker);
      assert.match(text, /coupon/iu, `${surface} card`);
      assert.match(text, /first order/iu, `${surface} card`);
    }
    assert.ok(
      visibleText(verifyHtml).includes(
        '3 more confirmed referrals to Coupon 1 at 5%.',
      ),
    );
    const member = visibleText(memberHtml);
    assert.ok(
      member.includes(
        'Coupon 1: 30% · Coupon 2: 10% · 2 more confirmed referrals to 15%.',
      ),
      'the founder form on /me',
    );
    assert.ok(
      member.includes(
        "You're in wave 1, with early access from September 2027, for reaching 3 confirmed referrals.",
      ),
    );
    // Each coupon row carries the condition itself.
    const rows = [
      ...memberHtml.matchAll(
        /<li[^>]*data-coupon="(\d+)"[^>]*>([\s\S]*?)<\/li>/gu,
      ),
    ];
    assert.deepEqual(
      rows.map(([, number]) => number),
      ['1', '2'],
    );
    for (const [, , row] of rows)
      assert.match(visibleText(row), /first order/u);
  } finally {
    await app?.stop();
    await database.end();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    );
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
