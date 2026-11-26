import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import axe from 'axe-core';
import { Pool } from 'pg';
import { chromium } from 'playwright';

import {
  atRestContext,
  checkPageLayout,
  designThemes,
  designWidths,
  settlePage,
} from '../scripts/design/layout-checks.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import {
  containerOwnerArguments,
  removeOrphanedContainers,
} from './helpers/container-owner.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { entranceEnded } from './helpers/motion.mjs';

// E11.8-06: the privacy, accessibility and layout suites on every signup
// placement (the landing hero and its mobile bar, and the price page's call
// to action) and on /me, with `waitlist.age_13` and `giveaway.open` on, so
// the 13+ form, its two boxes and the /me giveaway box are what is checked.
// The flag-off form is what the existing suites already check
// (test/signup-form-rendered-page.test.mjs, test/accessibility.test.mjs).
// The checks are the site's own: the E11-05 crawl's cookie, storage and
// off-origin rules with Turnstile the one sanctioned host, axe-core's WCAG
// 2.2 AA rules and the final-design layout harness, at every design width in
// both themes.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const browserContainer = `valstara-age13-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const wcag22aaTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const turnstileHost = 'challenges.cloudflare.com';

let browser;
let browserServer;
let server;
let origin;
let admin;
let databaseName;
let checkedPaths;

async function startBrowserServer() {
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
      `${root}:/work:ro`,
      '--workdir',
      '/work',
      playwrightImage,
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
  browserServer.stdout.setEncoding('utf8');
  browserServer.stderr.setEncoding('utf8');
  browserServer.stdout.on('data', (chunk) => (output += chunk));
  browserServer.stderr.on('data', (chunk) => (output += chunk));
  try {
    for (let attempt = 0; attempt < 720; attempt += 1) {
      if (output.includes('Listening on'))
        return `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
      if (browserServer.exitCode !== null)
        throw new Error(`The Playwright server exited.\n${output}`);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    throw new Error(`The Playwright server did not start.\n${output}`);
  } catch (error) {
    await stopBrowserServer();
    throw error;
  }
}

async function stopBrowserServer() {
  await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
    (error) => {
      if (!String(error.stderr).includes('No such container')) throw error;
    },
  );
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
}

before(async () => {
  await ensureAppBuild();
  databaseName = `valstara_age13_browser_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const databaseUrl = url.toString();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await execFileAsync(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'e11-8-06-browser-test'],
    {
      cwd: root,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: databaseUrl,
        VALSTARA_APP_DB_PASSWORD: appPassword,
      },
    },
  );
  const database = new Pool({ connectionString: databaseUrl });
  // The flags are set as rows: the enable command refuses waitlist.age_13
  // until E11.8-07, which is what this ticket ships.
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('waitlist.age_13', true, 'e11-8-06-test'),
            ('giveaway.open', true, 'e11-8-06-test')`,
  );
  // A member admitted at 13 who skipped the box: /me shows them not entered,
  // with the 18+ box and the 16+ marketing affirmation.
  const memberId = randomUUID();
  await database.query(
    `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
       verified_at, created_at, referral_code, admission_age_policy)
     VALUES ($1, 'age13-browser@example.test', 'age13-browser@example.test',
       'example.test', 'verified', '2026-10-06T09:00:00Z',
       '2026-10-06T09:00:00Z', 'AGEBROWSER23', '13_plus')`,
    [memberId],
  );
  const tokenId = randomUUID();
  const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET);
  await database.query(
    `INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, 'status', '2099-01-01')`,
    [tokenId, memberId, createHash('sha256').update(token).digest()],
  );
  await database.end();
  checkedPaths = [
    '/',
    '/prices/spotify/sweden',
    `/me?t=${encodeURIComponent(token)}`,
  ];
  server = await startAppServer({
    label: 'E11.8-06 browser checks',
    cwd: root,
    env: (port) => ({
      ADMIN_CREDENTIAL: 'age13-browser-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl.replace(
        /\/\/[^@]+@/u,
        `//valstara_app:${appPassword}@`,
      ),
      EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
      IP_PREFIX_PEPPER: 'age13-browser-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'age13-browser-referral-secret',
      RESEND_API_KEY: 'age13-browser-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'age13-browser-turnstile-secret',
      HOST: '0.0.0.0',
    }),
  });
  origin = `http://host.docker.internal:${server.port}`;
  browser = await chromium.connect(await startBrowserServer());
});

