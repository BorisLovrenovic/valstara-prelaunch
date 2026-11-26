import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from 'playwright';
import { Pool } from 'pg';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { sourcePagePaths } from './helpers/page-inventory.mjs';
import { seedPartnerDashboard } from './helpers/partner-dashboard-fixture.mjs';
import {
  priceFixtureInputs,
  priceFixtureSite,
} from './helpers/price-fixture-site.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { createPriceSite } from '../src/server/prices/site.ts';
import { committedPriceData, inPool } from './helpers/price-audit.mjs';
import {
  partnerAuditStates,
  runPartnerSeed,
} from './helpers/partner-audit.mjs';
import {
  containerOwnerArguments,
  removeOrphanedContainers,
} from './helpers/container-owner.mjs';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const browserContainer = `valstara-e1105-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const emailTokenSecret = 'privacy-test-email-token-secret-32-chars';
const turnstileHost = 'challenges.cloudflare.com';
const turnstileTestSiteKey = '1x00000000000000000000AA';
const turnstileStorageKey = 'cf.turnstile.u';
// E11.5-10: unknown routes answer with the branded 404 page. The branded 500
// page has no URL of its own; it is crawled where it is served, as the
// response to a render that fails because the database is unreachable.
const notFoundPaths = new Set([
  '/404',
  '/not-a-page',
  '/giveaway/rules/not-a-version',
  // E11.6-10: a service × market pair the data does not generate.
  '/prices/not-a-service/sweden',
  // E11.6-12: a service and a market with no page have no hub.
  '/prices/not-a-service',
  '/prices/countries/not-a-market',
  // E11.6-13: a month with no report file has no page.
  '/price-index/2026-11',
]);
// E11.6-10: the price pages of the site being crawled (the price fixture
// site's, in the price crawl). Each carries the signup form, so each is a
// protected page with one protected form.
const pricePagePaths = new Set();
const inducedServerErrorPath = '/me?t=induced-render-error';
const unreachableDatabaseUrl =
  'postgresql://valstara_app:unreachable@127.0.0.1:1/valstara_unreachable';
const protectedPages = new Set([
  '/',
  '/verify',
  '/me',
  '/dsr',
  '/giveaway/award',
  // E11.7-05: the partner application form.
  '/partners/apply',
]);

function expectedProtectedFormCount(url) {
  if (url.pathname === '/') return 1;
  if (pricePagePaths.has(url.pathname)) return 1;
  if (url.pathname === '/dsr') return url.searchParams.has('t') ? 0 : 1;
  // The emailed link's confirmation is token-authenticated, with no widget.
  if (url.pathname === '/partners/apply')
    return url.searchParams.has('token') ? 0 : 1;
  if (url.pathname === '/verify') return url.searchParams.has('token') ? 0 : 1;
  if (url.pathname === '/me') {
    return url.searchParams.has('t') && url.searchParams.get('t') !== 'invalid'
      ? 2
      : 1;
  }
  if (url.pathname === '/giveaway/award') {
    return url.searchParams.has('award') &&
      url.searchParams.get('award') !== 'invalid'
      ? 1
      : 0;
  }
  return 0;
}

async function startBrowser() {
  await removeOrphanedContainers();
  const child = spawn(
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
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  try {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (output.includes('Listening on')) {
        return {
          browser: await chromium.connect(
            `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`,
          ),
          child,
        };
      }
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    throw new Error(`Playwright container did not start: ${output}`);
  } catch (error) {
    // A browser that fails to start must not outlive the test: its running
    // `docker run` client would keep this file's process, and the run, alive.
    await executeFile('docker', ['rm', '--force', browserContainer]).catch(
      () => {},
    );
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    throw error;
  }
}

async function withDatabase(run) {
  const name = `valstara_e1105_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const appUrl = new URL(url);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const database = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE "${name}"`);
  try {
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'e11-05-page-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: url.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    await run(database, appUrl.toString());
  } finally {
    await database.end();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
}

async function seedEmailLinkedPages(database) {
  const verifiedId = randomUUID();
  const pendingId = randomUUID();
  await database.query(
    `INSERT INTO subscriber
      (id, email, email_normalised, email_domain, status, verified_at,
       referral_code, access_window)
     VALUES ($1, 'privacy-owner@example.test', 'privacy-owner@example.test',
       'example.test', 'verified', $3, 'PRIVACY23456', 'wave-1'),
       ($2, 'privacy-pending@example.test', 'privacy-pending@example.test',
       'example.test', 'pending', NULL, NULL, NULL)`,
    [verifiedId, pendingId, new Date('2026-10-01T00:00:00.000Z')],
  );
  const tokens = {};
  for (const [purpose, subscriberId] of [
    ['status', verifiedId],
    ['unsubscribe', verifiedId],
    ['verify', pendingId],
  ]) {
    const id = randomUUID();
    const token = createHmac('sha256', emailTokenSecret)
      .update(id, 'utf8')
      .digest('base64url');
    await database.query(
      `INSERT INTO verification_token
        (id, subscriber_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        subscriberId,
        createHash('sha256').update(token).digest(),
        purpose,
        new Date('2099-01-01T00:00:00.000Z'),
      ],
    );
    tokens[purpose] = token;
  }
  const drawId = randomUUID();
  const entryId = randomUUID();
  const awardId = randomUUID();
  const rulesVersion = 'VAL-GW-LAUNCH-20261009-r1';
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('giveaway.open', true, 'privacy-audit')
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`,
  );
  await database.query(
    `INSERT INTO giveaway_draw (id, executed_by)
     VALUES ($1, 'privacy-audit')`,
    [drawId],
  );
  await database.query(
    `INSERT INTO giveaway_entry
       (id, subscriber_id, method, entries, rules_version, rules_sha256)
     VALUES ($1, $2, 'base', 1, $3, decode($4, 'hex'))`,
    [entryId, verifiedId, rulesVersion, 'ab'.repeat(32)],
  );
  await database.query(
    `INSERT INTO giveaway_draw_snapshot_row
       (draw_id, entry_id, subscriber_id, method, rules_version, rules_sha256)
     VALUES ($1, $2, $3, 'base', $4, decode($5, 'hex'))`,
    [drawId, entryId, verifiedId, rulesVersion, 'ab'.repeat(32)],
  );
  await database.query(
    `INSERT INTO giveaway_draw_selection
       (draw_id, position, subscriber_id, entry_id, is_winner)
     VALUES ($1, 1, $2, $3, true)`,
    [drawId, verifiedId, entryId],
  );
  await database.query(
    `UPDATE giveaway_draw SET
       snapshot_committed_at = '2026-10-01T00:00:00Z',
       entry_snapshot_hash = decode($2, 'hex'), snapshot_count = 1,
       prize_count = 1, rules_version = $3,
       rules_sha256 = decode($4, 'hex'),
       drand_chain_hash = decode($5, 'hex'), drand_chain_info = '{}'::jsonb,
       target_round = 1, target_round_at = '2026-10-01T00:06:00Z'
     WHERE id = $1`,
    [drawId, 'cd'.repeat(32), rulesVersion, 'ab'.repeat(32), 'ef'.repeat(32)],
  );
  await database.query(
    `UPDATE giveaway_draw SET state = 'published', seed = $2,
       seed_generated_at = '2026-10-01T00:01:00Z', beacon_round = 1,
       beacon_randomness = decode($3, 'hex'),
       beacon_signature = decode($4, 'hex'), beacon_relay_used = 'test',
       beacon_verified_relays = '["one", "two"]'::jsonb,
       winners = $5::jsonb, reproduced_at = '2026-10-01T00:02:00Z',
       published_at = '2026-10-01T00:02:00Z' WHERE id = $1`,
    [
      drawId,
      'ab'.repeat(32),
      '12'.repeat(32),
      '34'.repeat(48),
      JSON.stringify([verifiedId]),
    ],
  );
  await database.query(
    `INSERT INTO giveaway_award
       (id, draw_id, prize_slot, entry_snapshot_hash, selection_position,
        entry_id, subscriber_id, notified_at, response_deadline_at)
     VALUES ($1, $2, 1, decode($3, 'hex'), 1, $4, $5,
       '2026-10-01T00:03:00Z', '2099-01-01T00:00:00Z')`,
    [awardId, drawId, 'cd'.repeat(32), entryId, verifiedId],
  );
  const dashboard = await seedPartnerDashboard(
    database,
    verifiedId,
    emailTokenSecret,
  );
  return { ...tokens, awardId, dashboard: dashboard.token };
}

async function withServer(databaseUrl, run, cwd = undefined) {
  // A reserved port below the kernel's ephemeral range (see
  // test/helpers/listen-port.mjs).
  const app = await startAppServer({
    label: 'Privacy-audit',
    readyPath: '/privacy',
    cwd,
    env: (port) => ({
      ADMIN_CREDENTIAL: 'privacy-test-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl,
      EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
      EMAIL_TOKEN_SECRET: emailTokenSecret,
      RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
      BREVO_WEBHOOK_TOKEN: 'privacy-test-brevo-webhook-token-32-chars',
      IP_PREFIX_PEPPER: 'privacy-test-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'privacy-test-referral-secret',
      RESEND_API_KEY: 'privacy-test-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'privacy-test-turnstile-secret',
      HOST: '0.0.0.0',
    }),
  });
  const origin = `http://127.0.0.1:${app.port}`;
  try {
    await run(origin);
  } finally {
    await app.stop();
  }
}

