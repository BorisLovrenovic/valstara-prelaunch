// E11.7-11: the asset kit on the built app. The dashboard's kit (the QR code
// and its downloads, the flyer link, the filled message templates) decodes to
// the bearer's own /r/{CODE} link; the print flyer prints on exactly one page
// at A4 and at US Letter, and its printed QR code scans; neither page makes a
// third-party request, sets a cookie or stores anything; the empty kit shows
// no downloads section; a paused partner gets no kit; and the welcome email's
// two links open live pages.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import axe from 'axe-core';
import jsQR from 'jsqr';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import sharp from 'sharp';

import { checkPageLayout } from '../scripts/design/layout-checks.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { partnerDashboardCopy } from '../src/copy/partner-dashboard.ts';
import { createPartnerWelcomeRepository } from '../src/server/db/partner-welcome.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createEmailService } from '../src/server/email/service.ts';
import { partnerMessageTemplates } from '../src/server/partner/kit.ts';
import { partnerApplicationRenderers } from '../src/server/partner/templates.ts';
import { createPartnerWelcomeJob } from '../src/server/partner/welcome.ts';
import {
  deriveEmailToken,
  emailTokenSecret,
  hashEmailToken,
} from '../src/server/verification/token-derivation.ts';
import {
  containerOwnerArguments,
  removeOrphanedContainers,
} from './helpers/container-owner.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const browserImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = 'valstara-partner-flyer-' + process.pid;
const secret = emailTokenSecret();
const copy = partnerDashboardCopy;
const siteLink = (code) => `https://valstara.com/r/${code}`;
const evidence = `${root}.design-contact-sheets/e11-7-11`;

let admin;
let database;
let name;
let appUrl;
let app;
let browserServer;
let browser;
let active;
let paused;

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

async function scan(image) {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}

function fromDataUri(uri, type) {
  const prefix = `data:${type};base64,`;
  assert.ok(uri.startsWith(prefix), `a ${type} download`);
  return Buffer.from(uri.slice(prefix.length), 'base64');
}

async function seedPartner(code, status) {
  const subscriberId = randomUUID();
  const partnerId = randomUUID();
  const linkId = randomUUID();
  const email = `${code.toLowerCase()}@example.test`;
  await database.query(
    `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
      created_at, verified_at, referral_code)
     VALUES ($1, $2, $2, 'example.test', 'verified', '2026-11-01Z', '2026-11-01Z', $3)`,
    [subscriberId, email, `M${code}`.slice(0, 12)],
  );
  await database.query(
    `INSERT INTO partner (id, subscriber_id, status, status_changed_at,
      submitted_at, applied_at, full_name, country_of_residence, partner_type,
      channels, handles, audience_size, promotion_plan, requested_code,
      age_confirmed, programme_terms_agreed, contract_sent_at, contract_signed_at,
      contract_version)
    VALUES ($1, $2, 'active', '2026-11-02Z', '2026-11-02Z', '2026-11-02Z',
      'Flyer Fixture', 'SE', 'creator', ARRAY['tiktok'], ARRAY['@fixture'],
      'under_1k', 'A video', $3, true, true, '2026-11-02Z', '2026-11-02',
      'fixture-v1')`,
    [partnerId, subscriberId, code],
  );
  await database.query(
    "INSERT INTO referral_code (code, owner_kind, owner_id) VALUES ($1, 'partner', $2)",
    [code, partnerId],
  );
  await database.query('SELECT set_partner_code_active($1, true)', [partnerId]);
  if (status === 'paused') {
    await database.query("UPDATE partner SET status = 'paused' WHERE id = $1", [
      partnerId,
    ]);
  }
  const token = deriveEmailToken(linkId, secret);
  await database.query(
    `INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at)
      VALUES ($1, $2, $3, 'partner_dashboard', '2099-01-01Z')`,
    [linkId, subscriberId, hashEmailToken(token)],
  );
  await database.query(
    'UPDATE partner SET dashboard_token_id = $2 WHERE id = $1',
    [partnerId, linkId],
  );
  return { partnerId, subscriberId, code, token, email };
}

async function startApp() {
  return startAppServer({
    label: 'Partner flyer',
    readyPath: '/privacy',
    cwd: root,
    env: () => ({
      ADMIN_CREDENTIAL: 'partner-flyer-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: appUrl,
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'partner-flyer-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'partner-flyer-referral-secret',
      RESEND_API_KEY: 'partner-flyer-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'partner-flyer-turnstile-secret',
    }),
  });
}

