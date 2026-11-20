import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import axe from 'axe-core';
import { chromium } from 'playwright';

import {
  cumulativeLayoutShiftBudget,
  interactionToNextPaintBudgetMilliseconds,
  largestContentfulPaintBudgetMilliseconds,
  measurePagePerformance,
} from '../scripts/design/landing-performance.mjs';
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
import { publishedPort } from './helpers/listen-port.mjs';
import { entranceEnded } from './helpers/motion.mjs';
import {
  committedPriceData,
  fetchRoutes,
  inPool,
  startPriceAuditServer,
} from './helpers/price-audit.mjs';

// E11.6-16: the accessibility gate and the lab performance run over the
// price routes of the committed data (the founder's first monthly run,
// E11.6-15), served by the repository's own build. Axe's WCAG 2.2 AA rules
// run on every price route at every design width in both themes, as
// test/accessibility.test.mjs runs them on the static routes. The lab run
// measures a representative page of each kind, the largest the data makes,
// in the E11.5-12 harness (scripts/design/landing-performance.mjs): LCP
// < 2.5 s, CLS < 0.1 and INP < 200 ms. Evidence:
// docs/testing/e11-6-price-pages-audit.md.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const browserContainer = `valstara-e11-6-16-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const wcag22aaTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const data = await committedPriceData();

let server;
let browser;
let browserServer;
let origin;

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
  server = await startPriceAuditServer({
    label: 'E11.6-16 browser audit',
    host: '0.0.0.0',
  });
  origin = `http://host.docker.internal:${server.port}`;
  browser = await chromium.connect(await startBrowserServer());
});

after(async () => {
  await browser?.close();
  await stopBrowserServer();
  await server?.dispose();
});

// The same runner as test/accessibility.test.mjs: the page at rest, then
// axe-core's WCAG 2.2 AA rules, injected into the test browser only.
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

/** Axe at every design width, in one theme, on one route. */
async function violationsAtEveryWidth(path, colorScheme) {
  const context = await browser.newContext({
    colorScheme,
    viewport: { width: designWidths[0], height: 900 },
  });
  try {
    const page = await context.newPage();
    // The signup island's Turnstile loader is answered with an empty script:
    // the widget is Cloudflare's, and the privacy crawl loads the real one.
    await page.route('https://challenges.cloudflare.com/**', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: '' }),
    );
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    assert.equal(response?.status(), 200, `${path} answers`);
    const found = [];
    for (const width of designWidths) {
      await page.setViewportSize({ width, height: 900 });
      const violations = await axeViolations(page);
      if (violations.length > 0)
        found.push({ path, width, colorScheme, violations });
    }
    return found;
  } finally {
    await context.close();
  }
}

test('accessibility: every price route of the committed data has zero WCAG 2.2 AA violations at every design width in both themes', async () => {
  assert.ok(data.routes.length > 0, `${data.routes.length} price routes`);
  const runs = data.routes.flatMap(({ path }) =>
    designThemes.map((colorScheme) => ({ path, colorScheme })),
  );
  const found = (
    await inPool(runs, 4, ({ path, colorScheme }) =>
      violationsAtEveryWidth(path, colorScheme),
    )
  ).flat();
  assert.deepEqual(
    found,
    [],
    `axe found WCAG 2.2 AA violations: ${JSON.stringify(found)}`,
  );
});

test('accessibility: the price-route runner fails on a planted violation', async () => {
  const path = data.routes.find(
    (route) => route.kind === 'service-market',
  ).path;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route('https://challenges.cloudflare.com/**', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: '' }),
    );
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
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

