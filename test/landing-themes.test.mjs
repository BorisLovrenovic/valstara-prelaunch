import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';

import { landingCopy } from '../src/copy/landing.ts';
import {
  checkPageLayout,
  designWidths,
  enforcedPages,
} from '../scripts/design/layout-checks.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-landing-playwright-${process.pid}`;
const appServerStartupTimeoutMilliseconds = 30_000;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

let app;
let browser;
let browserOrigin;
let browserServer;
let browserServerError;
let hostOrigin;

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
      return `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
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

async function waitForBrowserAppServer() {
  const deadline =
    globalThis.performance.now() + appServerStartupTimeoutMilliseconds;
  const context = await browser.newContext();
  const page = await context.newPage();
  let lastError;
  try {
    while (globalThis.performance.now() < deadline) {
      try {
        const response = await page.goto(browserOrigin, { timeout: 2_000 });
        if (response?.ok()) return;
      } catch (error) {
        lastError = error;
      }
      if (app.server.exitCode !== null) break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
    throw new Error(
      `Landing theme browser could not reach the app server. ${String(lastError)}\n${app.output() || '(no server output)'}`,
    );
  } finally {
    await context.close();
  }
}

before(async () => {
  await ensureAppBuild();
  // A reserved port below the kernel's ephemeral range; only a lost bind
  // race is retried (test/helpers/listen-port.mjs).
  // No reachable database: the flag read fails safe to its registered default
  // (signup on), so the form renders and this test never depends on a fixture.
  app = await startAppServer({
    label: 'Landing theme test',
    env: () => ({
      ADMIN_CREDENTIAL: 'landing-theme-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-landing',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'landing-theme-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'landing-theme-referral-secret',
      RESEND_API_KEY: 'landing-theme-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'landing-theme-turnstile-secret',
    }),
  });
  hostOrigin = `http://127.0.0.1:${app.port}`;
  browserOrigin = `http://host.docker.internal:${app.port}`;
  const browserServerEndpoint = await startBrowserServer();
  browser = await chromium.connect(browserServerEndpoint);
  await waitForBrowserAppServer();
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
});

async function pageBackground(page) {
  return page.evaluate(
    () => globalThis.getComputedStyle(globalThis.document.body).backgroundColor,
  );
}

test('the landing page renders every section, in light and dark, at both extremes', async () => {
  const backgroundsByTheme = {};

  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();

    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(browserOrigin);

      // The hero, catalogue, guarantee, and FAQ sections are all
      // present and their copy is on the page.
      await assert.doesNotReject(
        page
          .getByRole('heading', { level: 1, name: landingCopy.hero.heading })
          .waitFor({ state: 'visible' }),
        `hero heading in ${colorScheme} at ${width}px`,
      );
      assert.equal(
        await page
          .getByRole('heading', {
            level: 2,
            name: landingCopy.catalogue.heading,
          })
          .isVisible(),
        true,
      );
      assert.equal(
        await page
          .getByRole('heading', { level: 2, name: landingCopy.trust.heading })
          .isVisible(),
        true,
      );

      // The three guarantee promises render, and no more.
      assert.equal(
        await page.locator('.landing-guarantee > li').count(),
        landingCopy.trust.promises.length,
      );

      // The FAQ is a native disclosure: closed by default, opens on the page.
      const firstFaq = page.locator('details').first();
      assert.equal(await firstFaq.getAttribute('open'), null);
      await firstFaq.locator('summary').click();
      assert.equal(await firstFaq.getAttribute('open'), '');

      // The signup form is present (the flag fell back to its default).
      assert.equal(await page.locator('form input[name="email"]').count(), 1);

      // No horizontal overflow at either extreme, in either theme.
      const scrollWidth = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth,
      );
      assert.ok(
        scrollWidth <= width,
        `no horizontal overflow in ${colorScheme} at ${width}px (content ${scrollWidth})`,
      );
    }

    backgroundsByTheme[colorScheme] = await pageBackground(page);
    await context.close();
  }

  // The theme actually changes the rendered page: the two grounds differ.
  assert.notEqual(backgroundsByTheme.light, backgroundsByTheme.dark);
});

