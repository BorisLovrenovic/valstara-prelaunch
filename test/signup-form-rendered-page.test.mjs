import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';
import { signupFormCopy } from '../src/copy/signup.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';

const execFileAsync = promisify(execFile);
// No fixed ports: the app server gets a reserved port below the kernel's
// ephemeral range and Docker allocates the browser server's host port (see
// test/helpers/listen-port.mjs).
const browserContainer = `valstara-signup-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

let browser;
let browserServer;
let browserServerError;
let app;
let browserOrigin;
let browserServerEndpoint;

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
      browserServerEndpoint = `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
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
  app = await startAppServer({
    label: 'Signup-form rendered-page test',
    env: () => ({
      ADMIN_CREDENTIAL: 'signup-form-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-signup',
      EMAIL_BASE_URL: 'http://localhost:4321',
      EMAIL_TOKEN_SECRET: 'signup-rendered-test-email-token-secret-32-chars',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'signup-form-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'signup-form-referral-secret',
      RESEND_API_KEY: 'signup-form-resend-key',
      RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
      BREVO_WEBHOOK_TOKEN: 'signup-rendered-test-brevo-webhook-token',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'signup-form-turnstile-secret',
    }),
  });
  browserOrigin = `http://host.docker.internal:${app.port}`;
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
  await app?.stop();
});

async function openForm({
  javaScriptEnabled = true,
  turnstileDelay = 0,
  turnstileMode = 'success',
  turnstileToken = 'rendered-page-turnstile-token',
  viewport,
  accelerateResend = false,
} = {}) {
  const context = await browser.newContext({ javaScriptEnabled, viewport });
  if (accelerateResend) {
    await context.addInitScript(() => {
      const original = globalThis.setTimeout.bind(globalThis);
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 60_000) {
          globalThis.testResendDelay = delay;
          return original(callback, 100, ...args);
        }
        return original(callback, delay, ...args);
      };
    });
  }
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
            globalThis.testTurnstileOptions = options;
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
          reset() {
            globalThis.setTimeout(() => {
              if (mode === 'error')
                globalThis.testTurnstileOptions?.['error-callback']();
              else if (mode === 'expired')
                globalThis.testTurnstileOptions?.['expired-callback']();
              else globalThis.testTurnstileOptions?.callback(`${token}-fresh`);
            }, delay);
          },
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
  assert.equal(await page.locator('[data-submit]').isDisabled(), true);
  assert.equal(
    await page.locator('[data-submit]').textContent(),
    signupFormCopy.challengePending,
  );
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

test('a pending response hides the form and shows the same privacy-safe success state', async () => {
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
    /If an email from Valstara arrives/u,
  );
  assert.match(
    await page.locator('[data-success]').textContent(),
    /open it and click the link/u,
  );
  assert.match(
    await page.locator('[data-success]').textContent(),
    /pending@example.com/u,
  );
  assert.doesNotMatch(
    await page.locator('[data-success]').textContent(),
    /\b(position|rank|\d+)\b/u,
  );
  assert.equal(await page.locator('form').isHidden(), true);
  await page.click('[data-different-address]');
  assert.equal(await page.locator('form').isVisible(), true);
  assert.equal(await page.locator('#signup-email').inputValue(), '');
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

test('dock is server-hidden, appears only after hero leaves, and carries one form and widget', async () => {
  const noJs = await openForm({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 600 },
  });
  assert.equal(
    await noJs.page.locator('[data-dock]').getAttribute('hidden'),
    '',
  );
  await noJs.context.close();

  const { context, page } = await openForm({
    viewport: { width: 390, height: 600 },
  });
  try {
    assert.equal(await page.locator('[data-dock]').isVisible(), false);
    assert.equal(await page.locator('valstara-signup-form').count(), 1);
    assert.equal(await page.locator('valstara-signup-form form').count(), 1);
    assert.equal(await page.locator('[data-turnstile-container]').count(), 1);
    assert.equal(await page.locator('[name="email"]').count(), 1);
    await page.fill('#signup-email', 'mirrored@example.com');
    await page.evaluate(() => globalThis.scrollTo(0, 700));
    await page.waitForFunction(
      () => !globalThis.document.querySelector('[data-dock]').hidden,
    );
    assert.equal(
      await page.locator('[data-dock]').getAttribute('role'),
      'region',
    );
    assert.equal(
      await page.locator('#signup-dock-email').inputValue(),
      'mirrored@example.com',
    );
    await page.fill('#signup-dock-email', 'revised@example.com');
    assert.equal(
      await page.locator('#signup-email').inputValue(),
      'revised@example.com',
    );
    assert.match(
      await page.locator('[data-dock]').textContent(),
      /Open to people aged 18 and over/u,
    );
    assert.equal(
      await page.locator('[data-dock-entry] .signup-age').count(),
      1,
    );
    await page.locator('body > footer').scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () => globalThis.document.querySelector('[data-dock]').hidden,
    );
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    await page.waitForFunction(
      () => globalThis.document.querySelector('[data-dock]').hidden,
    );
    await page.setViewportSize({ width: 768, height: 600 });
    await page.evaluate(() => globalThis.scrollTo(0, 700));
    assert.equal(await page.locator('[data-dock]').isVisible(), false);
  } finally {
    await context.close();
  }
});

