import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import axe from 'axe-core';
import { chromium } from 'playwright';
import { Pool } from 'pg';

import { verificationCopy } from '../src/copy/verification.ts';
import { surveyCopy } from '../src/copy/survey.ts';
import { resendVerificationCopy } from '../src/copy/resend-verification.ts';
import {
  accessWindows,
  milestoneTiers,
} from '../src/server/referral/config.ts';
import { verificationReferralFigures } from '../src/server/referral/verification-presentation.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import {
  checkPageLayout,
  designThemes,
  designWidths,
  enforcedPages,
} from '../scripts/design/layout-checks.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { entranceEnded, focusMotionIssues } from './helpers/motion.mjs';
import {
  buildSelectors,
  measureVerify,
} from './fixtures/final-ui/verify-measure.mjs';

// E11.5-07 built /verify; E11.5-11q restyles every state to the final-design
// canvas (Verify.dc.html, as Verify1440, Verify768 and Verify390 place it)
// and adds its motion. Every box is compared with the canvas's own, measured
// from the pinned snapshot by test/fixtures/final-ui/measure-verify-geometry.mjs
// on the self-hosted fonts, at rest (a reduced-motion context, design rule
// 12), with a 1px tolerance, in both themes.

const execFileAsync = promisify(execFile);
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = `valstara-verify-final-playwright-${process.pid}`;
const canvas = JSON.parse(
  await readFile(
    new URL('./fixtures/final-ui/verify-geometry.json', import.meta.url),
    'utf8',
  ),
);
const verifyWidths = [1440, 768, 390];
const tolerance = 1;
// The board's compact Turnstile slot (valstara.css .turnstile--compact,
// 8.75rem) and the form's 24px gap above it. The built widget renders only
// when the check needs interaction (data-appearance="interaction-only", as
// the signup form's does), so the slot is empty and takes no room
// (founder decision 2026-11-11, E11.5-11q decision 4).
const turnstileSlot = 140 + 24;
// The component library's Field puts its control 8px under the label
// (E11.5-11j). On the board, .input's own `margin: 0` cancels the
// .field__control margin that draws that gap, so its field sits 8px higher.
const fieldGap = 8;

let fixture;
let app;
let browser;
let browserServer;
let origin;
let localOrigin;

async function createFixture() {
  const name = 'valstara_verify_final_' + randomUUID().replaceAll('-', '');
  const adminUrl = new URL(databaseUrl);
  const fixtureUrl = new URL(adminUrl);
  fixtureUrl.pathname = '/' + name;
  const appUrl = new URL(fixtureUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  await admin.query('CREATE DATABASE "' + name + '"');
  const database = new Pool({ connectionString: fixtureUrl.toString() });
  await execFileAsync(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'e11-5-11q-test'],
    {
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: fixtureUrl.toString(),
        VALSTARA_APP_DB_PASSWORD: appPassword,
      },
    },
  );
  const subscribers = {};
  for (const label of ['main', 'figures', 'saved']) {
    const subscriberId = randomUUID();
    const tokenId = randomUUID();
    const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET);
    await database.query(
      "INSERT INTO subscriber (id,email,email_normalised,email_domain,status) VALUES ($1,$2,$2,'example.test','pending')",
      [subscriberId, `verify-final-${label}@example.test`],
    );
    await database.query(
      "INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'verify','2099-01-01T00:00:00Z')",
      [tokenId, subscriberId, createHash('sha256').update(token).digest()],
    );
    subscribers[label] = { subscriberId, token };
  }
  return {
    appUrl: appUrl.toString(),
    database,
    subscribers,
    async setFlag(key, enabled) {
      await database.query(
        "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ($1,$2,'e11-5-11q-test') ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled",
        [key, enabled],
      );
    },
    async dispose() {
      await database.end();
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await admin.query('DROP DATABASE "' + name + '"');
      await admin.end();
    },
  };
}