test('the ref-less landing response varies only by flag generation while ref bypasses', async () => {
  const cacheable = await globalThis.fetch(hostOrigin, {
    headers: { 'CF-IPCountry': 'SE' },
  });
  assert.equal(
    cacheable.headers.get('cache-control'),
    'public, max-age=0, s-maxage=300',
  );
  assert.equal(cacheable.headers.get('vary'), 'X-Valstara-Flag-Generation');
  assert.match(
    cacheable.headers.get('x-valstara-flag-generation') ?? '',
    /^[a-f0-9]{16}$/u,
  );

  const referred = await globalThis.fetch(`${hostOrigin}/?ref=signed-ref`);
  assert.equal(referred.headers.get('cache-control'), 'private, no-store');
});

test('the landing hero keeps its positioning, email field and submit visible above the fold', async () => {
  for (const { width, height } of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(browserOrigin);
    for (const selector of [
      '.landing-eyebrow',
      '#landing-title',
      '#signup-email',
      '[data-submit]',
    ]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box, `${selector} exists at ${width}px`);
      assert.ok(
        box.y >= 0 && box.y + box.height <= height,
        `${selector} is inside ${width}×${height}: ${JSON.stringify(box)}`,
      );
    }
    await context.close();
  }
});

test('the final call to action focuses the hero email with the island and remains an anchor without script', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserOrigin);
  await page.evaluate(() =>
    globalThis.customElements.whenDefined('valstara-signup-form'),
  );
  await page.locator('[data-focus-signup]').click();
  await page.waitForFunction(
    () => globalThis.document.activeElement?.id === 'signup-email',
  );
  await context.close();

  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noScript.newPage();
  await staticPage.goto(browserOrigin);
  assert.equal(
    await staticPage.locator('[data-focus-signup]').getAttribute('href'),
    '#join',
  );
  await staticPage.locator('[data-focus-signup]').click();
  assert.equal(new URL(staticPage.url()).hash, '#join');
  await noScript.close();
});

test('the landing joins layout enforcement and passes WCAG axe in both themes', async () => {
  assert.ok(enforcedPages.includes('/'));
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    for (const width of designWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(browserOrigin);
      assert.deepEqual(
        await checkPageLayout(page),
        [],
        `landing layout ${colorScheme} at ${width}px`,
      );
    }
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const result = await globalThis.axe.run(globalThis.document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
        },
      });
      return result.violations.map((violation) => ({
        id: violation.id,
        targets: violation.nodes.map((node) => node.target),
      }));
    });
    assert.deepEqual(violations, [], `landing axe ${colorScheme}`);
    await context.close();
  }
});

