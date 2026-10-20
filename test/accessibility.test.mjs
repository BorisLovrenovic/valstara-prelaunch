import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import axe from 'axe-core';
import { chromium } from 'playwright';
import { Pool } from 'pg';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import { assertShellLayout } from '../scripts/design/layout-checks.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';

const execFileAsync = promisify(execFile);
// No fixed ports: the app server gets a reserved port below the kernel's
// ephemeral range and Docker allocates the browser server's host port (see
// test/helpers/listen-port.mjs).
const browserContainer = `valstara-a11y-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const authenticatedStatusTokenId = randomUUID();
const authenticatedStatusToken = deriveEmailToken(
  authenticatedStatusTokenId,
  process.env.EMAIL_TOKEN_SECRET,
);

// WCAG 2.2 AA is the standard docs/legal/compliance.md#6-accessibility commits
// to. These are the axe tags that make up A and AA across 2.0, 2.1 and 2.2.
const wcag22aaTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Both palettes the token file defines. Emulating the OS colour scheme renders
// the same theme a visitor with no stored preference sees (the media-query
// path), so the gate covers what actually ships without depending on the toggle
// island having hydrated.
const themes = ['light', 'dark'];

let browser;
let browserServer;
let browserServerError;
let databaseFixture;
let app;
let browserOrigin;
let browserServerEndpoint;
let hostOrigin;

async function createDatabaseFixture() {
  const databaseName = `valstara_e605a11y_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = 'valstara_app';
  applicationUrl.password = applicationRolePassword;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const database = new Pool({ connectionString: databaseUrl.toString() });

  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await execFileAsync(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'e6-05-accessibility-test'],
    {
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: databaseUrl.toString(),
        VALSTARA_APP_DB_PASSWORD: applicationRolePassword,
      },
    },
  );

  const subscriberId = randomUUID();
  await database.query(
    `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at,
        referral_code, confirmed_referrals, access_window
      ) VALUES (
        $1, $2, $2, 'example.test', 'verified', CURRENT_TIMESTAMP,
        'A11Y23456789', 3, 'wave-1'
      )
    `,
    [subscriberId, 'dashboard-accessibility@example.test'],
  );
  await database.query(
    `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      ) VALUES ($1, $2, $3, 'status', '2099-01-01T00:00:00.000Z')
    `,
    [
      authenticatedStatusTokenId,
      subscriberId,
      createHash('sha256').update(authenticatedStatusToken).digest(),
    ],
  );
  await database.query(
    `
      INSERT INTO milestone_award (
        id, subscriber_id, tier, reward_kind, state, awarded_at
      ) VALUES
        ($1, $2, 1, 'wave_upgrade', 'settled', CURRENT_TIMESTAMP),
        ($3, $2, 1, 'discount', 'held', CURRENT_TIMESTAMP)
    `,
    [randomUUID(), subscriberId, randomUUID()],
  );

  return {
    applicationUrl: applicationUrl.toString(),
    database,
    async dispose() {
      await database.end();
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [databaseName],
      );
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    },
  };
}

// Every built page, discovered from the filesystem rather than hard-coded, so a
// page added in a later ticket is covered by this gate automatically instead of
// being silently omitted. API routes are not rendered pages, and a dynamic
// route needs parameters this gate cannot invent.
async function renderedRoutes() {
  const pagesDirectory = fileURLToPath(
    new URL('../src/pages', import.meta.url),
  );
  const entries = await readdir(pagesDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  const routes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.astro')) {
      continue;
    }
    const parent = entry.parentPath ?? entry.path;
    const relative = `${parent}/${entry.name}`
      .slice(pagesDirectory.length + 1)
      .replaceAll('\\', '/');
    if (relative.startsWith('api/') || relative.includes('[')) {
      continue;
    }
    const route = `/${relative.replace(/\.astro$/u, '').replace(/(^|\/)index$/u, '')}`;
    routes.push(route === '' ? '/' : route);
  }
  return routes.sort();
}