function startApp() {
  return startAppServer({
    label: 'Verification final design',
    readyPath: '/verify',
    env: () => ({
      ADMIN_CREDENTIAL: 'verify-final-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: fixture.appUrl,
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'verify-final-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'verify-final-referral-secret',
      RESEND_API_KEY: 'verify-final-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    }),
  });
}

async function restartApp() {
  await app.stop();
  app = await startApp();
  origin = `http://host.docker.internal:${app.port}`;
  localOrigin = `http://127.0.0.1:${app.port}`;
  // The browser runs in a container, which reaches a newly started server
  // only after a short delay: wait, bounded, until it answers there.
  const context = await browser.newContext();
  try {
    for (let attempt = 0; ; attempt += 1) {
      const ready = await context.request
        .get(`${origin}/verify`, { timeout: 2000 })
        .then((response) => response.ok())
        .catch(() => false);
      if (ready) break;
      assert.ok(
        attempt < 30,
        'the restarted app is reachable from the browser',
      );
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
  } finally {
    await context.close();
  }
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
  browserServer.stdout.on('data', (chunk) => (output += chunk));
  browserServer.stderr.on('data', (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 720; attempt += 1) {
    if (output.includes('Listening on'))
      return `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
    if (browserServer.exitCode !== null)
      throw new Error(`Playwright server exited.\n${output}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error(`Playwright server did not start.\n${output}`);
}

before(async () => {
  await ensureAppBuild();
  fixture = await createFixture();
  app = await startApp();
  origin = `http://host.docker.internal:${app.port}`;
  localOrigin = `http://127.0.0.1:${app.port}`;
  browser = await chromium.connect(await startBrowserServer());
});

after(async () => {
  await browser?.close();
  await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
    () => {},
  );
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
  await app?.stop();
  await fixture?.dispose();
});

// The success page, as a POST with the token renders it. A replay renders
// the same page (E3-07), so this can be fetched again at any time.
async function successHtml(token) {
  const response = await globalThis.fetch(`${localOrigin}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: localOrigin,
    },
    body: new globalThis.URLSearchParams({ token }),
  });
  assert.equal(response.status, 200);
  return response.text();
}

const scrollTimelineQuery = /\(\s*animation-timeline\s*:\s*view\(\)\s*\)/gu;
const withoutScrollTimelines = (text) =>
  text.replace(scrollTimelineQuery, '(-x-unsupported-timeline: view())');

// Opens /verify in one of its states. The success states are served from a
// replayed POST at the same URL, so a test never consumes a subscriber.
// `motion` allows motion (otherwise the page is at rest, design rule 12);
// `share` gives the browser navigator.share; `clipboard` gives it a clipboard
// that accepts ('ok') or none at all (the default on this http origin, so a
// copy fails); `survey` and `resend` answer those routes in the browser with
// a given response; `supported: false` renders without scroll-driven
// animations; `frozen` stops the animation clock before the page loads.
async function openVerify({
  state = 'success',
  token = fixture.subscribers.main.token,
  width = 1440,
  height = 900,
  theme = 'light',
  motion = false,
  javaScriptEnabled = true,
  share = false,
  clipboard = null,
  survey = null,
  resend = null,
  supported = true,
  frozen = false,
  init = null,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: motion ? 'no-preference' : 'reduce',
    javaScriptEnabled,
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.abort(),
  );
  if (share)
    await context.addInitScript(() => {
      globalThis.shared = [];
      globalThis.navigator.share = async (data) => {
        globalThis.shared.push(data);
      };
    });
  if (clipboard === 'ok')
    await context.addInitScript(() => {
      globalThis.copied = [];
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: {
          writeText: async (text) => {
            globalThis.copied.push(text);
          },
        },
      });
    });
  if (init !== null) await context.addInitScript(init);
  const success = !['confirm', 'invalid'].includes(state);
  const html = success ? await successHtml(token) : null;
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/verify' && html !== null && url.search === '')
      return route.fulfill({
        body: supported ? html : withoutScrollTimelines(html),
        contentType: 'text/html; charset=utf-8',
      });
    if (url.pathname === '/api/survey' && survey !== null)
      return route.fulfill({
        status: survey.status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(survey.body),
      });
    if (url.pathname === '/api/resend-verification' && resend !== null)
      return route.fulfill({
        status: resend.status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(resend.body),
      });
    // Every same-origin resource is served through the route: a document
    // the route fulfils counts as public to Chromium's Private Network
    // Access, which would otherwise block its stylesheets and fonts on this
    // local host.
    const response = await route.fetch();
    if (supported) return route.fulfill({ response });
    const type = response.headers()['content-type'] ?? '';
    if (!/text\/(?:html|css)/u.test(type)) return route.fulfill({ response });
    return route.fulfill({
      response,
      body: withoutScrollTimelines(await response.text()),
    });
  });
  const page = await context.newPage();
  if (frozen) {
    const session = await context.newCDPSession(page);
    await session.send('Animation.enable');
    await session.send('Animation.setPlaybackRate', { playbackRate: 0 });
  }
  await page.goto(
    state === 'confirm'
      ? `${origin}/verify?token=${encodeURIComponent(token)}`
      : `${origin}/verify`,
  );
  await page.evaluate(() => globalThis.document.fonts.ready);
  if (motion && !frozen) await entranceEnded(page);
  return { context, page };
}

const savedResponse = {
  status: 200,
  body: { message: surveyCopy.saved, status: 'saved' },
};
const skippedResponse = {
  status: 200,
  body: { message: surveyCopy.skipped, status: 'skipped' },
};
const invalidResponse = {
  status: 400,
  body: {
    error: { code: 'invalid_input', message: surveyCopy.invalidInput },
  },
};
const unavailableResponse = {
  status: 503,
  body: { error: { code: 'unavailable', message: surveyCopy.unavailable } },
};
const acceptedResponse = {
  status: 200,
  body: { status: 'pending', message: resendVerificationCopy.accepted },
};

// Drives an opened page into one of the canvas's states.
async function enterState(page, state) {
  if (state === 'copied-saved') {
    await page.locator('[data-copy-referral]').click();
    await page
      .locator('[data-copy-referral][data-copy-state="copied"]')
      .waitFor();
    await page.locator('input[value="ai"]').check();
    await page.locator('[data-survey-form] button[type="submit"]').click();
    await page.getByText(surveyCopy.saved).waitFor();
  }
  if (state === 'failed-skipped') {
    await page.locator('[data-copy-referral]').click();
    await page.getByText(verificationCopy.referral.copyFailed).waitFor();
    await page.locator('[data-survey-skip]').click();
    await page.getByText(surveyCopy.skipped).waitFor();
  }
  if (state === 'survey-errors') {
    for (const value of ['ai', 'software', 'game_keys'])
      await page.locator(`input[value="${value}"]`).check();
    await page.locator('input[value="monthly"]').check();
  }
  if (state === 'invalid-sent') {
    await page
      .locator('#resend-email')
      .fill('alexandra.konstantinidou@example.com');
    await page.locator('[data-resend-submit]').click();
    await page.locator('[data-resend-result="success"]').waitFor();
  }
}

// How each canvas state is opened.
const stateOptions = {
  confirm: { state: 'confirm' },
  success: {},
  'copied-saved': { clipboard: 'ok', survey: savedResponse },
  'failed-skipped': { survey: skippedResponse },
  'survey-errors': {},
  invalid: { state: 'invalid' },
  'invalid-sent': { state: 'invalid', resend: acceptedResponse },
  'invalid-nojs': { state: 'invalid', javaScriptEnabled: false },
};

function measure(page) {
  return page.evaluate(measureVerify, buildSelectors);
}

// Compares a measured structure with the canvas's, box by box, collecting
// every difference.
function canvasIssues(actual, expected, label, issues = []) {
  if (expected === null || actual === null || actual === undefined) {
    if ((actual ?? null) !== expected)
      issues.push(`${label} presence: ${JSON.stringify(actual)}`);
    return issues;
  }
  if (typeof expected === 'number') {
    if (Math.abs(actual - expected) > tolerance)
      issues.push(`${label}: ${actual} is not ${expected}`);
    return issues;
  }
  if (Array.isArray(expected) && typeof expected[0] === 'number') {
    ['x', 'y', 'w', 'h'].forEach((axis, index) => {
      if (Math.abs(actual[index] - expected[index]) > tolerance)
        issues.push(
          `${label} ${axis}: ${Math.round(actual[index] * 100) / 100} is not ${expected[index]}`,
        );
    });
    return issues;
  }
  if (Array.isArray(expected)) {
    if (actual.length !== expected.length)
      issues.push(`${label} count: ${actual.length} is not ${expected.length}`);
    else
      expected.forEach((item, index) =>
        canvasIssues(actual[index], item, `${label} ${index + 1}`, issues),
      );
    return issues;
  }
  for (const [key, value] of Object.entries(expected))
    canvasIssues(actual[key], value, `${label} ${key}`, issues);
  return issues;
}

// The canvas's boxes for a state, with the build's deliberate differences
// applied. Each is checked on its own by the assertions that follow, so no
// box is left unmeasured.
function canvasFor(width, state, actual) {
  const expected = globalThis.structuredClone(canvas.widths[width][state]);
  if (expected.task?.input) {
    for (const key of ['input', 'button']) expected.task[key][1] += fieldGap;
    expected.task.card[3] += fieldGap;
    expected.grid[3] += fieldGap;
  }
  if (state === 'invalid') {
    expected.task.card[3] -= turnstileSlot;
    expected.grid[3] -= turnstileSlot;
  }
  if (expected.referral) {
    // Founder decision 2026-11-10: Copy link's label cross-fades to "Link
    // copied." in place, so the button is as wide as its wider face (equal at
    // full width, below 48rem) and the link box gives up that width. Its
    // right edge, height and row are the canvas's.
    const copy = expected.referral.copy;
    const built = actual.referral.copy;
    const grown = built[2] - copy[2];
    assert.ok(grown >= 0, `${width} ${state}: Copy link is narrower`);
    // Up to 20px wider than the board's (docs/brand/page-design.md), within
    // the suite's 1px tolerance.
    assert.ok(
      grown <= 20 + tolerance,
      `${width} ${state}: Copy link is ${grown}px wider than the board's`,
    );
    if (width < 768) assert.equal(grown, 0);
    expected.referral.copy = [copy[0] - grown, copy[1], built[2], copy[3]];
    expected.referral.linkbox[2] -= grown;
    // The coral pill's text is the copy layer's "15% launch discount" in one
    // text node, which the E11.5-07 suite matches in the HTML, so its figure
    // is not wrapped in mono as the board's is: the pill is up to 4px
    // narrower. Its position and height are the canvas's.
    const [, discount] = expected.referral.pills;
    const builtDiscount = actual.referral.pills[1];
    assert.ok(
      builtDiscount[2] <= discount[2] && builtDiscount[2] >= discount[2] - 4,
      `${width} ${state}: the discount pill is ${builtDiscount[2]}px wide`,
    );
    discount[2] = builtDiscount[2];
  }
  return expected;
}

test('every /verify state matches the canvas at 1440, 768 and 390, in both themes, at rest', async () => {
  const issues = [];
  for (const width of verifyWidths)
    for (const theme of designThemes)
      for (const [state, options] of Object.entries(stateOptions)) {
        // The board draws Share link below 1024px, where navigator.share
        // usually exists, and not from 1024px (E11.5-07: it renders wherever
        // navigator.share exists, which the share test covers).
        const { context, page } = await openVerify({
          ...options,
          width,
          theme,
          share: width < 1024,
        });
        try {
          await enterState(page, state);
          const actual = await measure(page);
          if (state === 'copied-saved') {
            // Founder decision 2026-11-10: "Link copied." is the button's
            // label, and the live region that announces it is not shown, so
            // the referral card keeps its resting layout (the canvas's
            // success frame). The survey card is the board's saved state.
            const success = canvasFor(width, 'success', actual);
            const saved = canvas.widths[width]['copied-saved'];
            canvasIssues(
              actual.referral,
              success.referral,
              `${width} ${theme} ${state} referral`,
              issues,
            );
            const { card, ...inside } = saved.survey;
            canvasIssues(
              actual.survey,
              inside,
              `${width} ${theme} ${state} survey`,
              issues,
            );
            canvasIssues(
              [0, 0, actual.survey.card[2], actual.survey.card[3]],
              [0, 0, card[2], card[3]],
              `${width} ${theme} ${state} survey card size`,
              issues,
            );
            assert.equal(actual.referral.copyStatus, null);
          } else if (state === 'survey-errors') {
            // The board draws the invalid-option message and the server
            // error notice at once; the page shows one result at a time,
            // each read below. Here: the selected chips and segment.
            const drawn = canvas.widths[width][state].survey;
            for (const key of [
              'title',
              'legends',
              'chips',
              'segmented',
              'segments',
            ])
              canvasIssues(
                actual.survey[key],
                drawn[key],
                `${width} ${theme} ${state} survey ${key}`,
                issues,
              );
          } else
            canvasIssues(
              actual,
              canvasFor(width, state, actual),
              `${width} ${theme} ${state}`,
              issues,
            );
        } finally {
          await context.close();
        }
      }
  assert.deepEqual(issues, []);
});

test('the survey result: an invalid option sits under its question, a server error above the actions, as drawn', async () => {
  const issues = [];
  for (const width of verifyWidths)
    for (const theme of designThemes) {
      const drawn = canvas.widths[width]['survey-errors'].survey;
      for (const [response, check] of [
        [
          invalidResponse,
          (survey) => {
            canvasIssues(
              survey.fieldError,
              drawn.fieldError,
              `${width} ${theme} invalid option`,
              issues,
            );
            // The actions follow the message, 32px below it.
            canvasIssues(
              survey.actions[0][1] -
                (survey.fieldError[1] + survey.fieldError[3]),
              drawn.result[1] -
                (drawn.fieldError[1] + drawn.fieldError[3]) +
                32 -
                24,
              `${width} ${theme} actions under the invalid option`,
              issues,
            );
          },
        ],
        [
          unavailableResponse,
          (survey) => {
            // The notice is 24px under the segments and 32px above the
            // actions, at the board's size.
            canvasIssues(
              [
                survey.result[0],
                survey.result[1] - (survey.segmented[1] + survey.segmented[3]),
                survey.result[2],
                survey.result[3],
              ],
              [drawn.result[0], 24, drawn.result[2], drawn.result[3]],
              `${width} ${theme} server error`,
              issues,
            );
            canvasIssues(
              survey.actions[0][1] - (survey.result[1] + survey.result[3]),
              drawn.actions[0][1] - (drawn.result[1] + drawn.result[3]),
              `${width} ${theme} actions under the server error`,
              issues,
            );
          },
        ],
      ]) {
        const { context, page } = await openVerify({
          width,
          theme,
          share: width < 1024,
          survey: response,
        });
        try {
          await enterState(page, 'survey-errors');
          await page
            .locator('[data-survey-form] button[type="submit"]')
            .click();
          await page.getByText(response.body.error.message).waitFor();
          const actual = await measure(page);
          check(actual.survey);
          // The questions stay, with the answers given.
          assert.equal(
            await page.locator('input[value="ai"]').isChecked(),
            true,
          );
          // An error is in the error colour and carries the alert icon.
          const style = await page.evaluate(() => {
            const result = globalThis.document.querySelector(
              '[data-survey-result]',
            );
            const icon = [...result.querySelectorAll('svg')].find(
              (svg) => globalThis.getComputedStyle(svg).display !== 'none',
            );
            return {
              icon: icon?.getAttribute('class'),
              iconColour: icon && globalThis.getComputedStyle(icon).color,
            };
          });
          assert.match(style.icon, /icon--alert-circle/u);
        } finally {
          await context.close();
        }
      }
    }
  assert.deepEqual(issues, []);
});

test('the flag-off matrix: referral off has no referral card or meter, survey off no survey, both off neither, each as drawn', async () => {
  const issues = [];
  try {
    for (const [state, referral, survey] of [
      ['referral-off', false, true],
      ['survey-off', true, false],
      ['both-off', false, false],
    ]) {
      await fixture.setFlag('referral.enabled', referral);
      await fixture.setFlag('survey.enabled', survey);
      await restartApp();
      const html = await successHtml(fixture.subscribers.main.token);
      assert.equal(/data-referral-card/u.test(html), referral, `${state} card`);
      assert.equal(
        /data-referral-progress/u.test(html),
        referral,
        `${state} meter`,
      );
      assert.equal(/data-meter-track/u.test(html), referral, `${state} track`);
      assert.equal(
        /<form[^>]*data-survey-form/u.test(html),
        survey,
        `${state} survey`,
      );
      assert.match(html, /data-access-wave/u);
      assert.match(html, /\/me\?t=/u);
      assert.equal(
        html.includes(verificationCopy.completeNext),
        referral,
        `${state} line`,
      );
      for (const width of verifyWidths)
        for (const theme of designThemes) {
          const { context, page } = await openVerify({
            width,
            theme,
            share: width < 1024,
          });
          try {
            const actual = await measure(page);
            canvasIssues(
              actual,
              canvasFor(width, state, actual),
              `${width} ${theme} ${state}`,
              issues,
            );
          } finally {
            await context.close();
          }
        }
    }
  } finally {
    await fixture.setFlag('referral.enabled', true);
    await fixture.setFlag('survey.enabled', true);
    await restartApp();
  }
  assert.deepEqual(issues, []);
});

// The figures a page shows, read from it.
function shownFigures(page) {
  return page.evaluate(() => {
    const { document } = globalThis;
    const progress = document.querySelector('[data-referral-progress]');
    return {
      meter: document.querySelector('[data-meter-text]').textContent.trim(),
      value: progress.getAttribute('value'),
      max: progress.getAttribute('max'),
      segments: document.querySelectorAll('.verification-meter__segment')
        .length,
      filled: document.querySelectorAll(
        '.verification-meter__segment.is-filled',
      ).length,
      wave: document.querySelector('[data-access-wave]').textContent.trim(),
      bars: document.querySelectorAll('.verification-wave__bars i').length,
      barsOn: document.querySelectorAll('.verification-wave__bars i.is-on')
        .length,
      unlocks: document
        .querySelector('.verification-unlocks .verification-label')
        .textContent.trim(),
      pills: [
        ...document.querySelectorAll('.verification-unlocks__list .pill'),
      ].map((pill) => pill.textContent.replace(/\s+/gu, ' ').trim()),
    };
  });
}

// What the page must show for a status, from the shared presentation and
// the configured ladder.
function expectedFigures(confirmedReferrals, accessWindow) {
  const figures = verificationReferralFigures({
    accessWindow,
    confirmedReferrals,
    giveawayEntries: 0,
    ownRank: null,
    referralLink: 'https://valstara.com/?ref=X',
    rewards: [],
    subscriberStatus: 'verified',
    tier: 0,
  });
  const ladder = figures.ladder;
  return {
    meter: verificationCopy.referral.progress(
      ladder.progress,
      ladder.threshold,
      ladder.tier,
    ),
    value: String(ladder.progress),
    max: String(ladder.threshold),
    segments: ladder.threshold,
    filled: ladder.progress,
    wave: verificationCopy.referral.wave(accessWindow),
    bars: accessWindows.length,
    barsOn: accessWindows.indexOf(accessWindow) + 1,
    unlocks: verificationCopy.referral.unlocks(ladder.tier),
    pills: [
      verificationCopy.referral.waveReward,
      verificationCopy.referral.reward(ladder.discountPercent),
    ],
  };
}

test('every figure comes from ReferralService.status and the ladder: count, threshold, tier, discount, wave and the meter', async () => {
  const { subscriberId, token } = fixture.subscribers.figures;
  await successHtml(token);
  const enabled = milestoneTiers.filter((tier) => tier.enabled);
  const lastThreshold = enabled.at(-1).threshold;
  for (const [confirmed, wave] of [
    [0, 'wave-1'],
    [2, 'wave-3'],
    [lastThreshold, 'wave-4'],
    [lastThreshold + 2, 'wave-2'],
  ]) {
    await fixture.database.query(
      'UPDATE subscriber SET confirmed_referrals=$2, access_window=$3 WHERE id=$1',
      [subscriberId, confirmed, wave],
    );
    const { context, page } = await openVerify({ token });
    try {
      assert.deepEqual(
        await shownFigures(page),
        expectedFigures(confirmed, wave),
        `${confirmed} confirmed in ${wave}`,
      );
    } finally {
      await context.close();
    }
  }
});

test('the meter text is exact in every captured frame of the entrance, while the meter fills from 0', async () => {
  const { subscriberId, token } = fixture.subscribers.figures;
  // Verified first, so the status set below is the one the page renders,
  // whichever test ran before this one.
  await successHtml(token);
  await fixture.database.query(
    "UPDATE subscriber SET confirmed_referrals=2, access_window='wave-2' WHERE id=$1",
    [subscriberId],
  );
  const expected = expectedFigures(2, 'wave-2');
  for (const width of [1440, 390]) {
    const { context, page } = await openVerify({
      token,
      width,
      motion: true,
      frozen: true,
    });
    try {
      const frames = [];
      for (const at of [0, 120, 240, 360, 480, 600]) {
        frames.push(
          await page.evaluate((time) => {
            const { document, getComputedStyle } = globalThis;
            for (const animation of document.getAnimations()) {
              if (!(animation.timeline instanceof globalThis.DocumentTimeline))
                continue;
              animation.pause();
              animation.currentTime = time;
            }
            const fills = [
              ...document.querySelectorAll('.verification-meter__fill'),
            ].map(
              (fill) =>
                new globalThis.DOMMatrixReadOnly(
                  getComputedStyle(fill).transform,
                ).a,
            );
            return {
              time,
              meter: document
                .querySelector('[data-meter-text]')
                .textContent.trim(),
              value: document
                .querySelector('[data-referral-progress]')
                .getAttribute('value'),
              wave: document
                .querySelector('[data-access-wave]')
                .textContent.trim(),
              fills,
            };
          }, at),
        );
      }
      for (const frame of frames) {
        assert.equal(frame.meter, expected.meter, `meter at ${frame.time}ms`);
        assert.equal(frame.value, expected.value, `value at ${frame.time}ms`);
        assert.equal(frame.wave, expected.wave, `wave at ${frame.time}ms`);
        assert.equal(frame.fills.length, 2);
      }
      // The fill grows from nothing to whole, and is whole by the end.
      assert.ok(
        frames[0].fills.every((scale) => scale < 0.05),
        `start ${frames[0].fills}`,
      );
      assert.ok(
        frames.at(-1).fills.every((scale) => scale === 1),
        `end ${frames.at(-1).fills}`,
      );
      const middle = frames[3].fills;
      assert.ok(
        middle.every((scale) => scale > 0 && scale < 1),
        `middle ${middle}`,
      );
    } finally {
      await context.close();
    }
  }
});

test('the share button renders only where navigator.share exists, at any width, and shares the link with nothing off-origin', async () => {
  for (const width of [1440, 768, 390]) {
    const without = await openVerify({ width });
    try {
      assert.equal(
        await without.page.locator('.verification-native-share').count(),
        0,
      );
      assert.equal(
        await without.page.locator('[data-share-host] .button').count(),
        0,
      );
    } finally {
      await without.context.close();
    }
    const withShare = await openVerify({ width, share: true });
    const hosts = [];
    withShare.page.on('request', (request) =>
      hosts.push(new URL(request.url()).host),
    );
    try {
      const button = withShare.page.locator('.verification-native-share');
      assert.equal(await button.count(), 1);
      assert.equal(
        await button.textContent().then((text) => text.trim()),
        verificationCopy.referral.share,
      );
      assert.equal(await button.getAttribute('type'), 'button');
      await button.click();
      const [shared] = await withShare.page.evaluate(() => globalThis.shared);
      const link = await withShare.page
        .locator('[data-referral-link]')
        .getAttribute('data-referral-url');
      assert.equal(shared.url, link);
      assert.equal(shared.title, verificationCopy.referral.label);
      assert.match(shared.url, /^https:\/\/valstara\.com\/\?ref=[A-Z0-9]+$/u);
      assert.ok(
        hosts.every((host) => host === new URL(origin).host),
        hosts.join(' '),
      );
    } finally {
      await withShare.context.close();
    }
  }
});

test('the link box shows the whole link, wrapping and never truncated, and copy failure selects it', async () => {
  for (const width of [1440, 390, 320]) {
    const { context, page } = await openVerify({ width });
    try {
      const link = page.locator('[data-referral-link]');
      const url = await link.getAttribute('data-referral-url');
      assert.equal((await link.textContent()).trim(), url);
      const fits = await link.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          globalThis.getComputedStyle(element).textOverflow !== 'ellipsis',
      );
      assert.ok(fits, `the link fits at ${width}`);
      await page.locator('[data-copy-referral]').click();
      await page.getByText(verificationCopy.referral.copyFailed).waitFor();
      assert.equal(
        await page.evaluate(() =>
          globalThis.getSelection().toString().replace(/\s+/gu, ''),
        ),
        url,
      );
      assert.equal(await link.getAttribute('data-selected'), 'true');
      const style = await link.evaluate(
        (element) => globalThis.getComputedStyle(element).boxShadow,
      );
      assert.match(style, /inset/u);
    } finally {
      await context.close();
    }
  }
});

test('Copy link cross-fades its label to "Link copied." over --duration-fast, announces it, and returns after the --copy-confirm-hold', async () => {
  // The injected clock: the page's timer for the hold is held, and fired
  // by the test once it has read the copied state.
  const holdTimers = () => {
    globalThis.heldTimers = [];
    const original = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...rest) => {
      if (delay === 2000) {
        globalThis.heldTimers.push(callback);
        return -1;
      }
      return original(callback, delay, ...rest);
    };
  };
  for (const motion of [true, false]) {
    const { context, page } = await openVerify({
      motion,
      clipboard: 'ok',
      init: holdTimers,
    });
    try {
      const button = page.locator('[data-copy-referral]');
      const before = await button.boundingBox();
      const faces = () =>
        page.evaluate(() =>
          [
            ...globalThis.document.querySelectorAll('.verification-copy__face'),
          ].map((face) => {
            const style = globalThis.getComputedStyle(face);
            return {
              text: face.textContent.trim(),
              opacity: style.opacity,
              hidden: face.getAttribute('aria-hidden'),
              transition: `${style.transitionProperty} ${style.transitionDuration}`,
            };
          }),
        );
      const resting = await faces();
      assert.deepEqual(
        resting.map(({ text, opacity, hidden }) => [text, opacity, hidden]),
        [
          [verificationCopy.referral.copy, '1', null],
          [verificationCopy.referral.copied, '0', 'true'],
        ],
      );
      for (const face of resting)
        assert.match(face.transition, motion ? /^opacity 0\.15s$/u : /^none /u);
      await button.click();
      await page
        .locator('[data-copy-referral][data-copy-state="copied"]')
        .waitFor();
      assert.deepEqual(await page.evaluate(() => globalThis.copied), [
        await page
          .locator('[data-referral-link]')
          .getAttribute('data-referral-url'),
      ]);
      await page.waitForFunction(() =>
        [
          ...globalThis.document.querySelectorAll('.verification-copy__face'),
        ].every((face) => face.getAnimations().length === 0),
      );
      assert.deepEqual(
        (await faces()).map(({ opacity }) => opacity),
        ['0', '1'],
      );
      assert.equal(
        await page.locator('[data-copy-status]').textContent(),
        verificationCopy.referral.copied,
      );
      // Announced, not shown: "Link copied." appears once on screen.
      assert.equal(
        await page
          .locator('[data-copy-result]')
          .evaluate((element) => globalThis.getComputedStyle(element).clipPath),
        'inset(50%)',
      );
      // The accessible name stays the action.
      assert.equal(
        await page
          .getByRole('button', { name: verificationCopy.referral.copy })
          .count(),
        1,
      );
      assert.deepEqual(await button.boundingBox(), before);
      // The hold is the token's 2s, and when it ends the label returns.
      assert.equal(
        await page.evaluate(() =>
          globalThis
            .getComputedStyle(globalThis.document.documentElement)
            .getPropertyValue('--copy-confirm-hold')
            .trim(),
        ),
        '2s',
      );
      assert.equal(await page.evaluate(() => globalThis.heldTimers.length), 1);
      await page.evaluate(() => globalThis.heldTimers.shift()());
      await page.waitForFunction(() =>
        [
          ...globalThis.document.querySelectorAll('.verification-copy__face'),
        ].every((face) => face.getAnimations().length === 0),
      );
      assert.deepEqual(
        (await faces()).map(({ opacity }) => opacity),
        ['1', '0'],
      );
      assert.equal(await page.locator('[data-copy-status]').textContent(), '');
    } finally {
      await context.close();
    }
  }
});

test('skip is not visually demoted: Save and Skip compute the same styles at rest, on hover, and through the result cross-fade', async () => {
  const buttonStyles = (page) =>
    page.evaluate(() =>
      [
        ...globalThis.document.querySelectorAll(
          '.verification-survey-actions .button',
        ),
      ].map((button) => {
        const style = globalThis.getComputedStyle(button);
        let opacity = 1;
        for (let node = button; node !== null; node = node.parentElement)
          opacity *= Number(globalThis.getComputedStyle(node).opacity);
        return {
          background: style.backgroundColor,
          border: style.borderColor,
          colour: style.color,
          font: `${style.fontSize}/${style.lineHeight} ${style.fontWeight} ${style.fontFamily}`,
          shadow: style.boxShadow,
          radius: style.borderTopLeftRadius,
          height: button.getBoundingClientRect().height,
          padding: style.paddingInline,
          opacity,
        };
      }),
    );
  for (const width of [1440, 390]) {
    for (const theme of designThemes) {
      const { context, page } = await openVerify({
        width,
        theme,
        motion: true,
        survey: skippedResponse,
      });
      try {
        await page
          .locator('.verification-survey-card')
          .evaluate((card) =>
            card.scrollIntoView({ block: 'center', behavior: 'instant' }),
          );
        await page.waitForFunction(
          () =>
            globalThis.getComputedStyle(
              globalThis.document.querySelector('.verification-survey-card'),
            ).opacity === '1',
        );
        const [save, skip] = await buttonStyles(page);
        assert.deepEqual(skip, save, `${width} ${theme} at rest`);
        const buttons = page.locator('.verification-survey-actions .button');
        const hovered = [];
        for (const index of [0, 1]) {
          await buttons.nth(index).hover();
          await page.waitForTimeout(400);
          hovered.push((await buttonStyles(page))[index]);
        }
        assert.deepEqual(hovered[1], hovered[0], `${width} ${theme} on hover`);
        await page.mouse.move(0, 0);
        // Let the last hover's transitions end before the fade starts.
        await page.waitForFunction(() =>
          globalThis.document
            .getAnimations()
            .every(
              (animation) => !(animation instanceof globalThis.CSSTransition),
            ),
        );
        // Mid-fade: as the questions start to leave, every transition is
        // held at its middle and both buttons are read there.
        await page.evaluate(() => {
          const form = globalThis.document.querySelector('[data-survey-form]');
          const observer = new globalThis.MutationObserver(() => {
            if (form.dataset.surveyState !== 'leaving') return;
            observer.disconnect();
            const transitions = globalThis.document
              .getAnimations()
              .filter(
                (animation) => animation instanceof globalThis.CSSTransition,
              );
            for (const transition of transitions) {
              transition.pause();
              transition.currentTime =
                transition.effect.getComputedTiming().endTime / 2;
            }
            globalThis.midFade = {
              transitions: transitions.length,
              buttons: [
                ...globalThis.document.querySelectorAll(
                  '.verification-survey-actions .button',
                ),
              ].map((button) => {
                const style = globalThis.getComputedStyle(button);
                let opacity = 1;
                for (
                  let node = button;
                  node !== null;
                  node = node.parentElement
                )
                  opacity *= Number(globalThis.getComputedStyle(node).opacity);
                return {
                  background: style.backgroundColor,
                  colour: style.color,
                  font: `${style.fontSize}/${style.lineHeight} ${style.fontWeight}`,
                  shadow: style.boxShadow,
                  height: button.getBoundingClientRect().height,
                  opacity,
                };
              }),
            };
            for (const transition of transitions) transition.play();
          });
          observer.observe(form, {
            attributes: true,
            attributeFilter: ['data-survey-state'],
          });
        });
        // A programmatic click, so the pointer's own hover and press do not
        // touch Skip alone.
        await page
          .locator('[data-survey-skip]')
          .evaluate((skip) => skip.click());
        await page.getByText(surveyCopy.skipped).waitFor();
        const midFade = await page.evaluate(() => globalThis.midFade);
        assert.ok(midFade.transitions > 0);
        const [midSave, midSkip] = midFade.buttons;
        assert.ok(
          midSave.opacity > 0 && midSave.opacity < 1,
          `mid-fade opacity ${midSave.opacity}`,
        );
        assert.deepEqual(midSkip, midSave, `${width} ${theme} mid-fade`);
      } finally {
        await context.close();
      }
    }
  }
});

test('saving or skipping cross-fades the questions out over --duration-fast and the result in over --duration-base, once, without a page load', async () => {
  for (const [response, text, icon] of [
    [savedResponse, surveyCopy.saved, 'check-circle'],
    [skippedResponse, surveyCopy.skipped, 'check'],
  ])
    for (const motion of [true, false]) {
      const { context, page } = await openVerify({ motion, survey: response });
      const navigations = [];
      page.on('framenavigated', (frame) => navigations.push(frame.url()));
      try {
        await page.evaluate(() => {
          globalThis.surveyMotion = [];
          const form = globalThis.document.querySelector('[data-survey-form]');
          new globalThis.MutationObserver(() => {
            globalThis.surveyMotion.push({
              state: form.dataset.surveyState,
              transitions: globalThis.document
                .getAnimations()
                .filter(
                  (animation) => animation instanceof globalThis.CSSTransition,
                )
                .map((animation) => ({
                  target: animation.effect.target.className,
                  property: animation.transitionProperty,
                  duration: animation.effect.getComputedTiming().duration,
                })),
            });
          }).observe(form, {
            attributes: true,
            attributeFilter: ['data-survey-state'],
          });
        });
        await page
          .locator(
            response === savedResponse
              ? 'input[value="ai"]'
              : 'input[value="weekly"]',
          )
          .check();
        await page
          .locator(
            response === savedResponse
              ? '[data-survey-form] button[type="submit"]'
              : '[data-survey-skip]',
          )
          .click();
        await page.getByText(text).waitFor();
        await page.waitForTimeout(400);
        const states = (await page.evaluate(() => globalThis.surveyMotion)).map(
          (entry) => entry.state,
        );
        assert.deepEqual(
          states.filter((state) => state !== ''),
          motion ? ['leaving', response.body.status] : [response.body.status],
        );
        // The questions are gone for good, and the result is the route's.
        assert.equal(
          await page.locator('[data-survey-fields]').first().isVisible(),
          false,
        );
        assert.equal(
          await page.locator('.verification-survey-actions').isVisible(),
          false,
        );
        assert.equal(
          await page.locator('[data-survey-status]').textContent(),
          text,
        );
        const shownIcon = await page.evaluate(() =>
          [...globalThis.document.querySelectorAll('[data-survey-result] svg')]
            .filter(
              (svg) => globalThis.getComputedStyle(svg).display !== 'none',
            )
            .map((svg) => svg.getAttribute('class')),
        );
        assert.equal(shownIcon.length, 1);
        assert.match(shownIcon[0], new RegExp(`icon--${icon}(?:\\s|$)`, 'u'));
        // Focus moves to the result, which is announced once.
        assert.equal(
          await page.evaluate(() =>
            globalThis.document.activeElement.hasAttribute(
              'data-survey-result',
            ),
          ),
          true,
        );
        assert.equal(
          await page.locator('[aria-live]').filter({ hasText: text }).count(),
          1,
        );
        assert.equal(navigations.length, 0);
        const resultMotion = await page.evaluate(() => {
          const style = globalThis.getComputedStyle(
            globalThis.document.querySelector('[data-survey-result]'),
          );
          const fields = globalThis.getComputedStyle(
            globalThis.document.querySelector('[data-survey-fields]'),
          );
          return [
            `${style.transitionProperty} ${style.transitionDuration}`,
            `${fields.transitionProperty} ${fields.transitionDuration}`,
          ];
        });
        assert.deepEqual(
          resultMotion,
          motion ? ['opacity 0.2s', 'opacity 0.15s'] : ['all 0s', 'none 0.15s'],
        );
        // Nothing time-based is left running (the cards' scroll-driven
        // reveals are on view timelines, which never finish).
        assert.equal(
          await page.evaluate(
            () =>
              globalThis.document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation.timeline instanceof globalThis.DocumentTimeline,
                ).length,
          ),
          0,
        );
      } finally {
        await context.close();
      }
    }
});