after(async () => {
  await browser?.close();
  await stopBrowserServer();
  await server?.stop();
  if (admin !== undefined) {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

/** Turnstile's script is the one sanctioned off-origin request; stub it. */
async function stubTurnstile(context) {
  await context.route(`https://${turnstileHost}/**`, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
}

test('privacy: with the flag on, the 13+ form and /me set no cookie, store nothing and request nothing off-origin but Turnstile', async () => {
  for (const path of checkedPaths) {
    const context = await browser.newContext();
    try {
      await stubTurnstile(context);
      const page = await context.newPage();
      const offOrigin = [];
      const setCookies = [];
      page.on('request', (request) => {
        const host = new URL(request.url()).host;
        if (new URL(request.url()).origin !== origin) offOrigin.push(host);
      });
      page.on('response', async (response) => {
        if ((await response.headerValue('set-cookie')) !== null)
          setCookies.push(response.url());
      });
      const response = await page.goto(`${origin}${path}`, {
        waitUntil: 'networkidle',
      });
      assert.equal(response?.status(), 200, path);
      if (!path.startsWith('/me')) {
        // The two boxes render unticked and tick independently; typing and
        // ticking stores nothing either.
        const marketing = page.locator('[name="marketing_opt_in"]');
        const giveaway = page.locator('[name="giveaway_opt_in"]');
        assert.equal(await marketing.isChecked(), false, path);
        assert.equal(await giveaway.isChecked(), false, path);
        assert.equal(await marketing.inputValue(), 'v2', path);
        await page.locator('label.signup-giveaway').click();
        assert.equal(await giveaway.isChecked(), true, path);
        assert.equal(await marketing.isChecked(), false, path);
        await page.locator('label.signup-marketing').click();
        await page.locator('label.signup-giveaway').click();
        assert.equal(await giveaway.isChecked(), false, path);
        assert.equal(await marketing.isChecked(), true, path);
        await page.fill('#signup-email', 'age13-browser@example.test');
        await page.waitForLoadState('networkidle');
      } else {
        assert.equal(
          await page.locator('[name="giveaway_opt_in"]').isChecked(),
          false,
        );
      }
      assert.deepEqual(
        [...new Set(offOrigin)].filter((host) => host !== turnstileHost),
        [],
        `${path} off-origin requests`,
      );
      assert.deepEqual(setCookies, [], `${path} Set-Cookie`);
      assert.deepEqual(await context.cookies(), [], `${path} cookies`);
      assert.deepEqual(
        await page.evaluate(() => ({
          local: Object.keys(globalThis.localStorage),
          session: Object.keys(globalThis.sessionStorage),
        })),
        { local: [], session: [] },
        `${path} storage`,
      );
    } finally {
      await context.close();
    }
  }
});

async function axeViolations(page) {
  await entranceEnded(page);
  await settlePage(page);
  if (!(await page.evaluate(() => 'axe' in globalThis)))
    await page.addScriptTag({ content: axe.source });
  return page.evaluate(
    async (tags) =>
      (
        await globalThis.axe.run(globalThis.document, {
          resultTypes: ['violations'],
          runOnly: { type: 'tag', values: tags },
        })
      ).violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
      })),
    wcag22aaTags,
  );
}

test('accessibility: zero WCAG 2.2 AA violations on every placement and /me with the flag on, at every design width in both themes', async () => {
  const found = [];
  for (const path of checkedPaths)
    for (const colorScheme of designThemes) {
      // Each width is a fresh load read at rest, as the layout harness reads
      // it, so no scroll reveal or entrance is caught mid-fade.
      const context = await browser.newContext({
        ...atRestContext,
        colorScheme,
        viewport: { width: designWidths[0], height: 900 },
      });
      try {
        await stubTurnstile(context);
        const page = await context.newPage();
        for (const width of designWidths) {
          await page.setViewportSize({ width, height: 900 });
          const response = await page.goto(`${origin}${path}`, {
            waitUntil: 'load',
            timeout: 60_000,
          });
          assert.equal(response?.status(), 200, path);
          assert.equal(
            await page.locator('[name="giveaway_opt_in"]').count(),
            1,
            `${path} carries the giveaway box`,
          );
          const violations = await axeViolations(page);
          if (violations.length > 0)
            found.push({ path, width, colorScheme, violations });
        }
      } finally {
        await context.close();
      }
    }
  assert.deepEqual(found, [], `axe found violations: ${JSON.stringify(found)}`);
});

test('layout: the final-design checks pass on every placement and /me with the flag on, at every design width in both themes', async () => {
  const found = [];
  for (const path of checkedPaths)
    for (const colorScheme of designThemes) {
      const context = await browser.newContext({
        ...atRestContext,
        colorScheme,
        viewport: { width: designWidths[0], height: 900 },
      });
      try {
        await stubTurnstile(context);
        const page = await context.newPage();
        for (const width of designWidths) {
          await page.setViewportSize({ width, height: 900 });
          const response = await page.goto(`${origin}${path}`, {
            waitUntil: 'load',
            timeout: 60_000,
          });
          assert.equal(response?.status(), 200, path);
          const issues = await checkPageLayout(page);
          if (issues.length > 0)
            found.push({ path, width, colorScheme, issues });
        }
      } finally {
        await context.close();
      }
    }
  assert.deepEqual(found, [], `layout issues: ${JSON.stringify(found)}`);
});