async function startBrowserServer() {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  browserServer = spawn(
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
      `${projectRoot}:/work:ro`,
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
  browserServer.stdout.on('data', (chunk) => {
    output += chunk;
  });
  browserServer.stderr.on('data', (chunk) => {
    output += chunk;
  });
  browserServer.once('error', (error) => {
    browserServerError = error;
  });

  for (let attempt = 0; attempt < 720; attempt += 1) {
    if (output.includes('Listening on')) {
      browserServerEndpoint = `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
      return;
    }
    if (browserServerError !== undefined) {
      throw new Error(
        `Could not start the containerized Playwright server: ${browserServerError.message}`,
        { cause: browserServerError },
      );
    }
    if (browserServer.exitCode !== null) {
      throw new Error(
        `Containerized Playwright server exited before startup.\n${output}`,
      );
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }

  throw new Error(
    `Containerized Playwright server did not start within three minutes.\n${output}`,
  );
}

// Inject axe from node_modules into the page and run it. The same runner backs
// both the real-page assertions and the planted-fixture test, so the fixture
// genuinely exercises the machinery the pages depend on. axe-core is injected
// into the test browser only; it never reaches a shipped page.
async function axeViolations(page) {
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

before(async () => {
  await execFileAsync('npm', ['run', 'build']);
  databaseFixture = await createDatabaseFixture();
  app = await startAppServer({
    label: 'Accessibility test',
    env: () => ({
      ADMIN_CREDENTIAL: 'accessibility-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseFixture.applicationUrl,
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'accessibility-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'accessibility-referral-secret',
      RESEND_API_KEY: 'accessibility-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    }),
  });
  hostOrigin = `http://127.0.0.1:${app.port}`;
  browserOrigin = `http://host.docker.internal:${app.port}`;
  const authenticatedDashboard = await globalThis.fetch(
    `${hostOrigin}/me?t=${encodeURIComponent(authenticatedStatusToken)}`,
  );
  const authenticatedDashboardBody = await authenticatedDashboard.text();
  assert.ok(
    authenticatedDashboard.ok &&
      authenticatedDashboardBody.includes('data-member-dashboard'),
    `authenticated dashboard fixture did not render: ${authenticatedDashboard.status} ${authenticatedDashboardBody}`,
  );
  await startBrowserServer();
  browser = await chromium.connect(browserServerEndpoint);
});

after(async () => {
  await browser?.close();
  if (browserServerError === undefined) {
    await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
      (error) => {
        if (!String(error.stderr).includes('No such container')) {
          throw error;
        }
      },
    );
  }
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const browserServerExited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await browserServerExited;
  }
  await app?.stop();
  await databaseFixture?.dispose();
});

test('every built page has zero WCAG 2.2 AA violations in both themes', async () => {
  const routes = await renderedRoutes();
  // The pages built through E6-02 are present, so the gate is proving something
  // rather than passing over an empty set. This explicit inventory also fails
  // when a new route appears without joining the accessibility pass.
  assert.deepEqual(routes, [
    '/',
    '/about',
    '/dsr',
    '/giveaway/award',
    '/giveaway/rules',
    '/guarantee',
    '/leaderboard',
    '/legit',
    '/me',
    '/privacy',
    '/privacy/storage',
    '/terms',
    '/unsubscribe',
    '/verify',
  ]);

  for (const route of [
    ...routes,
    '/giveaway/rules/VAL-GW-LAUNCH-20260925-r1',
  ]) {
    for (const colorScheme of themes) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      const target =
        route === '/me'
          ? `${browserOrigin}/me?t=${encodeURIComponent(authenticatedStatusToken)}`
          : `${browserOrigin}${route}`;
      await page.goto(target, { waitUntil: 'load' });
      if (route === '/me') {
        const dashboardCount = await page
          .locator('[data-member-dashboard]')
          .count();
        assert.equal(
          dashboardCount,
          1,
          `the accessibility gate must scan the authenticated dashboard; rendered: ${await page.locator('body').innerText()}`,
        );
        await page.locator('[data-copy-referral]').click();
        await page.waitForFunction(
          () =>
            globalThis.document.querySelector('[data-copy-status]')
              ?.textContent !== '',
        );
      }
      const violations = await axeViolations(page);
      assert.deepEqual(
        violations,
        [],
        `axe found WCAG 2.2 AA violations on ${route} in ${colorScheme}: ${JSON.stringify(violations)}`,
      );
      await context.close();
    }
  }
});

// E11.5-03: the shell joins the enforced layout-check set. Its header and
// footer pass the E11.5-01 layout rules on every rendered page, at every test
// width, in both themes; page bodies join in the ticket that redesigns them.
test('the site shell passes the layout checks on every rendered page', async () => {
  await assertShellLayout(browser, browserOrigin, [
    ...(await renderedRoutes()),
    '/giveaway/rules/VAL-GW-LAUNCH-20260925-r1',
  ]);
});