before(async () => {
  await ensureAppBuild();
  name = 'valstara_partner_flyer_' + randomUUID().replaceAll('-', '');
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
    ['tsx', 'src/server/db/run-migrations.ts', 'e11-7-11-flyer-test'],
    {
      cwd: root,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: fixtureUrl.toString(),
        VALSTARA_APP_DB_PASSWORD: appPassword,
      },
    },
  );
  active = await seedPartner('FLYER2345', 'active');
  paused = await seedPartner('PAUSED2345', 'paused');
  app = await startApp();

  await removeOrphanedContainers();
  browserServer = spawn(
    'docker',
    [
      'run',
      ...containerOwnerArguments(),
      '--rm',
      '--name',
      browserContainer,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--publish',
      '127.0.0.1::3000',
      '--volume',
      root + ':/work:ro',
      '--workdir',
      '/work',
      browserImage,
      '/work/node_modules/.bin/playwright',
      'run-server',
      '--host',
      '0.0.0.0',
      '--port',
      '3000',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  browserServer.stdout.on('data', (chunk) => {
    output += chunk;
  });
  browserServer.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (
    let attempt = 0;
    attempt < 240 && !output.includes('Listening on');
    attempt += 1
  ) {
    if (browserServer.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  assert.match(output, /Listening on/u);
  browser = await chromium.connect(
    'ws://127.0.0.1:' + (await publishedPort(browserContainer, 3000)) + '/',
  );
});

after(async () => {
  await browser?.close();
  await executeFile('docker', ['rm', '--force', browserContainer]).catch(
    () => {},
  );
  if (browserServer && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
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

const hostOrigin = () => 'http://127.0.0.1:' + app.port;
const browserOrigin = () => 'http://host.docker.internal:' + app.port;
const get = (path) => globalThis.fetch(hostOrigin() + path);
const dashboardPath = (token) =>
  `/partners/dashboard?t=${encodeURIComponent(token)}`;
const flyerPath = (token) =>
  `/partners/dashboard/flyer?t=${encodeURIComponent(token)}`;

function privateHeaders(response, path) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex', path);
  assert.equal(response.headers.get('set-cookie'), null, path);
}

/** Every URL the markup would load: scripts, styles, images and frames. */
function loadedUrls(html) {
  return [
    ...html.matchAll(
      /<(?:script|img|iframe|source|video|audio|embed)\b[^>]*\bsrc="([^"]*)"/gu,
    ),
    // A canonical or alternate link names a page; it loads nothing.
    ...[...html.matchAll(/<link\b([^>]*)>/gu)]
      .filter((match) => !/\brel="(?:canonical|alternate)"/u.test(match[1]))
      .map((match) => /\bhref="([^"]*)"/u.exec(match[1]) ?? ['', '']),
  ].map((match) => decode(match[1]));
}

test('the dashboard kit carries the bearer’s own QR code, flyer link and filled templates, and no downloads section while the kit is empty', async () => {
  const path = dashboardPath(active.token);
  const response = await get(path);
  assert.equal(response.status, 200);
  privateHeaders(response, path);
  const html = await response.text();
  const kit = /<section[^>]*id="partner-kit"[\s\S]*?<\/section>/u.exec(html);
  assert.ok(kit, 'the kit section renders');
  const section = kit[0];
  const text = visibleText(section);
  assert.ok(text.includes(copy.kit.heading));
  const link = siteLink(active.code);

  const svg = /<svg\b[\s\S]*?<\/svg>/u.exec(section)?.[0];
  assert.ok(svg, 'the QR code is inline');
  assert.equal(await scan(Buffer.from(svg)), link);
  const downloads = [
    ...section.matchAll(
      /<a\b[^>]*href="(data:[^"]+)"[^>]*download="([^"]+)"/gu,
    ),
  ];
  assert.deepEqual(
    downloads.map((match) => match[2]),
    ['valstara-flyer2345-qr.png', 'valstara-flyer2345-qr.svg'],
  );
  assert.equal(
    await scan(fromDataUri(decode(downloads[0][1]), 'image/png')),
    link,
  );
  assert.equal(
    await scan(fromDataUri(decode(downloads[1][1]), 'image/svg+xml')),
    link,
  );

  assert.match(
    section,
    new RegExp(
      `href="${flyerPath(active.token).replace(/[?+]/gu, '\\$&')}"`,
      'u',
    ),
  );
  const bodies = [
    ...section.matchAll(
      /<p class="dashboard__message-body[^"]*"[^>]*>([\s\S]*?)<\/p>/gu,
    ),
  ].map((match) => decode(match[1]));
  assert.equal(bodies.length, partnerMessageTemplates.length);
  for (const body of bodies) {
    assert.ok(body.includes(link), 'each template holds the own link');
    assert.ok(body.includes(`${active.code}`), 'and the own code');
    assert.doesNotMatch(body, /[{}]/u);
    assert.ok(!body.includes(paused.code), 'never another partner’s');
  }
  // P10 ships empty: no downloads heading, no empty state.
  assert.doesNotMatch(html, /data-kit-downloads/u);
  assert.ok(!visibleText(html).includes(copy.kit.downloadsHeading));
  for (const url of loadedUrls(html)) {
    assert.ok(url.startsWith('/'), `${url} is first-party`);
  }
});