async function crawl(
  browser,
  origin,
  path,
  storageMutation,
  {
    serverError = false,
    notFound = notFoundPaths.has(path),
    // E11.7-15: the asset kit shows only while the partner is active
    // (E11.7-11); a paused partner's authenticated dashboard has none.
    partnerKit = true,
  } = {},
) {
  const pageUrl = new URL(`http://valstara.test${path}`);
  const expectedForms = serverError ? 0 : expectedProtectedFormCount(pageUrl);
  const page = await browser.newPage();
  const requests = [];
  const turnstileResponses = [];
  const storageAccess = [];
  try {
    await page.exposeBinding('__reportStorageAccess', (_source, entry) => {
      storageAccess.push(entry);
    });
    await page.addInitScript(() => {
      const storageAreas = {
        local: globalThis.localStorage,
        session: globalThis.sessionStorage,
      };
      Object.defineProperty(globalThis, '__readStorageInventory', {
        value: () => ({
          local: Object.keys(storageAreas.local),
          session: Object.keys(storageAreas.session),
        }),
      });
      const cookie = Object.getOwnPropertyDescriptor(
        globalThis.Document.prototype,
        'cookie',
      );
      if (cookie?.get && cookie?.set) {
        Object.defineProperty(globalThis.Document.prototype, 'cookie', {
          configurable: true,
          get() {
            void globalThis.__reportStorageAccess({
              method: 'cookie.get',
              origin: globalThis.location.origin,
            });
            return cookie.get.call(this);
          },
          set(value) {
            void globalThis.__reportStorageAccess({
              method: 'cookie.set',
              origin: globalThis.location.origin,
            });
            cookie.set.call(this, value);
          },
        });
      }
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
            area: this === storageAreas.local ? 'local' : 'session',
            origin: globalThis.location.origin,
          });
          return original.apply(this, args);
        };
      }
      for (const [area, name] of [
        ['local', 'localStorage'],
        ['session', 'sessionStorage'],
      ]) {
        const storage = storageAreas[area];
        const proxy = new Proxy(storage, {
          ownKeys(target) {
            void globalThis.__reportStorageAccess({
              method: 'keys.enumerate',
              key: null,
              area,
              origin: globalThis.location.origin,
            });
            return Reflect.ownKeys(target);
          },
          get(target, property) {
            if (
              property === 'length' ||
              (typeof property === 'string' &&
                !(property in globalThis.Storage.prototype))
            ) {
              void globalThis.__reportStorageAccess({
                method: 'property.get',
                key: property === 'length' ? null : property,
                area,
                origin: globalThis.location.origin,
              });
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        Object.defineProperty(globalThis, name, {
          configurable: true,
          get: () => proxy,
        });
      }
    });
    page.on('request', (request) => requests.push(request.url()));
    page.on('response', (response) => {
      if (new URL(response.url()).hostname === turnstileHost)
        turnstileResponses.push({
          url: response.url(),
          status: response.status(),
        });
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'valstara.test') {
        if (url.hostname === turnstileHost) {
          await route.continue();
        } else {
          await route.abort();
        }
        return;
      }
      const response = await globalThis.fetch(
        `${origin}${url.pathname}${url.search}`,
      );
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(
          [...response.headers].filter(([name]) =>
            [
              'content-type',
              'referrer-policy',
              'cache-control',
              'set-cookie',
              'x-robots-tag',
            ].includes(name),
          ),
        ),
        body: globalThis.Buffer.from(await response.arrayBuffer()),
      });
    });
    const response = await page.goto(pageUrl.toString(), {
      waitUntil: expectedForms > 0 ? 'load' : 'networkidle',
    });
    const protectedForms = page.locator(
      'form:has(.cf-turnstile), form:has([data-turnstile-container])',
    );
    const protectedFormCount = await protectedForms.count();
    assert.equal(
      protectedFormCount,
      expectedForms,
      `${path} protected-form count`,
    );
    if (pageUrl.pathname === '/') {
      // E11.5-12: the provider logos. Every catalogue, hero and final banner
      // logo is brought into view, sideways tracks included, so a lazy image
      // loads, and every one must come from this origin's showcase files.
      await page.evaluate(async () => {
        const frame = () =>
          new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const { document } = globalThis;
        for (
          let top = 0;
          top < document.documentElement.scrollHeight;
          top += globalThis.innerHeight / 2
        ) {
          globalThis.scrollTo({ top, behavior: 'instant' });
          await frame();
        }
        for (const track of document.querySelectorAll('.provider-rail__track'))
          for (
            let left = 0;
            left < track.scrollWidth;
            left += track.clientWidth / 2
          ) {
            track.scrollIntoView({ behavior: 'instant', block: 'center' });
            track.scrollLeft = left;
            await frame();
          }
        globalThis.scrollTo({ top: 0, behavior: 'instant' });
      });
      await page.waitForFunction(() =>
        [
          ...globalThis.document.querySelectorAll(
            'img[src*="/images/providers/"]',
          ),
        ].every((image) => image.complete && image.naturalWidth > 0),
      );
      const showcase = JSON.parse(
        await readFile(`${root}/src/content/provider-showcase.json`, 'utf8'),
      );
      const logoRequests = requests.filter((url) =>
        new URL(url).pathname.startsWith('/images/providers/'),
      );
      assert.deepEqual(
        [...new Set(logoRequests.map((url) => new URL(url).pathname))].sort(),
        [...new Set(showcase.map(({ logo }) => logo))].sort(),
        '/ loads every showcase logo, and only those',
      );
      assert.deepEqual(
        logoRequests.filter((url) => new URL(url).hostname !== 'valstara.test'),
        [],
        '/ loads every provider logo from its own origin',
      );
    }
    if (pageUrl.pathname === '/' || pricePagePaths.has(pageUrl.pathname)) {
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector('valstara-signup-form form')
            ?.noValidate,
      );
      await page.locator('#signup-email').fill('privacy-probe@example.test');
    }
    if (protectedFormCount > 0) {
      const siteKeys = await protectedForms.evaluateAll((forms) =>
        forms.map(
          (form) =>
            form
              .closest('valstara-signup-form')
              ?.getAttribute('data-sitekey') ??
            form.querySelector('.cf-turnstile')?.getAttribute('data-sitekey'),
        ),
      );
      assert.deepEqual(
        siteKeys,
        Array(protectedFormCount).fill(turnstileTestSiteKey),
        `${path} must use Cloudflare's always-pass test site key`,
      );
      try {
        await page.waitForFunction(
          () =>
            [...globalThis.document.querySelectorAll('form')]
              .filter((form) =>
                form.querySelector('.cf-turnstile, [data-turnstile-container]'),
              )
              .every(
                (form) =>
                  (form.querySelector('input[name="turnstile_token"]')?.value ??
                    '') !== '',
              ),
          undefined,
          { timeout: 15_000 },
        );
      } catch {
        assert.fail(
          `${path} protected form did not produce a Turnstile token before submit`,
        );
      }
      const tokens = await protectedForms
        .locator('input[name="turnstile_token"]')
        .evaluateAll((elements) => elements.map((element) => element.value));
      assert.equal(
        tokens.length,
        protectedFormCount,
        `${path} has a token in every protected form`,
      );
      assert.ok(
        tokens.every((token) => token !== ''),
        `${path} has no empty protected-form token`,
      );
      await page.waitForTimeout(5_000);
      assert.ok(
        turnstileResponses.some((entry) => {
          const url = new URL(entry.url);
          return (
            entry.status === 200 &&
            url.hostname === turnstileHost &&
            url.pathname.endsWith('/api.js')
          );
        }),
        `${path} Turnstile loader must execute successfully`,
      );
      assert.ok(
        turnstileResponses.some(
          (entry) =>
            entry.status === 200 &&
            new URL(entry.url).pathname.startsWith(
              '/cdn-cgi/challenge-platform/',
            ),
        ),
        `${path} active Turnstile widget must load its challenge`,
      );
    }
    assert.ok(response, `${path} has a response`);
    const pathname = pageUrl.pathname;
    const html = await page.content();
    if (serverError) {
      assert.equal(response.status(), 500, `${path} induced render error`);
      assert.match(html, /data-task-state="server-error"/u);
    } else if (notFound) {
      assert.equal(response.status(), 404, `${path} unknown route`);
      assert.match(html, /data-task-state="not-found"/u);
    } else {
      assert.ok(
        response.status() < 500,
        `${path} must not be a server error (got ${response.status()})`,
      );
    }
    if (storageMutation) {
      await page.evaluate(storageMutation);
    }
    const query = pageUrl.searchParams;
    if (
      pathname === '/partners/dashboard' ||
      pathname === '/partners/dashboard/flyer'
    ) {
      const headers = await response.allHeaders();
      assert.equal(headers['referrer-policy'], 'no-referrer', path);
      assert.equal(headers['cache-control'], 'private, no-store', path);
      assert.equal(headers['x-robots-tag'], 'noindex', path);
      assert.equal(headers['set-cookie'], undefined, path);
      assert.doesNotMatch(html, /page-view\.js/u, path);
      const scripts = await page
        .locator('script:not([type="application/ld+json"])')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            src: node.getAttribute('src'),
            body: node.textContent,
          })),
        );
      assert.equal(
        scripts.length,
        2,
        `${path} must ship only the theme shell scripts`,
      );
      assert.ok(
        scripts.some(
          ({ src, body }) => src === null && body.includes('valstara-theme'),
        ),
        path,
      );
      assert.ok(
        scripts.some(
          ({ src, body }) =>
            src === null &&
            body.includes('customElements.define') &&
            body.includes('valstara-theme-toggle'),
        ),
        path,
      );
      const authenticated = query.has('t') && query.get('t') !== 'invalid';
      if (pathname === '/partners/dashboard') {
        assert.equal(
          await page.locator('input[name="settings_token"]').count(),
          authenticated ? 1 : 0,
        );
        assert.equal(
          await page
            .locator('a[href="/partners/apply?operation=dashboard-recovery"]')
            .count(),
          1,
        );
        // E11.7-11: the asset kit renders for the authenticated partner
        // whose link credits signups.
        assert.equal(
          await page.locator('#partner-kit').count(),
          authenticated && partnerKit ? 1 : 0,
        );
      } else {
        assert.equal(
          await page.locator('[data-flyer]').count(),
          authenticated ? 1 : 0,
        );
        assert.equal(
          await page
            .locator('a[href="/partners/apply?operation=dashboard-recovery"]')
            .count(),
          authenticated ? 0 : 1,
        );
      }
      // P10 ships empty: no downloads section on either page.
      assert.equal(await page.locator('[data-kit-downloads]').count(), 0);
    }
    if (
      pathname === '/partners/apply' &&
      query.get('operation') === 'dashboard-recovery'
    ) {
      const form = page.locator('form:has(.cf-turnstile)');
      assert.equal(await form.locator('input[type="email"]').count(), 1);
      assert.equal(
        await form
          .locator(
            'input[name="settings_token"], input[name="token"], input[name="t"]',
          )
          .count(),
        0,
      );
    }
    if (pathname === '/dsr' && query.has('t')) {
      assert.ok(
        !html.includes('challenges.cloudflare.com'),
        `${path} must be token-authenticated without Turnstile`,
      );
      assert.ok(
        html.includes('name="token"'),
        `${path} must carry its purpose-bound token`,
      );
    }
    if (
      !serverError &&
      pathname === '/me' &&
      query.has('t') &&
      query.get('t') !== 'invalid'
    ) {
      assert.ok(
        html.includes('data-member-dashboard'),
        `${path} must render the own-bearer view`,
      );
    }
    if (
      pathname === '/giveaway/award' &&
      query.has('t') &&
      query.get('t') !== 'invalid'
    ) {
      assert.ok(
        html.includes('name="step" type="hidden" value="checks"'),
        `${path} must render the provisional winner's own check form`,
      );
    }
    const storage = await page.evaluate(() =>
      globalThis.__readStorageInventory(),
    );
    assert.deepEqual(
      storage.local,
      [],
      `${path} wrote first-party local storage`,
    );
    assert.deepEqual(
      storage.session,
      [],
      `${path} wrote session storage during page load`,
    );
    assert.deepEqual(
      await page.context().cookies(),
      [],
      `${path} set a cookie`,
    );
    const offOrigin = requests.filter(
      (url) => new URL(url).hostname !== 'valstara.test',
    );
    const hosts = new Set(offOrigin.map((url) => new URL(url).hostname));
    const hasTurnstileForm =
      html.includes('class="cf-turnstile"') ||
      html.includes('data-turnstile-container');
    if (pathname === '/') {
      assert.ok(hasTurnstileForm, 'the signup page has a protected form');
    }
    assert.equal(
      hasTurnstileForm,
      protectedFormCount > 0,
      `${path} protected-form inventory disagrees with markup`,
    );
    assert.equal(
      hosts.has(turnstileHost),
      hasTurnstileForm,
      `${path} must load Turnstile exactly when its protected form is rendered`,
    );
    for (const host of hosts) {
      assert.ok(
        host === turnstileHost,
        `${path} requested unapproved host ${host}`,
      );
    }
    const isProtectedPage =
      protectedPages.has(pathname) || pricePagePaths.has(pathname);
    if (hosts.has(turnstileHost)) {
      assert.ok(
        isProtectedPage,
        `${path} loaded Turnstile outside a protected page`,
      );
      assert.match(html, /turnstile_token/u, `${path} needs a Turnstile form`);
    }
    if (!isProtectedPage) {
      assert.ok(!hosts.has(turnstileHost), `${path} loaded Turnstile`);
    }
    if (pathname === '/legit') {
      assert.match(html, /We do not show a Trustpilot star rating/u);
      assert.match(
        html,
        /href="https:\/\/www\.trustpilot\.com\/review\/valstara\.com" rel="noopener"/u,
      );
    }
    assert.ok(
      !requests.some(
        (url) => new URL(url).hostname === 'static.cloudflareinsights.com',
      ),
      `${path} loaded Cloudflare Web Analytics auto-injection`,
    );
    if (html.includes('page-view.js')) {
      assert.ok(
        /<script defer(?:="")? src="\/page-view\.js"/u.test(html),
        `${path} has a same-origin emitter`,
      );
    }
    assert.deepEqual(
      storageAccess.filter(
        (entry) =>
          entry.method.startsWith('cookie.') ||
          (!(
            entry.key === 'valstara-theme' &&
            entry.origin === pageUrl.origin &&
            entry.area === 'local'
          ) &&
            !(
              protectedFormCount > 0 &&
              entry.origin === `https://${turnstileHost}` &&
              entry.area === 'local' &&
              entry.key === turnstileStorageKey
            )),
      ),
      [],
      `${path} accessed unlisted browser storage or cookies`,
    );
    if (protectedFormCount === 0) {
      assert.deepEqual(
        storageAccess.filter(
          (entry) =>
            entry.key !== 'valstara-theme' ||
            entry.origin !== pageUrl.origin ||
            entry.area !== 'local',
        ),
        [],
        `${path} without a protected form accessed storage beyond the theme preference`,
      );
    }
    return { path, status: response.status(), offOrigin };
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await page.close();
  }
}

