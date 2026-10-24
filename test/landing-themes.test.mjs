import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';

import { landingCopy } from '../src/copy/landing.ts';
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

      // The hero, the "what is", the guarantee, and the FAQ sections are all
      // present and their copy is on the page.
      await assert.doesNotReject(
        page
          .getByRole('heading', { level: 1, name: landingCopy.hero.heading })
          .waitFor({ state: 'visible' }),
        `hero heading in ${colorScheme} at ${width}px`,
      );
      assert.equal(
        await page
          .getByRole('heading', { level: 2, name: landingCopy.whatIs.heading })
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
        await page.locator('.lp-guarantee__item').count(),
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

test('the delayed self-hosted above-fold font swaps with zero rendered CLS and selective preload', async () => {
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

  const page = await context.newPage();
  await page.goto(browserOrigin, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => globalThis.document.fonts.ready);
  await page.waitForTimeout(100);

  const result = await page.evaluate(() => ({
    cls: globalThis.__fontLayoutShift,
    layoutShiftSources: globalThis.__fontLayoutShiftSources,
    fonts: globalThis.performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.includes('/fonts/')),
    preloads: [
      ...globalThis.document.querySelectorAll('link[rel="preload"][as="font"]'),
    ].map((link) => link.getAttribute('href')),
  }));
  assert.equal(result.cls, 0, JSON.stringify(result.layoutShiftSources));
  assert.deepEqual(result.preloads, [
    '/fonts/instrument-sans-latin-wght-normal.woff2',
  ]);
  assert.ok(result.fonts.some((url) => url.includes('instrument-sans')));
  assert.ok(result.fonts.every((url) => !url.includes('jetbrains-mono')));
  await context.close();
});