test('dock and hero submit the same form body, including signed capture and opt-in', async () => {
  const bodies = [];
  for (const entry of ['hero', 'dock']) {
    const { context, page } = await openForm({
      viewport: { width: 390, height: 600 },
    });
    try {
      await page.evaluate(() => {
        const input = globalThis.document.createElement('input');
        input.type = 'hidden';
        input.name = 'referral_capture';
        input.value = 'signed-capture';
        globalThis.document
          .querySelector('valstara-signup-form form')
          .append(input);
      });
      await page.locator('[name="marketing_opt_in"]').check();
      await page.route('**/api/signup', (route) => {
        const fields = new Map();
        for (const match of (route.request().postData() ?? '').matchAll(
          /name="([^"]+)"\r\n\r\n([^\r]*)/gu,
        )) {
          fields.set(match[1], match[2]);
        }
        bodies.push(fields);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'pending', message: 'generic' }),
        });
      });
      if (entry === 'dock') {
        await page.evaluate(() => globalThis.scrollTo(0, 700));
        await page.waitForFunction(
          () => !globalThis.document.querySelector('[data-dock]').hidden,
        );
        await page.fill('#signup-dock-email', 'same@example.com');
        await page.click('[data-dock-submit]');
      } else {
        await page.fill('#signup-email', 'same@example.com');
        await page.click('[data-submit]');
      }
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
    } finally {
      await context.close();
    }
  }
  assert.equal(bodies.length, 2);
  assert.deepEqual([...bodies[0]].sort(), [...bodies[1]].sort());
  assert.equal(bodies[0].get('referral_capture'), 'signed-capture');
  assert.equal(bodies[0].get('marketing_opt_in'), 'v1');
});

test('success is identical for unknown, pending and verified responses and echoes only client input', async () => {
  const results = [];
  for (const membership of ['unknown', 'pending', 'verified']) {
    const { context, page } = await openForm();
    try {
      await page.route('**/api/signup', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'pending',
            message: `server-${membership}-secret`,
          }),
        }),
      );
      await page.fill('#signup-email', 'typed@example.com');
      await page.click('[data-submit]');
      await page.waitForSelector('[data-success]:not([hidden])');
      results.push(await page.locator('[data-success]').innerText());
      assert.equal(await page.locator('[data-resend]').isVisible(), false);
      assert.equal(
        await page.locator('[data-success-address]').textContent(),
        'typed@example.com',
      );
      assert.equal(
        await page
          .locator('[data-success]')
          .textContent()
          .then((text) => text.includes('server-')),
        false,
      );
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(results, [results[0], results[0], results[0]]);
});