test('trust and legal pages fit mobile and desktop in both themes', async () => {
  const backgrounds = new Map();
  for (const colorScheme of themes) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    for (const route of [
      '/legit',
      '/guarantee',
      '/about',
      '/terms',
      '/privacy',
      '/privacy/storage',
    ]) {
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${browserOrigin}${route}`);
        const metrics = await page.evaluate(() => ({
          width: globalThis.document.documentElement.scrollWidth,
          background: globalThis.getComputedStyle(globalThis.document.body)
            .backgroundColor,
          heading: globalThis.document.querySelector('h1')?.textContent,
        }));
        assert.ok(metrics.heading, `${route} needs a visible heading`);
        assert.ok(
          metrics.width <= width,
          `${route} overflows at ${width}px in ${colorScheme}`,
        );
        if (width === 320) {
          const key = `${route}:${colorScheme}`;
          backgrounds.set(key, metrics.background);
        }
      }
    }
    await context.close();
  }
  for (const route of [
    '/legit',
    '/guarantee',
    '/about',
    '/terms',
    '/privacy',
    '/privacy/storage',
  ]) {
    assert.notEqual(
      backgrounds.get(`${route}:light`),
      backgrounds.get(`${route}:dark`),
    );
  }
});

test('the axe gate fails on a planted violation', async () => {
  // A deliberately broken document run through the same runner the real pages
  // use: an input with no accessible name and an image with no alt text are
  // unambiguous WCAG A failures. If this stopped detecting them, a regression
  // on a real page would pass unnoticed — which is what the fixture guards.
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.setContent(
    '<!doctype html><html lang="en"><head><title>Planted</title></head>' +
      '<body><main><input type="text" /><img src="data:," /></main></body></html>',
    { waitUntil: 'load' },
  );
  const violations = await axeViolations(page);
  const ids = violations.map((violation) => violation.id);
  assert.ok(
    ids.includes('label'),
    `expected the missing-label violation to be caught; saw ${JSON.stringify(ids)}`,
  );
  assert.ok(
    ids.includes('image-alt'),
    `expected the missing-alt violation to be caught; saw ${JSON.stringify(ids)}`,
  );
  await context.close();
});

test('the dashboard copy control copies the bearer referral link', async () => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(value) {
          globalThis.__copiedReferralLink = value;
        },
      },
    });
  });
  await page.goto(
    `${browserOrigin}/me?t=${encodeURIComponent(authenticatedStatusToken)}`,
    { waitUntil: 'load' },
  );

  const referralLink = await page.locator('[data-referral-link]').inputValue();
  await page.locator('[data-copy-referral]').click();

  assert.equal(
    await page.evaluate(() => globalThis.__copiedReferralLink),
    referralLink,
  );
  assert.equal(
    await page.locator('[data-copy-status]').textContent(),
    'Referral link copied.',
  );
  await context.close();
});

test('every animation is disabled under prefers-reduced-motion', async () => {
  for (const route of await renderedRoutes()) {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${browserOrigin}${route}`, { waitUntil: 'load' });

    // Over every element, not only the decorative ones: with reduced motion
    // requested, nothing may still carry a live transition or animation. An
    // element animates only if its property is not "none" and some duration is
    // above zero, so the browser default (property "all", duration 0s) is not a
    // false positive, while a real animation added without a reduced-motion
    // guard would be caught here.
    const animating = await page.evaluate(() => {
      const positive = (durations) =>
        durations.split(',').some((value) => Number.parseFloat(value) > 0);
      const offenders = [];
      for (const element of globalThis.document.querySelectorAll('*')) {
        const style = globalThis.getComputedStyle(element);
        const transitions =
          style.transitionProperty !== 'none' &&
          positive(style.transitionDuration);
        const animations =
          style.animationName !== 'none' && positive(style.animationDuration);
        if (transitions || animations) {
          offenders.push(
            `${element.tagName.toLowerCase()}.${element.className || '(no class)'}`,
          );
        }
      }
      return offenders;
    });

    assert.deepEqual(
      animating,
      [],
      `elements still animate under reduced motion on ${route}: ${JSON.stringify(animating)}`,
    );
    await context.close();
  }
});

