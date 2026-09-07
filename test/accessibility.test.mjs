import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import axe from 'axe-core';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const appPort = 43_250;
const browserPort = 43_251;
const hostOrigin = `http://127.0.0.1:${appPort}`;
const browserOrigin = `http://host.docker.internal:${appPort}`;
const browserServerEndpoint = `ws://127.0.0.1:${browserPort}/`;
const browserContainer = `valstara-a11y-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

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
let server;

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

async function waitForAppServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(hostOrigin);
      if (response.ok) {
        return;
      }
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error('Accessibility test server did not start.');
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
      `127.0.0.1:${browserPort}:3000`,
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
  // No reachable database is needed: the landing flag read fails safe to its
  // registered default (signup on) and /verify with an empty token returns
  // "invalid" before it queries, so both pages render and the axe gate runs
  // against exactly the markup a visitor receives.
  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-a11y',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'accessibility-prefix-pepper',
      PORT: String(appPort),
      RESEND_API_KEY: 'accessibility-resend-key',
      RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
      TURNSTILE_SECRET_KEY: 'accessibility-turnstile-secret',
    },
    stdio: 'ignore',
  });
  await waitForAppServer();
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
  if (server !== undefined) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
});

test('every built page has zero WCAG 2.2 AA violations in both themes', async () => {
  const routes = await renderedRoutes();
  // The pages E2-05/E2-06 and E1-11 built are present, so the gate is proving
  // something rather than passing over an empty set.
  assert.deepEqual(routes, ['/', '/verify']);

  for (const route of routes) {
    for (const colorScheme of themes) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      await page.goto(`${browserOrigin}${route}`, { waitUntil: 'load' });
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

  // Tag every focusable in DOM order, and record each one's on-screen box. A
  // control that renders no box — a `display:none` element, such as the
  // Canada-only region select before Canada is chosen — is not in the tab order
  // and the keyboard walk below never reaches it, so it is excluded here: "tab
  // order follows reading order" ranges over the controls that are actually
  // tabbable.
  const layout = await page.evaluate((selector) => {
    const elements = [...globalThis.document.querySelectorAll(selector)].filter(
      (element) => element.getClientRects().length > 0,
    );
    return elements.map((element, index) => {
      element.setAttribute('data-a11y-order', String(index));
      const rectangle = element.getBoundingClientRect();
      return {
        bottom: rectangle.bottom,
        left: rectangle.left,
        top: rectangle.top,
      };
    });
  }, focusableSelector);
  assert.ok(layout.length >= 4, 'the page has the expected focusable controls');

  // DOM order is the visual reading order: cluster the controls into rows by
  // vertical overlap — so two controls centred on one header row are one row
  // regardless of a few pixels of height difference — then read each row left to
  // right. Given no positive tabindex, tab order equals DOM order, so proving
  // DOM order equals this reading order proves tab order matches the visual one.
  const items = layout.map((box, index) => ({ ...box, index }));
  const rows = [];
  for (const item of [...items].sort((a, b) => a.top - b.top)) {
    const row = rows.find(
      (candidate) => item.top < candidate.bottom && candidate.top < item.bottom,
    );
    if (row === undefined) {
      rows.push({ bottom: item.bottom, items: [item], top: item.top });
    } else {
      row.items.push(item);
      row.top = Math.min(row.top, item.top);
      row.bottom = Math.max(row.bottom, item.bottom);
    }
  }
  const readingOrder = rows
    .sort((a, b) => a.top - b.top)
    .flatMap((row) =>
      row.items.sort((a, b) => a.left - b.left).map((item) => item.index),
    );
  assert.deepEqual(
    readingOrder,
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
