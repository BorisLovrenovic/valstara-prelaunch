import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const appPort = 43_260;
const browserPort = 43_261;
const hostOrigin = `http://127.0.0.1:${appPort}`;
const browserOrigin = `http://host.docker.internal:${appPort}`;
const browserServerEndpoint = `ws://127.0.0.1:${browserPort}/`;
const browserContainer = `valstara-signup-playwright-${process.pid}`;
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
  throw new Error('Signup-form rendered-page test server did not start.');
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
  // No reachable database is needed: the landing flag read fails safe to its
  // registered default (signup on), so the form island renders. Every request
  // to /api/signup is intercepted in-browser, so the route is never exercised.
  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-signup',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'signup-form-prefix-pepper',
      PORT: String(appPort),
      RESEND_API_KEY: 'signup-form-resend-key',
      RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
      TURNSTILE_SECRET_KEY: 'signup-form-turnstile-secret',
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

async function openForm({ javaScriptEnabled = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  await page.goto(browserOrigin, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

test('the form posts to /api/signup even with JavaScript disabled', async () => {
  const { context, page } = await openForm({ javaScriptEnabled: false });
  const posted = [];
  await page.route('**/api/signup', async (route) => {
    const request = route.request();
    posted.push({ body: request.postData(), method: request.method() });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'pending', message: 'Check your inbox.' }),
    });
  });

  await page.fill('#signup-email', 'nojs@example.com');
  await page.selectOption('#signup-country', 'US');
  const request = page.waitForRequest('**/api/signup');
  await page.click('[data-submit]');
  await request;

  assert.equal(posted.length, 1, 'a native submit reaches the route');
  assert.equal(posted[0].method, 'POST');
  // A no-JS native submit is application/x-www-form-urlencoded — parse it rather
  // than pattern-match the percent-encoding, and prove the fields carried.
  const submitted = new globalThis.URLSearchParams(posted[0].body ?? '');
  assert.equal(submitted.get('email'), 'nojs@example.com');
  assert.equal(submitted.get('country'), 'US');

  await context.close();
});

test('a double click submits exactly once', async () => {
  const { context, page } = await openForm();
  let requestCount = 0;
  await page.route('**/api/signup', async (route) => {
    requestCount += 1;
    // Hold the first request in flight so a second click would race it.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 400));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'pending', message: 'Check your inbox.' }),
    });
  });

  await page.fill('#signup-email', 'twice@example.com');
  await page.selectOption('#signup-country', 'US');
  const submit = page.locator('[data-submit]');
  await submit.click();
  await submit.click({ force: true }).catch(() => {});
  await page.waitForResponse('**/api/signup');

  assert.equal(requestCount, 1, 'the second click is ignored while in flight');
  await context.close();
});

test('a pending response hides the form and shows the success message', async () => {
  const { context, page } = await openForm();
  await page.route('**/api/signup', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'pending',
        message: 'Check your inbox — confirm your email.',
      }),
    }),
  );

  await page.fill('#signup-email', 'pending@example.com');
  await page.selectOption('#signup-country', 'US');
  await page.click('[data-submit]');

  await page.waitForSelector('[data-success]:not([hidden])');
  assert.match(
    await page.locator('[data-success]').textContent(),
    /confirm your email/u,
  );
  assert.equal(await page.locator('form').isHidden(), true);
  await context.close();
});

test('each server error code renders its message at the right target', async () => {
  const cases = [
    {
      code: 'invalid_email',
      status: 400,
      message: 'Enter a valid email address.',
      target: '[data-error-for="email"]',
      invalidControl: '#signup-email',
    },
    {
      code: 'rate_limited',
      status: 429,
      message: 'Too many attempts — try again in a few minutes.',
      target: '[data-form-error]',
    },
    {
      code: 'challenge_failed',
      status: 400,
      message: "We couldn't confirm that request. Please try again.",
      target: '[data-form-error]',
    },
  ];

  for (const scenario of cases) {
    const { context, page } = await openForm();
    await page.route('**/api/signup', (route) =>
      route.fulfill({
        status: scenario.status,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: scenario.code, message: scenario.message },
        }),
      }),
    );

    await page.fill('#signup-email', 'err@example.com');
    await page.selectOption('#signup-country', 'US');
    await page.click('[data-submit]');

    await page.waitForSelector(`${scenario.target}:not([hidden])`);
    assert.equal(
      await page.locator(scenario.target).textContent(),
      scenario.message,
      `${scenario.code} renders its copy at ${scenario.target}`,
    );
    if (scenario.invalidControl !== undefined) {
      assert.equal(
        await page
          .locator(scenario.invalidControl)
          .getAttribute('aria-invalid'),
        'true',
        `${scenario.code} marks its field invalid`,
      );
    }
    // The submit re-enables so the visitor can correct and retry.
    assert.equal(await page.locator('[data-submit]').isDisabled(), false);
    await context.close();
  }
});

test('the island carries a signed ref hidden field through unchanged', async () => {
  const { context, page } = await openForm();
  const signedRef = 'REF.eyJjb2RlIjoiQUJDRCJ9.signature';
  // E4-02 will render this field server-side; simulate it here and prove the
  // island posts it verbatim and never reads or writes it.
  await page.evaluate((value) => {
    const input = globalThis.document.createElement('input');
    input.type = 'hidden';
    input.name = 'ref';
    input.value = value;
    globalThis.document.querySelector('form')?.append(input);
  }, signedRef);

  let postedBody = '';
  await page.route('**/api/signup', async (route) => {
    postedBody = route.request().postData() ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'pending', message: 'Check your inbox.' }),
    });
  });

  await page.fill('#signup-email', 'ref@example.com');
  await page.selectOption('#signup-country', 'US');
  const request = page.waitForRequest('**/api/signup');
  await page.click('[data-submit]');
  await request;

  assert.ok(postedBody.includes(signedRef), 'the ref is posted verbatim');
  assert.equal(
    await page.locator('input[name="ref"]').inputValue(),
    signedRef,
    'the island never mutated the ref field',
  );
  await context.close();
});

test('the form flow sets no cookie and writes no storage', async () => {
  const { context, page } = await openForm();
  await page.route('**/api/signup', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'pending', message: 'Check your inbox.' }),
    }),
  );

  await page.fill('#signup-email', 'storage@example.com');
  await page.selectOption('#signup-country', 'US');
  await page.click('[data-submit]');
  await page.waitForSelector('[data-success]:not([hidden])');

  assert.deepEqual(await context.cookies(), []);
  assert.deepEqual(
    await page.evaluate(() => Object.keys(globalThis.localStorage)),
    [],
  );
  assert.deepEqual(
    await page.evaluate(() => Object.keys(globalThis.sessionStorage)),
    [],
  );
  await context.close();
});
