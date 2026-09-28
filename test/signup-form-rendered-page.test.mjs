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
  // registered default (signup on), so the form island renders. Most signup
  // requests are intercepted in-browser; the no-JS case deliberately reaches
  // the real route and is rejected at the empty-token boundary before DB work.
  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      ADMIN_CREDENTIAL: 'signup-form-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-signup',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'signup-form-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'signup-form-referral-secret',
      PORT: String(appPort),
      RESEND_API_KEY: 'signup-form-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
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

async function openForm({
  javaScriptEnabled = true,
  turnstileDelay = 0,
  turnstileMode = 'success',
  turnstileToken = 'rendered-page-turnstile-token',
} = {}) {
  const context = await browser.newContext({ javaScriptEnabled });
  if (javaScriptEnabled) {
    await context.route('https://challenges.cloudflare.com/**', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: '' }),
    );
    await context.addInitScript(
      ({ delay, mode, token }) => {
        globalThis.turnstile = {
          ready(callback) {
            callback();
          },
          render(_element, options) {
            globalThis.setTimeout(() => {
              if (mode === 'error') {
                options['error-callback']();
              } else if (mode === 'expired') {
                options['expired-callback']();
              } else {
                options.callback(token);
              }
            }, delay);
            return 'test-widget';
          },
          reset() {},
        };
      },
      { delay: turnstileDelay, mode: turnstileMode, token: turnstileToken },
    );
  }
  const page = await context.newPage();
  await page.goto(browserOrigin, { waitUntil: 'domcontentloaded' });
  if (javaScriptEnabled) {
    await page.evaluate(() =>
      globalThis.customElements.whenDefined('valstara-signup-form'),
    );
  }
  return { context, page };
}

test('the rendered form has no location field, an unticked versioned opt-in, and the 18+ statement beside submit', async () => {
  const { context, page } = await openForm({ javaScriptEnabled: false });
  try {
    assert.equal(
      await page.locator('[name="country"], [name="region"]').count(),
      0,
    );
    const optIn = page.locator('[name="marketing_opt_in"]');
    assert.equal(await optIn.count(), 1);
    assert.equal(await optIn.isChecked(), false);
    assert.equal(await optIn.inputValue(), 'v1');
    assert.match(
      await page.locator('label.signup-marketing').textContent(),
      /weekly updates and product news/u,
    );
    assert.equal(
      await page.locator('[data-submit] + .signup-age').textContent(),
      'Open to people aged 18 and over.',
    );
  } finally {
    await context.close();
  }
});

test('the no-JS form explains the requirement and the real route rejects its empty token', async () => {
  const { context, page } = await openForm({ javaScriptEnabled: false });
  assert.match(
    await page.locator('noscript').textContent(),
    /JavaScript is required/u,
  );

  await page.fill('#signup-email', 'nojs@gmail.com');
  const responsePromise = page.waitForResponse('**/api/signup');
  await page.click('[data-submit]');
  const response = await responsePromise;
  assert.equal(response.status(), 400);
  assert.equal((await response.json()).error.code, 'challenge_failed');

  await context.close();
});

test('submission waits for delayed Turnstile resolution and posts the resolved token', async () => {
  const { context, page } = await openForm({ turnstileDelay: 250 });
  let submittedBody;
  let requestSeen = false;
  await page.route('**/api/signup', async (route) => {
    requestSeen = true;
    submittedBody = route.request().postDataBuffer();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'pending', message: 'Check your inbox.' }),
    });
  });

  await page.fill('#signup-email', 'delayed@example.com');
  await page.click('[data-submit]');
  await page.waitForTimeout(100);
  assert.equal(
    requestSeen,
    false,
    'no request is sent before Turnstile resolves',
  );
  await page.waitForResponse('**/api/signup');

  const body = submittedBody?.toString('utf8') ?? '';
  assert.match(
    body,
    /name="turnstile_token"\r\n\r\nrendered-page-turnstile-token/u,
  );
  await context.close();
});

for (const turnstileMode of ['expired', 'error']) {
  test(`a Turnstile ${turnstileMode} callback fails honestly without submitting`, async () => {
    const { context, page } = await openForm({
      turnstileDelay: 50,
      turnstileMode,
    });
    let requestSeen = false;
    await page.route('**/api/signup', () => {
      requestSeen = true;
    });
    await page.fill('#signup-email', `${turnstileMode}@example.com`);
    await page.click('[data-submit]');
    await page.waitForSelector('[data-form-error]:not([hidden])');
    assert.match(
      await page.locator('[data-form-error]').textContent(),
      /couldn't complete the security check/u,
    );
    assert.equal(requestSeen, false);
    assert.equal(await page.locator('[data-submit]').isEnabled(), true);
    await context.close();
  });
}

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
      code: 'blocked_domain',
      status: 400,
      message: 'Use a permanent email address to join the waitlist.',
      target: '[data-error-for="email"]',
      invalidControl: '#signup-email',
    },
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
