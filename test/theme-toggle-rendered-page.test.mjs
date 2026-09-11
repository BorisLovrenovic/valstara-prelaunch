import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const appPort = 43_221;
const browserPort = 43_222;
const hostOrigin = `http://127.0.0.1:${appPort}`;
const browserOrigin = `http://host.docker.internal:${appPort}`;
const browserServerEndpoint = `ws://127.0.0.1:${browserPort}/`;
const browserContainer = `valstara-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const storageKey = 'valstara-theme';
const backgrounds = {
  dark: 'rgb(15, 15, 26)',
  light: 'rgb(250, 250, 250)',
};

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
  throw new Error('Theme rendered-page test server did not start.');
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
  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL:
        'postgresql://unused:unused@127.0.0.1:5434/unused-theme-test',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'theme-rendered-page-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'theme-rendered-page-referral-secret',
      PORT: String(appPort),
      RESEND_API_KEY: 'theme-rendered-page-resend-key',
      RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
      TURNSTILE_SECRET_KEY: 'theme-rendered-page-turnstile-secret',
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

async function firstFrameFor({ colorScheme, storedTheme }) {
  const context = await browser.newContext({ colorScheme });
  await context.addInitScript(
    ({ preferenceKey, preferenceValue }) => {
      if (preferenceValue === null) {
        globalThis.localStorage.removeItem(preferenceKey);
      } else {
        globalThis.localStorage.setItem(preferenceKey, preferenceValue);
      }

      globalThis.requestAnimationFrame(() => {
        globalThis.__valstaraFirstThemeFrame = {
          background: globalThis.getComputedStyle(
            globalThis.document.documentElement,
          ).backgroundColor,
          theme: globalThis.document.documentElement.getAttribute('data-theme'),
        };
      });
    },
    { preferenceKey: storageKey, preferenceValue: storedTheme },
  );
  const page = await context.newPage();
  await page.goto(browserOrigin, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => globalThis.__valstaraFirstThemeFrame !== undefined,
  );
  const firstFrame = await page.evaluate(
    () => globalThis.__valstaraFirstThemeFrame,
  );
  await context.close();
  return firstFrame;
}

test('the first rendered frame uses the resolved theme without a flash', async () => {
  const cases = [
    {
      colorScheme: 'light',
      expectedBackground: backgrounds.light,
      expectedTheme: null,
      storedTheme: null,
    },
    {
      colorScheme: 'dark',
      expectedBackground: backgrounds.dark,
      expectedTheme: null,
      storedTheme: null,
    },
    {
      colorScheme: 'dark',
      expectedBackground: backgrounds.light,
      expectedTheme: 'light',
      storedTheme: 'light',
    },
    {
      colorScheme: 'light',
      expectedBackground: backgrounds.dark,
      expectedTheme: 'dark',
      storedTheme: 'dark',
    },
  ];

  for (const themeCase of cases) {
    const firstFrame = await firstFrameFor(themeCase);
    assert.deepEqual(firstFrame, {
      background: themeCase.expectedBackground,
      theme: themeCase.expectedTheme,
    });
  }
});

test('the toggle is keyboard operated, labelled and announced on change', async () => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(browserOrigin);

  const darkToggle = page.getByRole('button', { name: 'Use dark theme' });
  await darkToggle.focus();
  await darkToggle.press('Enter');
  const button = page.locator('valstara-theme-toggle button');
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  assert.equal(
    await page.locator('[data-theme-toggle-status]').textContent(),
    'Dark theme selected.',
  );
  assert.equal(
    await page.evaluate(
      (key) => globalThis.localStorage.getItem(key),
      storageKey,
    ),
    'dark',
  );

  const lightToggle = page.getByRole('button', { name: 'Use light theme' });
  await lightToggle.press('Space');
  assert.equal(await button.getAttribute('aria-pressed'), 'false');
  assert.equal(
    await page.locator('[data-theme-toggle-status]').textContent(),
    'Light theme selected.',
  );
  assert.deepEqual(
    await page.evaluate(() => Object.keys(globalThis.localStorage)),
    [storageKey],
  );
  assert.deepEqual(await context.cookies(), []);

  await context.close();
});

test('the first toggle overrides a dark system preference with light', async () => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto(browserOrigin);

  const lightToggle = page.getByRole('button', { name: 'Use light theme' });
  await lightToggle.press('Enter');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(
    await page.evaluate(
      (key) => globalThis.localStorage.getItem(key),
      storageKey,
    ),
    'light',
  );

  await context.close();
});

test('JavaScript-disabled rendering follows the system theme', async () => {
  const context = await browser.newContext({
    colorScheme: 'dark',
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  await page.goto(browserOrigin);

  assert.equal(
    await page.evaluate(
      () =>
        globalThis.getComputedStyle(globalThis.document.documentElement)
          .backgroundColor,
    ),
    backgrounds.dark,
  );
  assert.equal(await page.locator('html').getAttribute('data-theme'), null);
  assert.equal(
    await page.locator('valstara-theme-toggle button').isDisabled(),
    true,
  );

  await context.close();
});
