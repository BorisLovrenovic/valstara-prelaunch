import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-layout-playwright-${process.pid}`;
const appServerStartupTimeoutMilliseconds = 30_000;
const serverOutputLimit = 16_384;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const permanentFooterUrls = [
  '/legit',
  '/guarantee',
  '/about',
  '/terms',
  '/privacy',
];

let appPort;
let browser;
let browserOrigin;
let browserServer;
let browserServerError;
let server;
let serverError;
let serverOutput = '';

async function availablePort() {
  const socket = createNetServer();
  socket.listen(0, '0.0.0.0');
  await once(socket, 'listening');
  const { port } = socket.address();
  socket.close();
  await once(socket, 'close');
  return port;
}

async function waitForAppServer() {
  const deadline =
    globalThis.performance.now() + appServerStartupTimeoutMilliseconds;

  while (globalThis.performance.now() < deadline) {
    if (serverError !== undefined) {
      throw new Error(
        `Could not start the layout rendered-page test server: ${serverError.message}`,
        { cause: serverError },
      );
    }
    if (server.exitCode !== null) {
      throw new Error(
        `Layout rendered-page test server exited before startup.\n${serverOutput || '(no server output)'}`,
      );
    }
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${appPort}`, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        browserOrigin = `http://host.docker.internal:${appPort}`;
        return;
      }
    } catch {
      // The app server may still be finishing startup.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error(
    `Layout rendered-page test server did not start within 30 seconds.\n${serverOutput || '(no server output)'}`,
  );
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
      const { stdout } = await execFileAsync('docker', [
        'port',
        browserContainer,
        '3000/tcp',
      ]);
      const port = /^127\.0\.0\.1:(\d+)\s*$/mu.exec(stdout)?.[1];
      assert.ok(port, `Docker did not publish the browser port: ${stdout}`);
      return `ws://127.0.0.1:${port}/`;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    appPort = await availablePort();
    serverOutput = '';
    serverError = undefined;
    server = spawn(process.execPath, ['dist/server/entry.mjs'], {
      env: {
        ...process.env,
        ADMIN_CREDENTIAL: 'layout-rendered-admin-credential-32-chars',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL:
          'postgresql://unused:unused@127.0.0.1:5434/unused-layout-test',
        HOST: '0.0.0.0',
        IP_PREFIX_PEPPER: 'layout-rendered-page-prefix-pepper',
        REFERRAL_SIGNING_SECRET: 'layout-rendered-page-referral-secret',
        PORT: String(appPort),
        RESEND_API_KEY: 'layout-rendered-page-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: 'layout-rendered-page-turnstile-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');
    const captureServerOutput = (chunk) => {
      serverOutput = `${serverOutput}${chunk}`.slice(-serverOutputLimit);
    };
    server.stdout.on('data', captureServerOutput);
    server.stderr.on('data', captureServerOutput);
    server.once('error', (error) => {
      serverError = error;
    });
    try {
      await waitForAppServer();
      break;
    } catch (error) {
      if (!serverOutput.includes('EADDRINUSE') || attempt === 2) throw error;
    }
  }
  const browserServerEndpoint = await startBrowserServer();
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
  if (server !== undefined && server.exitCode === null) {
    const serverExited = once(server, 'exit');
    server.kill('SIGTERM');
    await serverExited;
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
      type: element.getAttribute('type') ?? '',
    })),
  );
  const theme = scripts.filter((script) =>
    script.content.includes('valstara-theme'),
  );
  const signupIsland = scripts.filter((script) =>
    /SignupForm\.astro[^"']*\.js/u.test(script.src),
  );
  const turnstileLoader = scripts.filter((script) =>
    script.src.includes('challenges.cloudflare.com/turnstile'),
  );
  const structuredData = scripts.filter(
    (script) => script.type === 'application/ld+json',
  );

  assert.equal(theme.length, 2, 'the toggle bootstrap and island scripts ship');
  assert.equal(signupIsland.length, 1, 'exactly one signup form island ships');
  assert.equal(turnstileLoader.length, 1, 'the Turnstile loader ships once');
  assert.equal(
    structuredData.length,
    1,
    'one inert Organisation JSON-LD block ships',
  );
  assert.equal(JSON.parse(structuredData[0].content)['@type'], 'Organization');
  assert.equal(
    scripts.length,
    theme.length +
      signupIsland.length +
      turnstileLoader.length +
      structuredData.length,
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