test('chips and segmented options take the canvas states: rest, hover, selected and keyboard focus, with --duration-fast transitions', async () => {
  for (const theme of designThemes) {
    for (const motion of [true, false]) {
      const { context, page } = await openVerify({ theme, motion });
      try {
        const tokens = await page.evaluate(() => {
          const probe = globalThis.document.createElement('div');
          globalThis.document.body.append(probe);
          const read = (property, value) => {
            probe.style[property] = value;
            return globalThis.getComputedStyle(probe)[property];
          };
          const values = {
            surface: read('backgroundColor', 'var(--surface)'),
            ink: read('backgroundColor', 'var(--ink)'),
            paper: read('color', 'var(--paper)'),
            ink600: read('color', 'var(--ink-600)'),
            inkText: read('color', 'var(--ink)'),
            wash: read('backgroundColor', 'var(--wash)'),
            coral: read('outlineColor', 'var(--coral)'),
            chipRest: read('boxShadow', 'var(--inset-line), var(--edge)'),
            chipHover: read('boxShadow', 'var(--inset-strong), var(--edge)'),
            segmentOn: read('boxShadow', 'var(--shadow-1), var(--edge)'),
          };
          probe.remove();
          return values;
        });
        const read = (selector) =>
          page.locator(selector).evaluate((element) => {
            const style = globalThis.getComputedStyle(element);
            return {
              background: style.backgroundColor,
              colour: style.color,
              shadow: style.boxShadow,
              weight: style.fontWeight,
              padding: style.paddingLeft,
              outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`,
              check: globalThis.getComputedStyle(element.querySelector('svg'))
                .display,
              transition: `${style.transitionProperty} ${style.transitionDuration}`,
            };
          });
        const chip = 'input[value="ai"] + .verification-chip';
        const segment = 'input[value="monthly"] + .verification-segment';
        const chipRest = await read(chip);
        assert.equal(chipRest.background, tokens.surface);
        assert.equal(chipRest.colour, tokens.inkText);
        assert.equal(chipRest.shadow, tokens.chipRest);
        assert.equal(chipRest.check, 'none');
        assert.match(
          chipRest.transition,
          motion ? /^background-color, box-shadow, color 0\.15s$/u : /^none /u,
        );
        // The native input lies over the chip and takes the pointer.
        await page.locator('input[value="ai"]').hover();
        await page.waitForTimeout(300);
        assert.equal((await read(chip)).shadow, tokens.chipHover);
        await page.locator('input[value="ai"]').check();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        const chipOn = await read(chip);
        assert.equal(chipOn.background, tokens.ink);
        assert.equal(chipOn.colour, tokens.paper);
        assert.equal(chipOn.weight, '600');
        assert.equal(chipOn.padding, '12px');
        assert.equal(chipOn.check, 'block');
        const segmentRest = await read(segment);
        assert.equal(segmentRest.colour, tokens.ink600);
        assert.equal(segmentRest.background, 'rgba(0, 0, 0, 0)');
        await page.locator('input[value="monthly"]').check();
        await page.waitForTimeout(300);
        const segmentOn = await read(segment);
        assert.equal(segmentOn.background, tokens.surface);
        assert.equal(segmentOn.colour, tokens.inkText);
        assert.equal(segmentOn.shadow, tokens.segmentOn);
        assert.equal(segmentOn.check, 'block');
        assert.equal(
          await page
            .locator('.verification-segments')
            .evaluate(
              (element) => globalThis.getComputedStyle(element).backgroundColor,
            ),
          tokens.wash,
        );
        // Keyboard focus draws the coral ring on the drawn shape: 2px off a
        // chip, flush on a segment inside its track.
        await page.locator('input[value="ai"]').focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        assert.equal(
          (await read(chip)).outline,
          `solid 2px ${tokens.coral} 2px`,
        );
        await page.locator('input[value="monthly"]').focus();
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowRight');
        assert.equal(
          (await read(segment)).outline,
          `solid 2px ${tokens.coral} 0px`,
        );
        // Single choice: arrows move the selection like any radio group.
        assert.equal(
          await page
            .locator('input[name="shopping_frequency"]:checked')
            .count(),
          1,
        );
        // Every chip and segment is a 44px target at small widths.
      } finally {
        await context.close();
      }
    }
  }
  const small = await openVerify({ width: 320 });
  try {
    const heights = await small.page.evaluate(() =>
      [
        ...globalThis.document.querySelectorAll(
          '.verification-chip, .verification-segment',
        ),
      ].map((element) => element.getBoundingClientRect().height),
    );
    assert.ok(
      heights.every((height) => height >= 44),
      heights.join(' '),
    );
  } finally {
    await small.context.close();
  }
});

test('the success entrance: tile and check, heading and line, wave badge, then the referral card, within 600ms; text and controls at full opacity from first paint', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openVerify({
      width,
      motion: true,
      frozen: true,
    });
    try {
      const entrance = await page.evaluate(() => {
        const { document, getComputedStyle } = globalThis;
        for (const animation of document.getAnimations()) {
          if (!(animation.timeline instanceof globalThis.DocumentTimeline))
            continue;
          animation.pause();
          animation.currentTime = 0;
        }
        const opacity = (element) => {
          let value = 1;
          for (let node = element; node !== null; node = node.parentElement)
            value *= Number(getComputedStyle(node).opacity);
          return value;
        };
        const entering = [...document.querySelectorAll('[data-enter]')].map(
          (element) => {
            const [animation] = element.getAnimations();
            return {
              what: element.matches('.verification-tile')
                ? 'tile'
                : element.matches('h1')
                  ? 'heading'
                  : element.matches('p')
                    ? 'line'
                    : element.matches('[data-access-wave]')
                      ? 'badge'
                      : element.matches('[data-referral-card]')
                        ? 'referral'
                        : element.tagName,
              kind: element.getAttribute('data-enter'),
              index: getComputedStyle(element)
                .getPropertyValue('--enter-index')
                .trim(),
              name: animation?.animationName,
              end: Math.round(animation.effect.getComputedTiming().endTime),
              opacity: opacity(element),
            };
          },
        );
        const check = document.querySelector('.verification-check path');
        const [draw] = check.getAnimations();
        const fills = document.querySelectorAll('.verification-meter__fill');
        return {
          entering,
          check: {
            name: draw.animationName,
            end: Math.round(draw.effect.getComputedTiming().endTime),
            pathLength: check.getAttribute('pathLength'),
            offset: getComputedStyle(check).strokeDashoffset,
            keyframes: draw.effect
              .getKeyframes()
              .map((keyframe) => keyframe.strokeDashoffset ?? null),
          },
          fillEnds: [...fills].map((fill) =>
            Math.round(
              fill.getAnimations()[0].effect.getComputedTiming().endTime,
            ),
          ),
          controls: [
            ...document.querySelectorAll(
              '.verification-hero a, .verification-hero button, [data-referral-card] a, [data-referral-card] button',
            ),
          ].map(opacity),
          text: [
            ...document.querySelectorAll(
              '.verification-hero h1, .verification-hero p, [data-access-wave], [data-referral-card] h2, [data-meter-text], .verification-linkbox',
            ),
          ].map(opacity),
          survey: document
            .querySelector('.verification-survey-card')
            .hasAttribute('data-reveal'),
          status: document
            .querySelector('.verification-status')
            .hasAttribute('data-reveal'),
        };
      });
      assert.deepEqual(
        entrance.entering.map(({ what, kind, index, name }) => [
          what,
          kind,
          index,
          name,
        ]),
        [
          ['tile', '', '0', 'motion-enter'],
          ['heading', 'shift', '1', 'motion-enter-shift'],
          ['line', 'shift', '1', 'motion-enter-shift'],
          ['badge', 'shift', '2', 'motion-enter-shift'],
          ['referral', 'shift', '3', 'motion-enter-shift'],
        ],
      );
      assert.ok(
        entrance.entering.every(({ end }) => end <= 600),
        JSON.stringify(entrance.entering),
      );
      assert.equal(Math.max(...entrance.entering.map(({ end }) => end)), 580);
      // Only the tile fades; everything readable or usable is opaque.
      assert.equal(entrance.entering[0].opacity, 0);
      assert.ok(
        entrance.entering.slice(1).every(({ opacity }) => opacity === 1),
      );
      assert.ok(
        entrance.controls.length > 0 &&
          entrance.controls.every((value) => value === 1),
      );
      assert.ok(entrance.text.every((value) => value === 1));
      // The check draws in, on its own path length, within the entrance.
      assert.equal(entrance.check.name, 'verification-check-draw');
      assert.equal(entrance.check.pathLength, '1');
      assert.equal(Number.parseFloat(entrance.check.offset), 1);
      assert.ok(entrance.check.end <= 600);
      // The meter fills with the referral card, by 580ms.
      assert.ok(entrance.fillEnds.every((end) => end === 580));
      assert.equal(entrance.survey, true);
      assert.equal(entrance.status, true);
    } finally {
      await context.close();
    }
  }
});

test('the survey and status card reveal on scroll and are at rest by 70% of the viewport height and at the page end, at every design width', async () => {
  for (const width of designWidths) {
    for (const theme of designThemes) {
      const { context, page } = await openVerify({
        width,
        theme,
        motion: true,
      });
      try {
        const issues = await page.evaluate(async () => {
          const { document, getComputedStyle } = globalThis;
          const frame = () =>
            new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
          const problems = [];
          const atRest = (element, where) => {
            const style = getComputedStyle(element);
            if (
              style.opacity !== '1' ||
              !['none', '0px', '0px 0px'].includes(style.translate)
            )
              problems.push(
                `${element.className} ${where}: ${style.opacity} ${style.translate}`,
              );
          };
          for (const element of document.querySelectorAll('[data-reveal]')) {
            const top =
              element.getBoundingClientRect().top + globalThis.scrollY;
            globalThis.scrollTo({
              top: Math.max(0, top - globalThis.innerHeight * 0.7),
              behavior: 'instant',
            });
            await frame();
            await frame();
            atRest(element, 'at 70%');
          }
          globalThis.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: 'instant',
          });
          await frame();
          await frame();
          for (const element of document.querySelectorAll('[data-reveal]'))
            atRest(element, 'at the end');
          return problems;
        });
        assert.deepEqual(issues, [], `${width} ${theme}`);
      } finally {
        await context.close();
      }
    }
  }
});

test('focus is never mid-motion: a keyboard walk through the success page during its entrance and reveals', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openVerify({
      width,
      motion: true,
      share: true,
      frozen: false,
    });
    try {
      const issues = [];
      for (let step = 0; step < 40; step += 1) {
        await page.keyboard.press('Tab');
        const found = await focusMotionIssues(page);
        const where = await page.evaluate(() =>
          globalThis.document.activeElement?.outerHTML.slice(0, 80),
        );
        issues.push(...found.map((issue) => `${width} ${where}: ${issue}`));
        if (
          await page.evaluate(
            () => globalThis.document.activeElement?.closest('footer') !== null,
          )
        )
          break;
      }
      assert.deepEqual(issues, []);
    } finally {
      await context.close();
    }
  }
});

test('under reduced motion nothing moves, and without scroll-driven animations or with animations off every element is at rest', async () => {
  const rest = (page) =>
    page.evaluate(() => {
      const { document, getComputedStyle } = globalThis;
      return [
        ...document.querySelectorAll(
          '[data-enter], [data-reveal], .verification-meter__fill, .verification-check path',
        ),
      ]
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            what:
              String(element.className.baseVal ?? element.className) ||
              element.tagName,
            opacity: style.opacity,
            translate: style.translate,
            transform: style.transform,
            dash: style.strokeDashoffset,
          };
        })
        .filter(
          ({ opacity, translate, transform, dash }) =>
            opacity !== '1' ||
            !['none', '0px', '0px 0px'].includes(translate) ||
            !['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(transform) ||
            !['0px', '0'].includes(dash),
        );
    });
  for (const width of [1440, 390]) {
    const reduced = await openVerify({ width });
    try {
      assert.equal(
        await reduced.page.evaluate(
          () => globalThis.document.getAnimations().length,
        ),
        0,
      );
      assert.deepEqual(await rest(reduced.page), []);
      assert.equal(
        await reduced.page.evaluate(() =>
          [...globalThis.document.querySelectorAll('*')].some(
            (element) =>
              globalThis.getComputedStyle(element).animationTimeline !== 'auto',
          ),
        ),
        false,
      );
    } finally {
      await reduced.context.close();
    }
    const unsupported = await openVerify({
      width,
      motion: true,
      supported: false,
    });
    try {
      assert.deepEqual(await rest(unsupported.page), []);
      assert.equal(
        await unsupported.page.evaluate(() =>
          globalThis.document
            .getAnimations()
            .some(
              (animation) =>
                !(animation.timeline instanceof globalThis.DocumentTimeline),
            ),
        ),
        false,
      );
    } finally {
      await unsupported.context.close();
    }
    const off = await openVerify({ width, motion: true, frozen: true });
    try {
      await off.page.addStyleTag({
        content: '*, *::before, *::after { animation: none !important; }',
      });
      assert.deepEqual(await rest(off.page), []);
    } finally {
      await off.context.close();
    }
  }
});

test('the invalid card asks for a new link in the card: the button waits for JavaScript, the route answers in place, and an error says so', async () => {
  // Without JavaScript the security check cannot run: the button is
  // disabled and the notice says why (founder decision 2026-11-10).
  const noScript = await openVerify({
    state: 'invalid',
    javaScriptEnabled: false,
  });
  try {
    assert.equal(
      await noScript.page.locator('[data-resend-submit]').isDisabled(),
      true,
    );
    // Read by selector: Playwright's text engine skips <noscript>.
    const notice = noScript.page.locator('noscript .verification-notice');
    assert.equal(await notice.isVisible(), true);
    assert.equal(
      (await notice.textContent()).trim(),
      verificationCopy.resend.javaScriptRequired,
    );
    assert.equal(
      await noScript.page
        .locator('form[data-resend-form]')
        .getAttribute('action'),
      '/api/resend-verification',
    );
    assert.equal(
      await noScript.page
        .locator('form[data-resend-form]')
        .getAttribute('method'),
      'post',
    );
  } finally {
    await noScript.context.close();
  }

  // With JavaScript the request posts the form's own fields to the
  // unchanged route and shows its message, the same for any address.
  const rendered = [];
  for (const address of ['known@example.test', 'unknown@example.test']) {
    const { context, page } = await openVerify({
      state: 'invalid',
      resend: acceptedResponse,
    });
    const posts = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/resend-verification')
        posts.push({
          method: request.method(),
          body: request.postData() ?? '',
        });
    });
    const navigations = [];
    page.on('framenavigated', (frame) => navigations.push(frame.url()));
    try {
      assert.equal(
        await page.locator('[data-resend-submit]').isDisabled(),
        false,
      );
      assert.equal(
        await page
          .getByText(verificationCopy.resend.javaScriptRequired)
          .isVisible(),
        false,
      );
      await page.locator('#resend-email').fill(address);
      await page.locator('[data-resend-submit]').click();
      await page.locator('[data-resend-result="success"]').waitFor();
      assert.equal(posts.length, 1);
      assert.equal(posts[0].method, 'POST');
      assert.ok(
        posts[0].body.includes(`name="email"\r\n\r\n${address}\r\n`),
        posts[0].body,
      );
      assert.equal(navigations.length, 0);
      assert.equal(
        await page.locator('[data-resend-status]').textContent(),
        resendVerificationCopy.accepted,
      );
      rendered.push(
        await page
          .locator('[data-resend-result]')
          .evaluate((element) => element.outerHTML),
      );
      assert.equal(
        await page.locator('[data-resend-submit]').isDisabled(),
        false,
      );
    } finally {
      await context.close();
    }
  }
  assert.equal(rendered[0], rendered[1]);

  // The real route, unmocked: with no security-check token it answers with
  // its challenge failure, which the card shows as an error notice.
  const { context, page } = await openVerify({ state: 'invalid' });
  try {
    await page.locator('#resend-email').fill('nobody@example.test');
    await page.locator('[data-resend-submit]').click();
    await page.locator('[data-resend-result="error"]').waitFor();
    assert.equal(
      await page.locator('[data-resend-status]').textContent(),
      resendVerificationCopy.challengeFailed,
    );
    const notice = await page
      .locator('[data-resend-result]')
      .evaluate((element) => ({
        shadow: globalThis.getComputedStyle(element).boxShadow,
        icon: [...element.querySelectorAll('svg')]
          .filter((svg) => globalThis.getComputedStyle(svg).display !== 'none')
          .map((svg) => svg.getAttribute('class')),
      }));
    assert.match(notice.shadow, /inset/u);
    assert.equal(notice.icon.length, 1);
    assert.match(notice.icon[0], /icon--alert-circle/u);
    // A failed request leaves the stated network message, never a vendor body.
    await page.route('**/api/resend-verification', (route) => route.abort());
    await page.locator('[data-resend-submit]').click();
    await page.waitForFunction(
      (message) =>
        globalThis.document.querySelector('[data-resend-status]')
          .textContent === message,
      resendVerificationCopy.unavailable,
    );
  } finally {
    await context.close();
  }
});

test('/verify stays in the enforced layout-check set, and every state passes the layout checks at every design width in both themes', async () => {
  assert.ok(enforcedPages.includes('/verify'));
  const issues = [];
  for (const width of designWidths)
    for (const theme of designThemes)
      for (const [state, options] of Object.entries(stateOptions)) {
        const { context, page } = await openVerify({
          ...options,
          width,
          theme,
          share: width < 1024,
        });
        try {
          await enterState(page, state);
          const found = await checkPageLayout(page);
          issues.push(
            ...found.map((issue) => `${state} ${width} ${theme}: ${issue}`),
          );
        } finally {
          await context.close();
        }
      }
  assert.deepEqual(issues, []);
});

async function axeViolations(page) {
  await entranceEnded(page);
  // Evaluated rather than added as a script tag, so it also runs where the
  // page itself has JavaScript disabled.
  await page.evaluate(axe.source);
  return page.evaluate(async () =>
    (
      await globalThis.axe.run(globalThis.document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
        },
      })
    ).violations.map((violation) => violation.id),
  );
}

test('every /verify state passes WCAG axe in both themes, at rest and once the motion is over', async () => {
  const issues = [];
  for (const width of [1440, 390])
    for (const theme of designThemes)
      for (const motion of [false, true])
        for (const [state, options] of Object.entries(stateOptions)) {
          // axe needs the page's own timers, which do not run with
          // JavaScript disabled. The no-JavaScript card is read on a page
          // with JavaScript, with its <noscript> content in place and the
          // button disabled, exactly as a browser without it parses them.
          const noScript = state === 'invalid-nojs';
          const { context, page } = await openVerify({
            ...options,
            javaScriptEnabled: true,
            width,
            theme,
            motion,
            share: width < 1024,
          });
          try {
            await enterState(page, state);
            if (noScript)
              await page.evaluate(() => {
                const { document } = globalThis;
                const element = document.querySelector('noscript');
                const parsed = document.createElement('template');
                parsed.innerHTML = element.textContent;
                element.replaceWith(parsed.content);
                document.querySelector('[data-resend-submit]').disabled = true;
              });
            if (motion) await page.waitForTimeout(400);
            const found = await axeViolations(page);
            issues.push(
              ...found.map(
                (id) =>
                  `${state} ${width} ${theme}${motion ? ' motion' : ''}: ${id}`,
              ),
            );
          } finally {
            await context.close();
          }
        }
  assert.deepEqual(issues, []);
});

test('the page loads nothing off-origin beyond the existing Turnstile script, sets no cookie and writes no storage', async () => {
  for (const state of ['success', 'invalid']) {
    const { context, page } = await openVerify({
      state,
      motion: true,
      share: true,
      clipboard: 'ok',
    });
    const hosts = new Set();
    page.on('request', (request) => hosts.add(new URL(request.url()).host));
    try {
      await page.reload();
      await page.evaluate(() => globalThis.document.fonts.ready);
      if (state === 'success') {
        await page.locator('[data-copy-referral]').click();
        await page.locator('.verification-native-share').click();
      }
      const allowed = new Set([
        new URL(origin).host,
        'challenges.cloudflare.com',
      ]);
      assert.deepEqual(
        [...hosts].filter((host) => !allowed.has(host)),
        [],
      );
      if (state === 'success')
        assert.equal(hosts.has('challenges.cloudflare.com'), false);
      assert.deepEqual(await context.cookies(), []);
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.localStorage.length + globalThis.sessionStorage.length,
        ),
        0,
      );
    } finally {
      await context.close();
    }
  }
});

test('the real save path stores the answers and the success page never shows another subscriber, with no survey after it is answered', async () => {
  const { token, subscriberId } = fixture.subscribers.saved;
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.abort(),
  );
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/verify?token=${encodeURIComponent(token)}`);
    await page.locator('.verification-confirm button').click();
    await page.locator('.verification-success').waitFor();
    await page.locator('input[value="game_keys"]').check();
    await page.locator('input[value="rarely"]').check();
    await page.locator('[data-survey-form] button[type="submit"]').click();
    await page.getByText(surveyCopy.saved).waitFor();
    const stored = await fixture.database.query(
      'SELECT answers FROM survey_response WHERE subscriber_id=$1',
      [subscriberId],
    );
    assert.deepEqual(stored.rows[0].answers, {
      category_preference: ['game_keys'],
      shopping_frequency: 'rarely',
    });
    const replay = await successHtml(token);
    assert.doesNotMatch(replay, /<form[^>]*data-survey-form/u);
    assert.doesNotMatch(replay, /verify-final-main@|verify-final-figures@/u);
  } finally {
    await context.close();
  }
});
