import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from 'playwright';
import { Pool } from 'pg';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

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
const protectedPages = new Set([
  '/',
  '/verify',
  '/me',
  '/dsr',
  '/giveaway/award',
]);

function expectedProtectedFormCount(url) {
  if (url.pathname === '/') return 1;
  if (url.pathname === '/dsr') return url.searchParams.has('t') ? 0 : 1;
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

async function sourcePagePaths() {
  const pages = await readdir(`${root}/src/pages`, { recursive: true });
  const astro = pages.filter((path) => path.endsWith('.astro')).sort();
  const revisionFiles = await readdir(`${root}/src/content/giveaway-rules`);
  const revisions = revisionFiles
    .filter((path) => path.endsWith('.md'))
    .map((path) => path.slice(0, -3))
    .sort();
  assert.ok(revisions.length > 0, 'rules revisions must be inventoried');
  const routes = astro.flatMap((path) => {
    const route =
      `/${path.replace(/\.astro$/u, '').replace(/(?:^|\/)index$/u, '')}`.replace(
        /\/$/u,
        '',
      ) || '/';
    if (path === 'giveaway/rules/[rulesVersion].astro') {
      return revisions.map((version) => `/giveaway/rules/${version}`);
    }
    assert.ok(!route.includes('['), `unexpanded page route: ${route}`);
    return [route];
  });
  return { astro, routes: [...new Set(routes)].sort() };
}

async function startBrowser() {
  const child = spawn(
    'docker',
    [
      'run',
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
  return { ...tokens, awardId };
}

async function withServer(databaseUrl, run) {
  // A reserved port below the kernel's ephemeral range (see
  // test/helpers/listen-port.mjs).
  const app = await startAppServer({
    label: 'Privacy-audit',
    readyPath: '/privacy',
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

async function crawl(browser, origin, path, storageMutation) {
  const pageUrl = new URL(`http://valstara.test${path}`);
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
        contentType: response.headers.get('content-type') ?? 'text/plain',
        body: globalThis.Buffer.from(await response.arrayBuffer()),
      });
    });
    const response = await page.goto(pageUrl.toString(), {
      waitUntil:
        expectedProtectedFormCount(pageUrl) > 0 ? 'load' : 'networkidle',
    });
    const protectedForms = page.locator(
      'form:has(.cf-turnstile), form:has([data-turnstile-container])',
    );
    const protectedFormCount = await protectedForms.count();
    assert.equal(
      protectedFormCount,
      expectedProtectedFormCount(pageUrl),
      `${path} protected-form count`,
    );
    if (pageUrl.pathname === '/') {
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
    assert.ok(
      response.status() < 500,
      `${path} must not be a server error (got ${response.status()})`,
    );
    const pathname = pageUrl.pathname;
    const html = await page.content();
    if (storageMutation) {
      await page.evaluate(storageMutation);
    }
    const query = pageUrl.searchParams;
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
    if (pathname === '/me' && query.has('t') && query.get('t') !== 'invalid') {
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
    if (hosts.has(turnstileHost)) {
      assert.ok(
        protectedPages.has(pathname),
        `${path} loaded Turnstile outside a protected page`,
      );
      assert.match(html, /turnstile_token/u, `${path} needs a Turnstile form`);
    }
    if (!protectedPages.has(pathname)) {
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
        ];
        const paths = [...inventory.routes, ...emailLinked, ...errorPages];
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
