import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const appPort = 43_224;
const browserPort = 43_225;
const hostOrigin = `http://127.0.0.1:${appPort}`;
const browserOrigin = `http://host.docker.internal:${appPort}`;
const browserServerEndpoint = `ws://127.0.0.1:${browserPort}/`;
const browserContainer = `valstara-layout-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const permanentFooterUrls = [
  '/legit',
  '/guarantee',
  '/about',
  '/terms',
  '/privacy',
];

let browser;
let browserServer;
let browserServerError;
let server;

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
  throw new Error('Layout rendered-page test server did not start.');
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

before(async () => {
  await execFileAsync('npm', ['run', 'build']);
  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL:
        'postgresql://unused:unused@127.0.0.1:5434/unused-layout-test',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'layout-rendered-page-prefix-pepper',
      PORT: String(appPort),
      RESEND_API_KEY: 'layout-rendered-page-resend-key',
      RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
      TURNSTILE_SECRET_KEY: 'layout-rendered-page-turnstile-secret',
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

test('the shell exposes one main landmark and a skip link as the first focusable element', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserOrigin);

  // Exactly one main, and the banner/contentinfo landmarks are present.
  assert.equal(await page.getByRole('main').count(), 1);
  assert.equal(await page.getByRole('banner').count(), 1);
  assert.equal(await page.getByRole('contentinfo').count(), 1);
  assert.equal(await page.locator('main').getAttribute('id'), 'main-content');

  // The very first Tab lands on the skip link, and it points at the main.
  await page.keyboard.press('Tab');
  const skipLink = page.locator('a.skip-link');
  assert.equal(
    await skipLink.evaluate((element) => element.matches(':focus')),
    true,
    'the skip link is the first focusable element',
  );
  assert.equal(await skipLink.getAttribute('href'), '#main-content');

  // Hidden off-screen by default, it becomes visible within the viewport once
  // focused, so a keyboard visitor can see and use it. The reveal is a timed
  // transition, so wait for it to settle before sampling the box — otherwise
  // the position is read mid-animation and the assertion races the transition.
  await page.waitForFunction(() => {
    const link = globalThis.document.querySelector('a.skip-link');
    return link !== null && link.getBoundingClientRect().top >= 0;
  });
  const focusedBox = await skipLink.boundingBox();
  assert.ok(
    focusedBox !== null && focusedBox.y >= 0,
    'skip link is visible on focus',
  );

  // Following it moves the document to the main content.
  await skipLink.press('Enter');
  assert.equal(new URL(page.url()).hash, '#main-content');

  await context.close();
});

test('the landing page ships only the theme toggle and signup form islands', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserOrigin);

  // The shell itself adds only the theme toggle; the landing page adds the one
  // signup form island (E3-05) plus Cloudflare's Turnstile loader, the sole
  // always-on off-origin request (ADR-006, Option A). Every script must fall
  // into one of these three buckets — a stray script or a third island fails.
  const scripts = await page.locator('script').evaluateAll((elements) =>
    elements.map((element) => ({
      content: element.textContent ?? '',
      src: element.getAttribute('src') ?? '',
    })),
  );
  const theme = scripts.filter((script) =>
    script.content.includes('valstara-theme'),
  );
  const signupIsland = scripts.filter((script) =>
    script.content.includes('valstara-signup-form'),
  );
  const turnstileLoader = scripts.filter((script) =>
    script.src.includes('challenges.cloudflare.com/turnstile'),
  );

  assert.equal(theme.length, 2, 'the toggle bootstrap and island scripts ship');
  assert.equal(signupIsland.length, 1, 'exactly one signup form island ships');
  assert.equal(turnstileLoader.length, 1, 'the Turnstile loader ships once');
  assert.equal(
    scripts.length,
    theme.length + signupIsland.length + turnstileLoader.length,
    'no other script ships (no third island)',
  );

  await context.close();
});

test('the footer links to the permanent trust and legal URLs', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserOrigin);

  const footer = page.getByRole('contentinfo');
  const hrefs = await footer
    .locator('a')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute('href')),
    );
  assert.deepEqual(hrefs, permanentFooterUrls);

  await context.close();
});

test('the page never scrolls horizontally from 320px upward', async () => {
  const breakpoints = [320, 375, 414, 768, 1024, 1440];
  const context = await browser.newContext();
  const page = await context.newPage();

  for (const width of breakpoints) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(browserOrigin);
    const overflow = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth,
    );
    assert.ok(
      overflow <= width,
      `no horizontal overflow at ${width}px (content width ${overflow})`,
    );
  }

  await context.close();
});