test('tab order follows the visual reading order with no focus trap', async () => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(browserOrigin, { waitUntil: 'load' });

  // The theme toggle enables its button once hydrated; wait so the focus order
  // reflects the interactive page rather than a transient disabled state.
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('valstara-theme-toggle button')
        ?.disabled === false,
  );

  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'summary',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // A positive tabindex is the one thing that divorces tab order from DOM (and
  // therefore visual) order; asserting its absence is what keeps the two equal.
  const positiveTabindex = await page.evaluate(
    () =>
      [...globalThis.document.querySelectorAll('[tabindex]')].filter(
        (element) => Number.parseInt(element.getAttribute('tabindex'), 10) > 0,
      ).length,
  );
  assert.equal(positiveTabindex, 0, 'no element uses a positive tabindex');

  const layout = await focusLayout(page, focusableSelector);
  assert.ok(layout.length >= 4, 'the page has the expected focusable controls');

  // Given no positive tabindex, tab order equals DOM order, so proving DOM
  // order equals the visual reading order proves tab order matches it.
  assert.deepEqual(
    visualReadingOrder(layout),
    layout.map((_, index) => index),
    'DOM order matches the visual reading order',
  );

  // Walk the whole page by keyboard and record the order focus actually visits.
  await page.evaluate(() => globalThis.document.body.focus());
  const visited = [];
  for (let step = 0; step < layout.length; step += 1) {
    await page.keyboard.press('Tab');
    visited.push(
      await page.evaluate(() =>
        globalThis.document.activeElement?.getAttribute('data-a11y-order'),
      ),
    );
  }
  assert.deepEqual(
    visited,
    layout.map((_, index) => String(index)),
    'focus visits every control in DOM order',
  );

  // No trap: tabbing past the last control does not stay stuck on it. Without
  // browser chrome focus wraps to the first control, so the invariant is simply
  // that focus leaves the final element.
  await page.keyboard.press('Tab');
  const afterLast = await page.evaluate(() =>
    globalThis.document.activeElement?.getAttribute('data-a11y-order'),
  );
  assert.notEqual(
    afterLast,
    String(layout.length - 1),
    'focus is not trapped on the last control',
  );

  await context.close();
});

// Tag every focusable in DOM order and record each one's on-screen box, plus
// the list it belongs to. A control that renders no box is not in the tab order
// and the keyboard walk never reaches it, so it is excluded: "tab order follows
// reading order" ranges over the controls that are actually tabbable.
test('the reading-order check fails on a list whose DOM order differs from its visual order', async () => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const footer = (listStyle) =>
    `<!doctype html><html lang="en"><body><footer style="display:flex;gap:40px"><a href="/">Home</a><ul style="${listStyle}"><li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li></ul><ul><li><a href="/d">D</a></li><li><a href="/e">E</a></li></ul></footer></body></html>`;
  const selector = 'a[href]';
  try {
    // Two stacked columns side by side: read column by column, so DOM order
    // passes.
    await page.setContent(footer('margin:0'));
    let layout = await focusLayout(page, selector);
    assert.deepEqual(visualReadingOrder(layout), [0, 1, 2, 3, 4, 5]);

    // Planted: the first column renders bottom to top, so C is seen first
    // while the DOM (and tab order) visits A first. The check must fail.
    await page.setContent(
      footer('margin:0;display:flex;flex-direction:column-reverse'),
    );
    layout = await focusLayout(page, selector);
    assert.notDeepEqual(
      visualReadingOrder(layout),
      layout.map((_, index) => index),
    );
    assert.deepEqual(visualReadingOrder(layout), [0, 3, 2, 1, 4, 5]);

    // Planted: the columns are swapped visually. The check must fail.
    await page.setContent(footer('margin:0;order:2'));
    layout = await focusLayout(page, selector);
    assert.notDeepEqual(
      visualReadingOrder(layout),
      layout.map((_, index) => index),
    );
  } finally {
    await page.close();
  }
});

async function focusLayout(page, selector) {
  return page.evaluate((focusable) => {
    const elements = [
      ...globalThis.document.querySelectorAll(focusable),
    ].filter((element) => element.getClientRects().length > 0);
    const lists = [];
    return elements.map((element, index) => {
      element.setAttribute('data-a11y-order', String(index));
      const rectangle = element.getBoundingClientRect();
      const list = element.closest('ul, ol');
      let listBox = null;
      if (list !== null) {
        if (!lists.includes(list)) lists.push(list);
        const box = list.getBoundingClientRect();
        listBox = { bottom: box.bottom, left: box.left, top: box.top };
      }
      return {
        bottom: rectangle.bottom,
        left: rectangle.left,
        list: list === null ? null : lists.indexOf(list),
        listBox,
        top: rectangle.top,
      };
    });
  }, selector);
}