test('E11-05 allowlist has only the Turnstile host', async () => {
  const allowlist = JSON.parse(
    await readFile(`${root}/scripts/ci/privacy-allowlist.json`, 'utf8'),
  );
  assert.deepEqual(
    allowlist.thirdPartyRequests.map((entry) => entry.host).sort(),
    [turnstileHost],
  );
  assert.equal(
    allowlist.thirdPartyRequests.find((entry) => entry.host === turnstileHost)
      .disclosureContract.article5_3Basis,
    'strictly-necessary-form-security',
  );
  assert.deepEqual(
    allowlist.thirdPartyRequests.find((entry) => entry.host === turnstileHost)
      .disclosureContract.processorStorage,
    {
      origin: `https://${turnstileHost}`,
      key: turnstileStorageKey,
      area: 'local',
      scope: 'active-protected-form',
    },
  );
  const emitter = await readFile(`${root}/public/page-view.js`, 'utf8');
  assert.match(emitter, /fetch\('\/analytics\/api\/send'/u);
  assert.doesNotMatch(emitter, /static\.cloudflareinsights\.com/u);
});

test(
  'E11-05 crawls every rendered route and completes Turnstile on every protected form',
  { timeout: 240_000 },
  async () => {
    await ensureAppBuild();
    const inventory = await sourcePagePaths();
    assert.ok(inventory.astro.length > 0, 'rendered pages must be inventoried');
    const errorPages = ['/not-a-page', '/giveaway/rules/not-a-version'];
    const remote = await startBrowser();
    try {
      await withDatabase(async (database, databaseUrl) => {
        const tokens = await seedEmailLinkedPages(database);
        const emailLinked = [
          '/verify?token=invalid',
          `/verify?token=${encodeURIComponent(tokens.verify)}`,
          '/me?t=invalid',
          `/me?t=${encodeURIComponent(tokens.status)}`,
          '/unsubscribe?t=invalid',
          `/unsubscribe?t=${encodeURIComponent(tokens.unsubscribe)}`,
          '/giveaway/award?award=invalid&t=invalid',
          `/giveaway/award?award=${tokens.awardId}&t=${encodeURIComponent(tokens.status)}`,
          '/dsr?t=invalid',
          '/dsr?operation=delete',
          '/dsr?operation=delete&t=invalid',
          '/partners/apply?token=invalid',
          '/partners/apply?operation=dashboard-recovery',
          '/partners/dashboard?t=invalid',
          `/partners/dashboard?t=${encodeURIComponent(tokens.dashboard)}`,
          // E11.7-11: the print flyer, behind the same private link.
          '/partners/dashboard/flyer?t=invalid',
          `/partners/dashboard/flyer?t=${encodeURIComponent(tokens.dashboard)}`,
        ];
        assert.ok(inventory.routes.includes('/404'));
        assert.ok(inventory.routes.includes('/500'));
        const paths = [
          ...inventory.routes.filter((route) => route !== '/500'),
          ...emailLinked,
          ...errorPages,
        ];
        await withServer(databaseUrl, async (origin) => {
          await assert.rejects(
            crawl(remote.browser, origin, '/privacy', () => {
              void globalThis.localStorage.length;
            }),
            /accessed unlisted browser storage or cookies/u,
            'direct storage length read must fail the page inventory',
          );
          await assert.rejects(
            crawl(remote.browser, origin, '/privacy', () => {
              void globalThis.localStorage['unlisted-key'];
            }),
            /accessed unlisted browser storage or cookies/u,
            'direct storage key read must fail the page inventory',
          );
          await assert.rejects(
            crawl(remote.browser, origin, '/privacy', () => {
              Object.keys(globalThis.localStorage);
            }),
            /accessed unlisted browser storage or cookies/u,
            'storage key enumeration must fail the page inventory',
          );
          const observations = [];
          for (const path of paths)
            observations.push(await crawl(remote.browser, origin, path));
          assert.equal(observations.length, paths.length);
        });
        await withServer(unreachableDatabaseUrl, async (origin) => {
          await crawl(
            remote.browser,
            origin,
            inducedServerErrorPath,
            undefined,
            { serverError: true },
          );
        });
      });
    } finally {
      await remote.browser.close();
      await executeFile('docker', ['rm', '--force', browserContainer]).catch(
        () => {},
      );
      if (remote.child.exitCode === null) {
        const exited = once(remote.child, 'exit');
        remote.child.kill();
        await exited;
      }
    }
  },
);

test(
  'E11-05 crawls every price page kind on the price fixture site: no cookie, no storage beyond the theme, no third party beyond Turnstile',
  { timeout: 300_000 },
  async () => {
    // E11.6-10: the price route is a data route. The repository's data has
    // no page yet, so its page kinds are crawled on the site built over the
    // price-page fixture dataset: a generated page, the same with ?ref=, a
    // ledger URL whose data is lost, and a pair that generates nothing.
    // E11.6-12: and `/prices`, a service hub, a market hub, a retired URL
    // (which redirects to its hub), and a service and a market with no hub.
    // E11.6-13: and `/price-index`, each monthly report, and a month with no
    // report.
    const inventory = await sourcePagePaths();
    // E11.8-01: `/trust-ledger` is a data route too, crawled with the same
    // rules on the Trust Ledger fixture site by
    // test/trust-ledger-browser.test.mjs.
    assert.deepEqual(inventory.dataRoutes, [
      '/price-index/[month]',
      '/price-index',
      '/prices/[service]/[country]',
      '/prices/[service]',
      '/prices/countries/[country]',
      '/prices',
      '/trust-ledger',
    ]);
    const { root: fixtureRoot } = await priceFixtureSite();
    const site = createPriceSite(await priceFixtureInputs());
    const generated = site.routes.find((route) => route.kind === 'generated');
    const unavailable = site.routes.find(
      (route) => route.kind === 'unavailable',
    );
    const serviceHub = site.hubs.find((hub) => hub.kind === 'service-hub');
    const marketHub = site.hubs.find((hub) => hub.kind === 'market-hub');
    const retired = '/prices/crunchyroll/united-states';
    assert.ok(generated && unavailable && serviceHub && marketHub);
    assert.equal(site.redirect(retired), '/prices/countries/united-states');
    for (const route of site.routes) pricePagePaths.add(route.path);
    const paths = [
      generated.path,
      `${generated.path}?ref=ABCDEFGHJKMN&utm_source=newsletter`,
      unavailable.path,
      '/prices/not-a-service/sweden',
      '/prices',
      serviceHub.path,
      marketHub.path,
      retired,
      '/prices/not-a-service',
      '/prices/countries/not-a-market',
      '/price-index',
      ...site.monthlyReports.map((report) => report.path),
      '/price-index/2026-11',
    ];
    assert.equal(site.monthlyReports.length, 2);
    const remote = await startBrowser();
    try {
      await withDatabase(async (_database, databaseUrl) => {
        await withServer(
          databaseUrl,
          async (origin) => {
            for (const path of paths) {
              const observed = await crawl(remote.browser, origin, path);
              assert.ok(
                observed.offOrigin.every(
                  (url) => new URL(url).hostname === turnstileHost,
                ),
                `${path} made a third-party request beyond Turnstile`,
              );
            }
          },
          fixtureRoot,
        );
      });
    } finally {
      pricePagePaths.clear();
      await remote.browser.close();
      await executeFile('docker', ['rm', '--force', browserContainer]).catch(
        () => {},
      );
      if (remote.child.exitCode === null) {
        const exited = once(remote.child, 'exit');
        remote.child.kill();
        await exited;
      }
    }
  },
);

test(
  'E11.6-16 crawls every price route of the committed data: no cookie, no storage beyond the theme and Turnstile, no third party beyond Turnstile',
  { timeout: 900_000 },
  async () => {
    // The founder's first monthly run (E11.6-15) is committed, so the price
    // routes are crawled as the repository's own build serves them, every
    // one: each service × market page (a protected page whose signup form
    // must get its Turnstile token), each hub, `/prices`, `/price-index` and
    // each monthly report. The same crawl as every route above.
    await ensureAppBuild();
    const { routes } = await committedPriceData();
    assert.ok(routes.length > 0, `${routes.length} price routes`);
    for (const route of routes)
      if (route.kind === 'service-market' || route.kind === 'unavailable')
        pricePagePaths.add(route.path);
    const remote = await startBrowser();
    try {
      await withDatabase(async (_database, databaseUrl) => {
        await withServer(databaseUrl, async (origin) => {
          // Eight at a time: each protected page waits on Turnstile, and the
          // crawl's checks are per page, so order does not matter.
          const observed = await inPool(routes, 8, (route) =>
            crawl(remote.browser, origin, route.path, undefined, {
              notFound: false,
            }),
          );
          assert.equal(observed.length, routes.length);
          for (const [index, result] of observed.entries()) {
            assert.equal(result.status, 200, `${routes[index].path} answers`);
            assert.ok(
              result.offOrigin.every(
                (url) => new URL(url).hostname === turnstileHost,
              ),
              `${routes[index].path} made a third-party request beyond Turnstile`,
            );
          }
          // A protected page loads Turnstile; no hub or report does.
          for (const [index, result] of observed.entries())
            assert.equal(
              result.offOrigin.length > 0,
              pricePagePaths.has(routes[index].path),
              `${routes[index].path} loads Turnstile exactly when it has the form`,
            );
        });
      });
    } finally {
      pricePagePaths.clear();
      await remote.browser.close();
      await executeFile('docker', ['rm', '--force', browserContainer]).catch(
        () => {},
      );
      if (remote.child.exitCode === null) {
        const exited = once(remote.child, 'exit');
        remote.child.kill();
        await exited;
      }
    }
  },
);

test(
  'E11.7-15 crawls every partner programme state of the seeded programme: no cookie, no storage beyond the theme and Turnstile, no third party beyond Turnstile',
  { timeout: 900_000 },
  async () => {
    // The programme the local seed writes (scripts/seed-partner-programme.ts),
    // crawled as the repository's build serves it: every new route and every
    // changed surface in each GET state test/helpers/partner-audit.mjs lists
    // (a POST's page is the browser audit's), each member's and friend's
    // /me, the verification links, every partner's dashboard and flyer. The
    // same crawl as every route above.
    await ensureAppBuild();
    const remote = await startBrowser();
    try {
      await withDatabase(async (_database, databaseUrl) => {
        const manifest = await runPartnerSeed(
          databaseUrl,
          emailTokenSecret,
          'http://localhost:4321',
        );
        const states = partnerAuditStates(manifest).filter(
          (state) =>
            state.post === undefined &&
            state.flags === undefined &&
            // A terminated partner's link answers exactly as a cancelled one
            // (E11.7-09, D-063 Q2); the crawl's own invalid-link path covers
            // that response, and this crawl reads authenticated views only.
            state.state !== 'partners-dashboard-terminated-standard',
        );
        await withServer(databaseUrl, async (origin) => {
          // `/r/{CODE}` is a redirect, not a page: 302, no store, no cookie.
          for (const state of states.filter((item) => item.redirectsTo)) {
            const response = await globalThis.fetch(`${origin}${state.path}`, {
              redirect: 'manual',
            });
            assert.equal(response.status, 302, state.path);
            assert.equal(
              response.headers.get('location'),
              state.redirectsTo,
              state.path,
            );
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(response.headers.get('set-cookie'), null);
          }
          // Each path once, with whether its dashboard shows the asset kit.
          const partnerKit = new Map([
            ...states.map((state) => [
              state.redirectsTo ?? state.path,
              state.partnerKit ?? true,
            ]),
            ...manifest.verifyReplays.map((entry) => [entry.path, true]),
          ]);
          const paths = [...partnerKit.keys()];
          assert.ok(paths.length >= 30, `${paths.length} partner paths`);
          assert.ok(
            [...partnerKit.values()].includes(false),
            'a paused dashboard is crawled',
          );
          const observed = await inPool(paths, 4, (path) =>
            crawl(remote.browser, origin, path, undefined, {
              notFound: false,
              partnerKit: partnerKit.get(path),
            }),
          );
          assert.equal(observed.length, paths.length);
          for (const [index, result] of observed.entries())
            assert.ok(
              result.offOrigin.every(
                (url) => new URL(url).hostname === turnstileHost,
              ),
              `${paths[index]} made a third-party request beyond Turnstile`,
            );
        });
      });
    } finally {
      await remote.browser.close();
      await executeFile('docker', ['rm', '--force', browserContainer]).catch(
        () => {},
      );
      if (remote.child.exitCode === null) {
        const exited = once(remote.child, 'exit');
        remote.child.kill();
        await exited;
      }
    }
  },
);