// Loads the landing page with every font delayed 350ms and measures the
// layout shift its arrival causes. A probe of mono figures with markers
// beside and below them is added to the page: a marker moves if the mono face
// arrives with metrics its fallback did not reserve.
// `withoutFallback` plants the stylesheet with the metric-matched JetBrains
// Mono fallback removed.
async function fontSwap({ withoutFallback = false } = {}) {
  let plantedOut = false;
  const context = await browser.newContext({
    viewport: { width: 375, height: 900 },
  });
  await context.addInitScript(() => {
    globalThis.__fontLayoutShift = 0;
    globalThis.__fontLayoutShiftSources = [];
    new globalThis.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          globalThis.__fontLayoutShift += entry.value;
          globalThis.__fontLayoutShiftSources.push(
            ...entry.sources.map((source) => ({
              currentRect: source.currentRect.toJSON(),
              node: source.node?.outerHTML,
              previousRect: source.previousRect.toJSON(),
            })),
          );
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.abort(),
  );
  await context.route('**/fonts/*.woff2', async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 350));
    await route.fulfill({ response });
  });
  // The probe goes in as the body opens, before the first paint.
  await context.addInitScript(() => {
    const { document } = globalThis;
    new globalThis.MutationObserver((records, observer) => {
      if (!document.body) return;
      observer.disconnect();
      // Mono figures at the normal line height, with a marker after them on
      // the line and another below: a different advance width moves the
      // first, a different line height the second.
      const probe = document.createElement('p');
      probe.dataset.fontProbe = '';
      probe.textContent = '0123456789'.repeat(2);
      Object.assign(probe.style, {
        margin: '0',
        font: '400 1rem/normal var(--font-mono)',
      });
      const marker = () => {
        const element = document.createElement('span');
        element.dataset.fontProbe = 'marker';
        Object.assign(element.style, {
          display: 'inline-block',
          width: '2rem',
          height: '1rem',
          background: 'currentColor',
        });
        return element;
      };
      probe.append(marker());
      const below = document.createElement('div');
      below.append(marker());
      document.body.prepend(probe, below);
    }).observe(document, { childList: true, subtree: true });
  });
  if (withoutFallback)
    await context.route('**/*.css', async (route) => {
      const response = await route.fetch();
      const css = await response.text();
      const planted = css.replace(
        /@font-face\s*\{[^}]*JetBrains Mono Fallback[^}]*\}/gu,
        '',
      );
      if (planted !== css) plantedOut = true;
      await route.fulfill({ response, body: planted });
    });

  const page = await context.newPage();
  await page.goto(browserOrigin, { waitUntil: 'domcontentloaded' });
  // The step badges request the mono face on their own; wait for its arrival
  // without loading it from the test.
  await page.waitForFunction(() =>
    globalThis.performance
      .getEntriesByType('resource')
      .some((entry) => entry.name.includes('/fonts/jetbrains-mono')),
  );
  await page.evaluate(() => globalThis.document.fonts.ready);
  await page.waitForTimeout(100);

  const result = await page.evaluate(() => ({
    cls: globalThis.__fontLayoutShift,
    layoutShiftSources: globalThis.__fontLayoutShiftSources,
    fonts: globalThis.performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((name) => name.includes('/fonts/')),
    preloads: [
      ...globalThis.document.querySelectorAll('link[rel="preload"][as="font"]'),
    ].map((link) => link.getAttribute('href')),
  }));
  await context.close();
  assert.equal(plantedOut, withoutFallback, 'the fallback is planted out');
  return result;
}

test('the delayed self-hosted fonts swap with zero rendered CLS and selective preload', async () => {
  const result = await fontSwap();
  assert.equal(result.cls, 0, JSON.stringify(result.layoutShiftSources));
  assert.deepEqual(result.preloads, [
    '/fonts/instrument-sans-latin-wght-normal.woff2',
  ]);
  assert.ok(result.fonts.some((url) => url.includes('instrument-sans')));
  // E11.5-11d (founder-authorised 2026-10-28): the step badges, and later the
  // reward figures, set in JetBrains Mono. It is requested only as the
  // self-hosted WOFF2, is never preloaded, and arrives with no layout shift.
  assert.deepEqual(
    result.fonts.filter((url) => url.includes('jetbrains-mono')),
    ['/fonts/jetbrains-mono-latin-wght-normal.woff2'],
  );
  assert.ok(result.preloads.every((href) => !href.includes('jetbrains-mono')));
});

test('without the metric-matched JetBrains Mono fallback, the mono swap shifts the layout', async () => {
  // The planted fixture: the same page with the fallback face removed. The
  // zero-shift assertion above must fail on it.
  const result = await fontSwap({ withoutFallback: true });
  assert.ok(
    result.fonts.includes('/fonts/jetbrains-mono-latin-wght-normal.woff2'),
  );
  assert.throws(() =>
    assert.equal(result.cls, 0, JSON.stringify(result.layoutShiftSources)),
  );
  assert.ok(
    result.layoutShiftSources.some((source) =>
      source.node?.includes('data-font-probe'),
    ),
    JSON.stringify(result.layoutShiftSources),
  );
});
