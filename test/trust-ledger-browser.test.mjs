import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import {
  containerOwnerArguments,
  removeOrphanedContainers,
} from './helpers/container-owner.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { entranceEnded } from './helpers/motion.mjs';
import { trustLedgerFixtureSite } from './helpers/trust-ledger-fixture-site.mjs';

// E11.8-01: the third-party and storage gates and the accessibility and
// layout checks on `/trust-ledger`, served by the real built app with the
// fixture entries committed and `trust_ledger.page` on, and on the two pages
// that carry its line once an entry is committed (/guarantee, /partners). The
// repository commits no entry before December 2026 (D-076 Q2), so its own
// build has no Ledger page to check. The checks are the site's own: the
// E11-05 crawl's cookie, storage and off-origin rules, axe-core's WCAG 2.2 AA
// rules (test/accessibility.test.mjs) and the final-design layout harness
// (scripts/design/layout-checks.mjs), at every design width in both themes.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const browserContainer = `valstara-trust-ledger-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const wcag22aaTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const checkedPaths = ['/trust-ledger', '/guarantee', '/partners'];

let browser;
let browserServer;
let server;
let origin;
let admin;
let databaseName;

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
  const { root: fixtureRoot } = await trustLedgerFixtureSite();
  databaseName = `valstara_ledger_browser_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const databaseUrl = url.toString();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await execFileAsync(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'trust-ledger-browser-test'],
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
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('trust_ledger.page', true, 'trust-ledger-browser-test')`,
  );
  await database.end();
  server = await startAppServer({
    label: 'Trust Ledger browser checks',
    cwd: fixtureRoot,
    readyPath: '/trust-ledger',
    env: (port) => ({
      ADMIN_CREDENTIAL: 'trust-ledger-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl.replace(
        /\/\/[^@]+@/u,
        `//valstara_app:${appPassword}@`,
      ),
      EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
      IP_PREFIX_PEPPER: 'trust-ledger-browser-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'trust-ledger-browser-referral-secret',
      RESEND_API_KEY: 'trust-ledger-browser-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'trust-ledger-browser-turnstile-secret',
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

test('third-party and storage gates: the Ledger and its linking pages set no cookie, touch no storage and make no off-origin request', async () => {
  for (const path of checkedPaths) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const storageAccess = [];
      const requests = [];
      const setCookies = [];
      await page.exposeBinding('__reportStorageAccess', (_source, entry) => {
        storageAccess.push(entry);
      });
      await page.addInitScript(() => {
        const cookie = Object.getOwnPropertyDescriptor(
          globalThis.Document.prototype,
          'cookie',
        );
        Object.defineProperty(globalThis.Document.prototype, 'cookie', {
          configurable: true,
          get() {
            void globalThis.__reportStorageAccess({ method: 'cookie.get' });
            return cookie.get.call(this);
          },
          set(value) {
            void globalThis.__reportStorageAccess({ method: 'cookie.set' });
            cookie.set.call(this, value);
          },
        });
        for (const method of [
          'getItem',
          'setItem',
          'removeItem',
          'clear',
          'key',
        ]) {
          const original = globalThis.Storage.prototype[method];
          globalThis.Storage.prototype[method] = function (...args) {
            void globalThis.__reportStorageAccess({
              method,
              key: args[0] ?? null,
            });
            return original.apply(this, args);
          };
        }
        for (const name of ['indexedDB', 'caches']) {
          Object.defineProperty(globalThis, name, {
            configurable: true,
            get() {
              void globalThis.__reportStorageAccess({ method: name });
              return undefined;
            },
          });
        }
      });
      page.on('request', (request) =>
        requests.push({ url: request.url(), type: request.resourceType() }),
      );
      page.on('response', async (response) => {
        const header = await response.headerValue('set-cookie');
        if (header !== null) setCookies.push(response.url());
      });
      const response = await page.goto(`${origin}${path}`, {
        waitUntil: 'networkidle',
      });
      assert.equal(response?.status(), 200, `${path} answers`);
      await page.evaluate(() =>
        globalThis.scrollTo({
          top: globalThis.document.documentElement.scrollHeight,
          behavior: 'instant',
        }),
      );
      await page.waitForLoadState('networkidle');
      const offOrigin = requests.filter(
        ({ url }) => new URL(url).origin !== origin,
      );
      assert.deepEqual(offOrigin, [], `${path} made an off-origin request`);
      // The only script is the first-party page-view emitter.
      assert.deepEqual(
        requests
          .filter(({ type }) => type === 'script')
          .map(({ url }) => new URL(url).pathname),
        ['/page-view.js'],
        `${path} scripts`,
      );
      assert.deepEqual(storageAccess, [], `${path} storage access`);
      assert.deepEqual(setCookies, [], `${path} Set-Cookie`);
      assert.deepEqual(await context.cookies(), [], `${path} cookies`);
      assert.deepEqual(
        await page.evaluate(() => ({
          local: globalThis.localStorage.length,
          session: globalThis.sessionStorage.length,
        })),
        { local: 0, session: 0 },
      );
    } finally {
      await context.close();
    }
  }
});

// The runner of test/accessibility.test.mjs: the page at rest, then axe-core's
// WCAG 2.2 AA rules, injected into the test browser only.
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

test('accessibility: zero WCAG 2.2 AA violations on the Ledger and its linking pages, at every design width in both themes', async () => {
  const found = [];
  for (const path of checkedPaths)
    for (const colorScheme of designThemes) {
      const context = await browser.newContext({
        colorScheme,
        viewport: { width: designWidths[0], height: 900 },
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(`${origin}${path}`, {
          waitUntil: 'load',
        });
        assert.equal(response?.status(), 200, `${path} answers`);
        for (const width of designWidths) {
          await page.setViewportSize({ width, height: 900 });
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

test('accessibility: the runner fails on a planted violation on the Ledger', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/trust-ledger`, { waitUntil: 'load' });
    assert.deepEqual(await axeViolations(page), []);
    await page.evaluate(() => {
      const image = globalThis.document.createElement('img');
      image.src = '/favicon.svg';
      globalThis.document.querySelector('main').append(image);
    });
    assert.ok(
      (await axeViolations(page)).some(
        (violation) => violation.id === 'image-alt',
      ),
      'an image without alternative text is reported',
    );
  } finally {
    await context.close();
  }
});

test('layout: the final-design checks pass on the Ledger and its linking pages, at every design width in both themes', async () => {
  const found = [];
  for (const path of checkedPaths)
    for (const colorScheme of designThemes) {
      const context = await browser.newContext({
        ...atRestContext,
        colorScheme,
        viewport: { width: designWidths[0], height: 900 },
      });
      try {
        const page = await context.newPage();
        for (const width of designWidths) {
          await page.setViewportSize({ width, height: 900 });
          const response = await page.goto(`${origin}${path}`, {
            waitUntil: 'load',
          });
          assert.equal(response?.status(), 200, `${path} answers`);
          const issues = await checkPageLayout(page);
          if (issues.length > 0)
            found.push({ path, width, colorScheme, issues });
        }
      } finally {
        await context.close();
      }
    }
  assert.deepEqual(found, [], `layout issues: ${JSON.stringify(found)}`);
  // The harness is live on this page: a planted overflow is reported.
  const context = await browser.newContext({
    ...atRestContext,
    viewport: { width: 320, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/trust-ledger`, { waitUntil: 'load' });
    await page.evaluate(() => {
      const wide = globalThis.document.createElement('p');
      wide.style.width = '480px';
      wide.textContent = 'planted';
      globalThis.document.querySelector('main').append(wide);
    });
    assert.ok(
      (await checkPageLayout(page)).includes('horizontal overflow'),
      'a planted overflow is reported',
    );
  } finally {
    await context.close();
  }
});