test('resend waits sixty seconds, uses a fresh token, and shows the route acknowledgement', async () => {
  const { context, page } = await openForm({ accelerateResend: true });
  const tokens = [];
  try {
    await page.route('**/api/signup', (route) => {
      const raw = route.request().postData() ?? '';
      tokens.push(/name="turnstile_token"\r\n\r\n([^\r]*)/u.exec(raw)?.[1]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending', message: 'generic' }),
      });
    });
    await page.route('**/api/resend-verification', (route) => {
      const raw = route.request().postData() ?? '';
      tokens.push(/name="turnstile_token"\r\n\r\n([^\r]*)/u.exec(raw)?.[1]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'pending',
          message: 'Same acknowledgement for every address.',
        }),
      });
    });
    await page.fill('#signup-email', 'retry@example.com');
    await page.click('[data-submit]');
    await page.waitForSelector('[data-success]:not([hidden])');
    assert.equal(await page.locator('[data-resend]').isVisible(), false);
    assert.equal(await page.evaluate(() => globalThis.testResendDelay), 60_000);
    await page.waitForSelector('[data-resend]:visible');
    await page.click('[data-resend]');
    await page.waitForSelector('[data-resend-status]:not([hidden])');
    assert.equal(
      await page.locator('[data-resend-status]').textContent(),
      'Same acknowledgement for every address.',
    );
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    assert.equal(tokens[1], 'rendered-page-turnstile-token-fresh');
  } finally {
    await context.close();
  }
});

test('bar reports a field error and cross-entry double submit sends one request', async () => {
  const { context, page } = await openForm({
    viewport: { width: 320, height: 400 },
  });
  try {
    await page.evaluate(() => {
      const form = globalThis.document.querySelector(
        'valstara-signup-form form',
      );
      globalThis.scrollTo(
        0,
        form.getBoundingClientRect().bottom + globalThis.scrollY + 20,
      );
    });
    await page.waitForFunction(
      () => !globalThis.document.querySelector('[data-dock]').hidden,
    );
    await page.route('**/api/signup', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'invalid_email',
            message: 'Enter a valid email address.',
          },
        }),
      }),
    );
    const inputBox = await page.locator('#signup-dock-email').boundingBox();
    await page.mouse.click(
      inputBox.x + inputBox.width / 2,
      inputBox.y + inputBox.height / 2,
    );
    await page.keyboard.insertText('bad@example.com');
    const dockButton = page.locator('[data-dock-submit]');
    const firstBox = await dockButton.boundingBox();
    await page.mouse.click(
      firstBox.x + firstBox.width / 2,
      firstBox.y + firstBox.height / 2,
    );
    await page.waitForSelector('[data-dock-error]:not([hidden])');
    assert.equal(
      await page.locator('#signup-dock-email').getAttribute('aria-invalid'),
      'true',
    );
    assert.equal(
      await page.locator('[data-dock-error]').getAttribute('role'),
      'alert',
    );
    await page.unroute('**/api/signup');
    let requests = 0;
    await page.route('**/api/signup', async (route) => {
      requests += 1;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending', message: 'generic' }),
      });
    });
    const secondBox = await dockButton.boundingBox();
    await page.mouse.click(
      secondBox.x + secondBox.width / 2,
      secondBox.y + secondBox.height / 2,
    );
    await page.evaluate(() =>
      globalThis.document.querySelector('[data-submit]').click(),
    );
    await page.waitForSelector('[data-success]:not([hidden])');
    assert.equal(requests, 1);
    assert.equal(
      await page.locator('[data-dock-confirmation]').isVisible(),
      true,
    );
    assert.equal(
      await page
        .locator('[data-dock-confirmation] p')
        .evaluate(
          (element) =>
            element.offsetHeight <=
            Number.parseFloat(globalThis.getComputedStyle(element).lineHeight) +
              1,
        ),
      true,
    );
  } finally {
    await context.close();
  }
});