test('the flyer shows the QR code, code, link and welcome perk; invalid, paused and flag-off states show no flyer', async () => {
  const path = flyerPath(active.token);
  const response = await get(path);
  assert.equal(response.status, 200);
  privateHeaders(response, path);
  const html = await response.text();
  const flyer = /<article[^>]*data-flyer[\s\S]*?<\/article>/u.exec(html)?.[0];
  assert.ok(flyer);
  const text = visibleText(flyer);
  assert.ok(text.includes(siteLink(active.code)));
  assert.ok(text.includes(active.code));
  // No confirmed referrals yet: friends get 10%.
  assert.ok(text.includes(copy.flyer.perk('September 2027', 10)));
  const svg = /<svg\b[\s\S]*?<\/svg>/u.exec(flyer)?.[0];
  assert.equal(await scan(Buffer.from(svg)), siteLink(active.code));
  assert.doesNotMatch(html, /data-kit-downloads/u);
  assert.match(html, /<meta name="robots" content="noindex"/u);
  for (const url of loadedUrls(html)) {
    assert.ok(url.startsWith('/'), `${url} is first-party`);
  }
  assert.match(
    html,
    new RegExp(
      `href="${dashboardPath(active.token).replace(/[?+]/gu, '\\$&')}"`,
      'u',
    ),
  );

  for (const token of ['invalid', 'A'.repeat(43)]) {
    const invalid = await get(flyerPath(token));
    assert.equal(invalid.status, 200);
    const body = await invalid.text();
    assert.doesNotMatch(body, /data-flyer/u);
    assert.ok(visibleText(body).includes(copy.invalid));
    assert.match(
      body,
      /href="\/partners\/apply\?operation=dashboard-recovery"/u,
    );
  }

  const pausedFlyer = await get(flyerPath(paused.token));
  assert.equal(pausedFlyer.status, 200);
  const pausedHtml = await pausedFlyer.text();
  assert.doesNotMatch(pausedHtml, /data-flyer/u);
  assert.ok(visibleText(pausedHtml).includes(copy.sharing.paused));
  const pausedDashboard = await (await get(dashboardPath(paused.token))).text();
  assert.match(pausedDashboard, /data-task-state="authenticated"/u);
  assert.doesNotMatch(pausedDashboard, /id="partner-kit"/u);
});

test('the flyer prints on exactly one page at A4 and US Letter, and its printed QR code scans', async () => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    const response = await page.goto(browserOrigin() + flyerPath(active.token));
    assert.equal(response?.status(), 200);
    await page.waitForLoadState('load');
    for (const format of ['A4', 'Letter']) {
      const pdf = await page.pdf({ format });
      // The print evidence for the PR, in the git-ignored contact-sheet
      // folder (docs/brand/page-design.md#layout-evidence).
      await mkdir(evidence, { recursive: true });
      await writeFile(`${evidence}/flyer-${format}.pdf`, pdf);
      const pages = pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/gu);
      assert.equal(pages?.length, 1, `${format} prints on one page`);
    }
    // The printed sheet, as print media renders it, in the dark theme: the
    // flyer keeps dark-on-white, and the QR code on it still scans.
    await page.emulateMedia({ media: 'print' });
    for (const hidden of ['.site-header', '.site-footer', '.task-card__head']) {
      assert.equal(
        await page.locator(hidden).first().isVisible(),
        false,
        `${hidden} is not printed`,
      );
    }
    await page.screenshot({
      path: `${evidence}/flyer-print-dark.png`,
      fullPage: true,
    });
    const shot = await page.locator('[data-flyer]').screenshot();
    assert.equal(await scan(shot), siteLink(active.code));
    const colours = await page
      .locator('[data-flyer]')
      .evaluate((node) => [
        globalThis.getComputedStyle(node).color,
        globalThis.getComputedStyle(node).backgroundColor,
      ]);
    assert.deepEqual(colours, ['rgb(23, 23, 51)', 'rgb(255, 255, 255)']);

    const offOrigin = requests.filter(
      (url) => new URL(url).origin !== browserOrigin(),
    );
    assert.deepEqual(offOrigin, [], 'no third-party request');
    assert.deepEqual(await context.cookies(), []);
    assert.deepEqual(
      await page.evaluate(() => [
        Object.keys(globalThis.localStorage).filter(
          (key) => key !== 'valstara-theme',
        ),
        Object.keys(globalThis.sessionStorage),
      ]),
      [[], []],
    );
  } finally {
    await context.close();
  }
});

