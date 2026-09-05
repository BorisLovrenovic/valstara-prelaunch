import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';

import { landingCopy } from '../src/copy/landing.ts';

const execFileAsync = promisify(execFile);
const appPort = 43_236;
const browserPort = 43_237;
const hostOrigin = `http://127.0.0.1:${appPort}`;
const browserOrigin = `http://host.docker.internal:${appPort}`;
const browserServerEndpoint = `ws://127.0.0.1:${browserPort}/`;
const browserContainer = `valstara-landing-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

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
  throw new Error('Landing theme test server did not start.');
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
  // No reachable database: the flag read fails safe to its registered default
  // (signup on), so the form renders and this test never depends on a fixture.
  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-landing',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'landing-theme-prefix-pepper',
      PORT: String(appPort),
      RESEND_API_KEY: 'landing-theme-resend-key',
      RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
      TURNSTILE_SECRET_KEY: 'landing-theme-turnstile-secret',
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