test('bar announces form errors without marking its email field invalid', async () => {
  for (const scenario of [
    {
      code: 'challenge_failed',
      status: 400,
      message: "We couldn't confirm that request. Please try again.",
    },
    {
      code: 'rate_limited',
      status: 429,
      message: 'Too many attempts — try again in a few minutes.',
    },
    {
      code: 'unavailable',
      status: 503,
      message: "We can't take signups right now — try again in a few minutes.",
    },
    {
      code: 'connection',
      message: signupFormCopy.connection,
    },
  ]) {
    const { context, page } = await openForm({
      viewport: { width: 320, height: 400 },
    });
    try {
      await page.evaluate(() => {
        const form = globalThis.document.querySelector(
          'valstara-signup-form form',
        );
        globalThis.scrollTo(
          0,
          form.getBoundingClientRect().bottom + globalThis.scrollY + 20,
        );
      });
      await page.waitForFunction(
        () => !globalThis.document.querySelector('[data-dock]').hidden,
      );
      await page.route('**/api/signup', (route) =>
        scenario.code === 'connection'
          ? route.abort()
          : route.fulfill({
              status: scenario.status,
              contentType: 'application/json',
              body: JSON.stringify({
                error: { code: scenario.code, message: scenario.message },
              }),
            }),
      );
      await page.fill('#signup-dock-email', 'visitor@example.com');
      await page.click('[data-dock-submit]');
      await page.waitForSelector('[data-dock-error]:not([hidden])');
      assert.equal(
        await page.locator('[data-dock-error]').textContent(),
        scenario.message,
      );
      assert.equal(
        await page.locator('#signup-dock-email').getAttribute('aria-invalid'),
        null,
        `${scenario.code} is a form error, not an email error`,
      );
    } finally {
      await context.close();
    }
  }
});

test('visible dock does not cover focus while tabbing at small widths and passes axe', async () => {
  for (const width of [320, 360, 390]) {
    const { context, page } = await openForm({
      viewport: { width, height: 600 },
    });
    try {
      await page.evaluate(() => {
        const form = globalThis.document.querySelector(
          'valstara-signup-form form',
        );
        globalThis.scrollTo(
          0,
          form.getBoundingClientRect().bottom + globalThis.scrollY + 20,
        );
      });
      await page.waitForFunction(
        () => !globalThis.document.querySelector('[data-dock]').hidden,
      );
      await page.addScriptTag({ content: axe.source });
      const violations = await page.evaluate(
        async () =>
          (
            await globalThis.axe.run(globalThis.document, {
              runOnly: {
                type: 'tag',
                values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
              },
            })
          ).violations,
      );
      assert.deepEqual(
        violations.map((item) => item.id),
        [],
      );
      for (let index = 0; index < 35; index += 1) {
        await page.keyboard.press('Tab');
        await page.evaluate(
          () => new Promise(globalThis.requestAnimationFrame),
        );
        const obscured = await page.evaluate(() => {
          const active = globalThis.document.activeElement;
          const dock = globalThis.document.querySelector('[data-dock]');
          if (
            !(active instanceof globalThis.HTMLElement) ||
            dock.hidden ||
            dock.contains(active)
          )
            return false;
          const target = active.getBoundingClientRect();
          const overlay = dock.getBoundingClientRect();
          return (
            target.width > 0 &&
            target.height > 0 &&
            target.bottom > overlay.top &&
            target.top < overlay.bottom
          );
        });
        assert.equal(
          obscured,
          false,
          `focus covered at ${width}px after tab ${index}`,
        );
      }
    } finally {
      await context.close();
    }
  }
});

test('DSR request loads only approved Turnstile; emailed confirmation is inert and adds no browser storage', async () => {
  for (const query of [
    '?operation=delete',
    '?operation=export&t=inert-test-token',
  ]) {
    const context = await browser.newContext();
    const external = [];
    await context.route('https://challenges.cloudflare.com/**', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: '' }),
    );
    const page = await context.newPage();
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== browserOrigin)
        external.push(new URL(request.url()).hostname);
    });
    try {
      const response = await page.goto(`${browserOrigin}/dsr${query}`, {
        waitUntil: 'load',
      });
      assert.equal(response.status(), 200);
      assert.equal(response.headers()['cache-control'], 'private, no-store');
      assert.equal(response.headers()['referrer-policy'], 'no-referrer');
      assert.deepEqual(
        external,
        query.includes('&t=') ? [] : ['challenges.cloudflare.com'],
      );
      assert.deepEqual(await context.cookies(), []);
      assert.deepEqual(
        await page.evaluate(() => ({
          local: Object.keys(globalThis.localStorage),
          session: Object.keys(globalThis.sessionStorage),
        })),
        { local: [], session: [] },
      );
      assert.equal(await page.locator('form').getAttribute('method'), 'post');
      assert.equal(
        await page.locator('[name="token"]').count(),
        query.includes('&t=') ? 1 : 0,
      );
    } finally {
      await context.close();
    }
  }
});