test('the flyer and the dashboard kit pass axe and the layout checks at 320 and 1440 in both themes', async () => {
  for (const path of [flyerPath(active.token), dashboardPath(active.token)]) {
    for (const width of [320, 1440]) {
      for (const colorScheme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme,
          reducedMotion: 'reduce',
        });
        try {
          const page = await context.newPage();
          await page.goto(browserOrigin() + path);
          await page.addScriptTag({ content: axe.source });
          const violations = await page.evaluate(async () =>
            (
              await globalThis.axe.run(globalThis.document, {
                runOnly: {
                  type: 'tag',
                  values: [
                    'wcag2a',
                    'wcag2aa',
                    'wcag21a',
                    'wcag21aa',
                    'wcag22aa',
                  ],
                },
              })
            ).violations.map(
              (violation) =>
                `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
            ),
          );
          assert.deepEqual(violations, [], `${path} ${width} ${colorScheme}`);
          assert.deepEqual(
            await checkPageLayout(page),
            [],
            `${path} ${width} ${colorScheme} layout`,
          );
        } finally {
          await context.close();
        }
      }
    }
  }
});

test('the welcome email’s dashboard and flyer links open live pages', async () => {
  const owner = new URL(appUrl);
  owner.username = new URL(databaseUrl).username;
  owner.password = new URL(databaseUrl).password;
  const pool = createPool(appUrl);
  const clock = () => new Date();
  try {
    const sent = [];
    const email = createEmailService(pool, {
      clock,
      tokenSecret: secret,
      baseUrl: 'https://valstara.com',
      providers: new Map([
        [
          'resend',
          {
            id: 'resend',
            sendingDomain: 'send.valstara.com',
            capabilities: {
              broadcast: false,
              contactSync: false,
              dailyFreeCap: 100,
            },
            async send({ message }) {
              sent.push(message);
              return { providerMessageId: randomUUID() };
            },
          },
        ],
      ]),
      renderers: partnerApplicationRenderers(
        'https://valstara.com',
        'send.valstara.com',
        {
          welcomeCode: (tokenId) =>
            createPartnerWelcomeRepository(pool).codeForDashboardToken(tokenId),
        },
      ),
      isBroadcastEnabled: async () => false,
      operatorTask: async () => assert.fail('unexpected failed email'),
    });
    const welcomed = await seedPartner('WELCOME2345', 'active');
    assert.equal(
      await createPartnerWelcomeJob(pool, {
        clock,
        email,
        tokenSecret: secret,
      }).run(100),
      2,
      'both active partners are welcomed; the paused one is not',
    );
    await email.dispatch(100);
    const message = sent.find((entry) => entry.to === welcomed.email);
    assert.ok(message);
    const links = [
      ...(message.html ?? '').matchAll(/<a\b[^>]*\bhref="([^"]*)"/gu),
    ]
      .map((match) => new URL(decode(match[1])))
      .filter((url) => url.pathname.startsWith('/partners/dashboard'));
    assert.deepEqual(
      links.map((url) => url.pathname),
      ['/partners/dashboard', '/partners/dashboard/flyer'],
    );
    const [dashboard, flyer] = await Promise.all(
      links.map((url) => get(url.pathname + url.search)),
    );
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /id="partner-kit"/u);
    assert.equal(flyer.status, 200);
    const flyerHtml = await flyer.text();
    assert.match(flyerHtml, /data-flyer/u);
    assert.ok(visibleText(flyerHtml).includes(welcomed.code));
    // The seeded fixture link was replaced by the welcome's.
    const replaced = await get(dashboardPath(welcomed.token));
    assert.doesNotMatch(await replaced.text(), /id="partner-kit"/u);
  } finally {
    await pool.close();
  }
});

test('flag off: the flyer says the programme is paused', async () => {
  await app.stop();
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('partners.enabled', false, 'partner-flyer-test')
     ON CONFLICT (key) DO UPDATE SET enabled = false`,
  );
  app = await startApp();
  const response = await get(flyerPath(active.token));
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.doesNotMatch(html, /data-flyer/u);
  assert.ok(visibleText(html).includes(copy.paused));
});