// Cluster boxes into rows by vertical overlap — so two controls centred on one
// header row are one row regardless of a few pixels of height difference — then
// read each row left to right.
function rowOrder(units) {
  const rows = [];
  for (const unit of [...units].sort((a, b) => a.top - b.top)) {
    const row = rows.find(
      (candidate) => unit.top < candidate.bottom && candidate.top < unit.bottom,
    );
    if (row === undefined) {
      rows.push({ bottom: unit.bottom, top: unit.top, units: [unit] });
    } else {
      row.units.push(unit);
      row.top = Math.min(row.top, unit.top);
      row.bottom = Math.max(row.bottom, unit.bottom);
    }
  }
  return rows
    .sort((a, b) => a.top - b.top)
    .flatMap((row) => row.units.sort((a, b) => a.left - b.left));
}

// The visual reading order. Controls inside one list (a footer column, a nav
// row) are read as a single block at that list's position, and within the
// block top to bottom by the same row rule (E11.5-03, founder decision
// 2026-10-20). Every other control is read by the row rule directly.
function visualReadingOrder(layout) {
  const units = [];
  const blocks = new Map();
  layout.forEach((box, index) => {
    const item = { ...box, index };
    if (box.list === null) {
      units.push({ ...item, members: [item] });
      return;
    }
    let block = blocks.get(box.list);
    if (block === undefined) {
      block = { ...box.listBox, members: [] };
      blocks.set(box.list, block);
      units.push(block);
    }
    block.members.push(item);
    block.bottom = Math.max(block.bottom, item.bottom);
  });
  return rowOrder(units).flatMap((unit) =>
    rowOrder(unit.members).map((member) => member.index),
  );
}

async function tabTo(page, selector) {
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    if (
      await page.evaluate(
        (target) => globalThis.document.activeElement?.matches(target),
        selector,
      )
    ) {
      return;
    }
  }
  assert.fail(`Keyboard focus never reached ${selector}`);
}

test('keyboard-only signup and verification expose errors and reach verified state', async () => {
  const context = await browser.newContext();
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  await context.addInitScript(() => {
    globalThis.turnstile = {
      ready(callback) {
        callback();
      },
      render(_element, options) {
        options.callback('XXXX.DUMMY.TOKEN.XXXX');
        return 'audit-widget';
      },
      reset() {},
    };
  });
  const page = await context.newPage();
  await page.goto(browserOrigin);
  await page.evaluate(() =>
    globalThis.customElements.whenDefined('valstara-signup-form'),
  );

  await tabTo(page, '#signup-email');
  assert.equal(
    await page.locator('#signup-email').getAttribute('aria-describedby'),
    'signup-email-hint signup-email-error',
  );
  await tabTo(page, '[data-submit]');
  await page.keyboard.press('Enter');
  await page.locator('#signup-email-error:not([hidden])').waitFor();
  assert.deepEqual(await axeViolations(page), []);
  assert.equal(
    await page.locator('#signup-email').getAttribute('aria-invalid'),
    'true',
  );
  assert.equal(
    await page.locator('#signup-email-error').getAttribute('role'),
    'alert',
  );
  assert.match(
    await page.locator('main').ariaSnapshot(),
    /Enter your email address/u,
  );
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    'signup-email',
  );

  const email = `a11y${randomUUID().replaceAll('-', '')}@gmail.com`;
  await page.keyboard.type(email);
  await page.route('**/api/signup', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'rate_limited',
          message: 'Too many attempts — try again in a few minutes.',
        },
      }),
    }),
  );
  await tabTo(page, '[data-submit]');
  await page.keyboard.press('Enter');
  await page.locator('[data-form-error]:not([hidden])').waitFor();
  assert.deepEqual(await axeViolations(page), []);
  assert.equal(
    await page.locator('[data-form-error]').getAttribute('role'),
    'alert',
  );
  assert.match(await page.locator('main').ariaSnapshot(), /Too many attempts/u);
  assert.equal(
    await page.evaluate(() =>
      globalThis.document.activeElement?.hasAttribute('data-form-error'),
    ),
    true,
    'form-level errors receive keyboard focus',
  );
  await page.unroute('**/api/signup');
  await tabTo(page, '[data-submit]');
  await page.keyboard.press('Enter');
  await page.locator('[data-success]:not([hidden])').waitFor();
  assert.equal(await page.locator('#signup-email-error').isHidden(), true);
  assert.match(await page.locator('[data-success]').textContent(), /email/u);
  assert.equal(
    await page.evaluate(() =>
      globalThis.document.activeElement?.hasAttribute('data-success'),
    ),
    true,
    'focus moves to the status after the form is hidden',
  );

  const issued = await databaseFixture.database.query(
    `SELECT s.status, v.id AS token_id
       FROM subscriber s
       JOIN verification_token v ON v.subscriber_id = s.id
      WHERE s.email_normalised = $1 AND v.purpose = 'verify'
      ORDER BY v.created_at DESC LIMIT 1`,
    [email],
  );
  assert.equal(issued.rows.length, 1);
  assert.equal(issued.rows[0].status, 'pending');
  const token = deriveEmailToken(
    issued.rows[0].token_id,
    process.env.EMAIL_TOKEN_SECRET,
  );

  await page.goto(`${browserOrigin}/verify?token=${encodeURIComponent(token)}`);
  assert.match(
    await page.locator('main').ariaSnapshot(),
    /Confirm email address/u,
  );
  await tabTo(page, 'form.verification-confirm button');
  await page.keyboard.press('Enter');
  await page.getByText('Your email address is verified.').waitFor();
  const verified = await databaseFixture.database.query(
    'SELECT status FROM subscriber WHERE email_normalised = $1',
    [email],
  );
  assert.equal(verified.rows[0].status, 'verified');
  assert.match(await page.locator('main').ariaSnapshot(), /View your status/u);
  await context.close();
});