// Finding L1 (docs/testing/e11-6-price-pages-audit.md): every price layout
// set its H1 at --step-4 and --step-5 on --leading-1, a 20px line under a
// 24px and a 32px font, so a wrapped heading's lines overlapped. The layout
// checks' text rule, on every route kind at every design width in both
// themes, now finds no heading that overflows its box.
test('L1: no price page heading overflows its line box, at every design width in both themes', async () => {
  const kinds = new Map();
  for (const route of data.routes)
    if (!kinds.has(route.kind)) kinds.set(route.kind, route.path);
  const found = [];
  for (const path of kinds.values())
    for (const colorScheme of designThemes) {
      const context = await browser.newContext({
        ...atRestContext,
        colorScheme,
      });
      try {
        const page = await context.newPage();
        await page.route('https://challenges.cloudflare.com/**', (route) =>
          route.fulfill({ contentType: 'text/javascript', body: '' }),
        );
        for (const width of designWidths) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${origin}${path}`, { waitUntil: 'load' });
          const headings = (await checkPageLayout(page)).filter((issue) =>
            /^(?:overflowing|clipped) text: h[1-6]$/u.test(issue),
          );
          if (headings.length > 0)
            found.push({ path, width, colorScheme, headings });
        }
      } finally {
        await context.close();
      }
    }
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// The lab performance run.

/** Each kind's representative: its largest page, by served HTML bytes. */
async function representatives() {
  const served = await fetchRoutes(
    server.port,
    data.routes.map((route) => route.path),
  );
  const chosen = new Map();
  for (const { path, kind } of data.routes) {
    const bytes = served.get(path).body.length;
    if (!chosen.has(kind) || bytes > chosen.get(kind).bytes)
      chosen.set(kind, { path, kind, bytes });
  }
  return [...chosen.values()];
}

// Turnstile's loader is answered with a stand-in whose widget never calls
// back, so the figures are the site's own, not Cloudflare's, and typing in
// the signup field runs the island's real code up to the security check.
const turnstileStandIn =
  'globalThis.turnstile = { render: () => "audit-widget", reset() {}, remove() {} };';
const prepareContext = (context) =>
  context.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: turnstileStandIn }),
  );

/** The interactions every price page offers: the theme control and the keyboard. */
function interactionsFor(kind) {
  const toggle = (page) => page.locator('valstara-theme-toggle button').tap();
  const steps = [toggle, toggle, (page) => page.keyboard.press('Tab')];
  if (kind === 'service-market')
    steps.push(
      (page) => page.locator('#signup-email').tap(),
      (page) => page.keyboard.type('a'),
    );
  return steps;
}

test(
  'performance: each price page kind holds LCP < 2.5 s, CLS < 0.1 and INP < 200 ms in the lab harness',
  { timeout: 300_000 },
  async () => {
    const chosen = await representatives();
    assert.deepEqual(
      chosen.map((item) => item.kind).sort(),
      [
        'market-hub',
        'monthly',
        'price-index',
        'prices',
        'service-hub',
        'service-market',
      ],
      'every page kind of the committed data is measured',
    );
    for (const { path, kind, bytes } of chosen) {
      const interactions = interactionsFor(kind);
      const figures = await measurePagePerformance(browser, origin, path, {
        prepareContext,
        interactions,
      });
      process.stdout.write(
        `# ${JSON.stringify({ kind, bytes, ...figures })}\n`,
      );
      assert.ok(
        figures.largestContentfulPaintMilliseconds !== null &&
          figures.largestContentfulPaintMilliseconds <
            largestContentfulPaintBudgetMilliseconds,
        `${path} LCP ${figures.largestContentfulPaintMilliseconds}ms`,
      );
      assert.ok(
        figures.cumulativeLayoutShift < cumulativeLayoutShiftBudget &&
          figures.cumulativeLayoutShiftAfterInteraction <
            cumulativeLayoutShiftBudget,
        `${path} CLS ${figures.cumulativeLayoutShift} / ${figures.cumulativeLayoutShiftAfterInteraction}`,
      );
      assert.ok(
        figures.interactionCount >= interactions.length,
        `${path}: ${figures.interactionCount} interactions measured`,
      );
      assert.ok(
        figures.interactionToNextPaintMilliseconds === null ||
          figures.interactionToNextPaintMilliseconds <
            interactionToNextPaintBudgetMilliseconds,
        `${path} INP ${figures.interactionToNextPaintMilliseconds}ms`,
      );
    }
  },
);

test(
  'performance: the INP measurement reports a planted slow interaction',
  { timeout: 120_000 },
  async () => {
    const path = data.routes.find((route) => route.kind === 'prices').path;
    const figures = await measurePagePerformance(browser, origin, path, {
      prepareContext: async (context) => {
        await prepareContext(context);
        // A click handler that holds the main thread for 300ms of wall time.
        await context.addInitScript(() => {
          globalThis.addEventListener(
            'click',
            () => {
              const until = globalThis.performance.now() + 300;
              while (globalThis.performance.now() < until);
            },
            { capture: true },
          );
        });
      },
      interactions: [
        (page) => page.locator('valstara-theme-toggle button').tap(),
      ],
    });
    assert.ok(figures.interactionCount >= 1);
    assert.ok(
      figures.interactionToNextPaintMilliseconds !== null &&
        figures.interactionToNextPaintMilliseconds >= 300,
      `INP ${figures.interactionToNextPaintMilliseconds}ms`,
    );
  },
);