function contrastRatio(first, second) {
  const channels = (color) =>
    color
      .match(/[\d.]+/gu)
      .slice(0, 3)
      .map((channel) => {
        const value = Number(channel) / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
  const luminance = (color) => {
    const [red, green, blue] = channels(color);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('signup and verification text clears AA contrast at rendered font sizes in both themes', async () => {
  for (const colorScheme of themes) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    for (const [route, selectors] of [
      [
        '/',
        [
          '.lp-hero__heading',
          '.lp-hero__body',
          '.field__label',
          '.field__description',
          '[data-submit]',
          '.signup-marketing',
          '.signup-age',
          '#signup-email-error',
          '.site-name',
          '.footer-links a',
        ],
      ],
      [
        '/verify?token=audit',
        [
          '.verification-confirm p',
          '.verification-confirm button',
          '.site-name',
          '.footer-links a',
        ],
      ],
      [
        '/verify',
        [
          '.verification-invalid p',
          '.verification-invalid label',
          '.verification-invalid button',
        ],
      ],
    ]) {
      await page.goto(`${browserOrigin}${route}`);
      if (route === '/') {
        await page.evaluate(() =>
          globalThis.customElements.whenDefined('valstara-signup-form'),
        );
        await page.locator('[data-submit]').click();
        await page.locator('#signup-email-error:not([hidden])').waitFor();
      }
      let lowestRatio = Infinity;
      let lowestSelector = '';
      for (const selector of selectors) {
        const colors = await page
          .locator(selector)
          .first()
          .evaluate((element) => {
            const style = globalThis.getComputedStyle(element);
            let parent = element;
            let background = '';
            while (parent !== null) {
              const candidate =
                globalThis.getComputedStyle(parent).backgroundColor;
              if (
                candidate !== 'rgba(0, 0, 0, 0)' &&
                candidate !== 'transparent'
              ) {
                background = candidate;
                break;
              }
              parent = parent.parentElement;
            }
            return {
              background,
              color: style.color,
              fontSize: Number.parseFloat(style.fontSize),
              fontWeight: Number.parseInt(style.fontWeight, 10),
            };
          });
        assert.ok(
          colors.background,
          `${route} ${selector} has an opaque background`,
        );
        const large =
          colors.fontSize >= 24 ||
          (colors.fontSize >= 18.66 && colors.fontWeight >= 700);
        const minimum = large ? 3 : 4.5;
        const actual = contrastRatio(colors.color, colors.background);
        if (actual < lowestRatio) {
          lowestRatio = actual;
          lowestSelector = selector;
        }
        assert.ok(
          actual >= minimum,
          `${colorScheme} ${route} ${selector}: ${actual.toFixed(2)}:1 at ${colors.fontSize}px/${colors.fontWeight}, needs ${minimum}:1`,
        );
      }
      process.stdout.write(
        `# ${colorScheme} ${route}: lowest rendered text contrast ${lowestRatio.toFixed(2)}:1 (${lowestSelector})\n`,
      );
    }
    await context.close();
  }
});
