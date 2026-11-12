// E11.5-12 build item 1: the full contact sheet. Every public page and state,
// at every design width in both themes, at rest, plus every email preview,
// captured through E11.5-01's `captureContactSheet`. With `--record`, the
// motion review's screen recordings instead (build item 4).
//
//   node --import tsx scripts/design/full-contact-sheet.mjs
//   node --import tsx scripts/design/full-contact-sheet.mjs --record
//
// Self-contained: it builds the app, migrates and seeds its own uniquely named
// fixture database, starts the app and the pinned Playwright container, and
// removes all of them again. Every state is the real one: seeded data, real
// server responses (a POST's page is fetched from the app and served at its
// URL, as the final-design suites do), or the same in-browser route answers
// and Turnstile stand-in those suites use. The output is git-ignored and is
// never committed.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright';
import { Pool } from 'pg';

import { memberStatusCopy } from '../../src/copy/member-status.ts';
import { resendVerificationCopy } from '../../src/copy/resend-verification.ts';
import { signupCopy, signupFormCopy } from '../../src/copy/signup.ts';
import { surveyCopy } from '../../src/copy/survey.ts';
import { verificationCopy } from '../../src/copy/verification.ts';
import { leaderboardCopy } from '../../src/copy/leaderboard.ts';
import { createPool } from '../../src/server/db/pool.ts';
import { campaignFlagRegistry } from '../../src/server/flags/registry.ts';
import { flagCacheTtlMilliseconds } from '../../src/server/flags/service.ts';
import { deriveEmailToken } from '../../src/server/verification/token-derivation.ts';
import { seedGiveawayEntryRows } from '../../test/helpers/giveaway-entry-rows.ts';
import {
  publishedPort,
  startAppServer,
} from '../../test/helpers/listen-port.mjs';
import { ensureAppBuild } from '../ci/app-build.mjs';
import {
  captureContactSheet,
  writeContactSheetIndex,
} from './contact-sheet.mjs';
import {
  emailPreviewRenderers,
  renderEmailPreviews,
} from './email-previews.ts';
import { designThemes, designWidths, openRoute } from './layout-checks.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const execFileAsync = promisify(execFile);

export const outputDirectory = '.design-contact-sheets/e11-5-12';
export const recordingDirectory = '.design-contact-sheets/e11-5-12-recordings';
export const recordingWidths = Object.freeze([390, 1440]);

const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const adminDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
// The local-only values `npm test` gives every suite (package.json), so the
// app and the token derivation here see the same configuration.
const localEnvironment = Object.freeze({
  RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
  BREVO_WEBHOOK_TOKEN: 'local-only-brevo-webhook-token-32-chars',
  EMAIL_TOKEN_SECRET: 'local-only-email-token-secret-32-chars',
  EMAIL_BASE_URL: 'http://localhost:4321',
});

// ---------------------------------------------------------------------------
// The flags.
//
// The landing page reads four campaign flags (src/pages/index.astro), and
// each changes what it renders, independently of the others:
// - signup.enabled: the signup form card, or the paused panel in its place
//   (and, with it, the mobile sticky bar);
// - referral.enabled: the referral reward card, and the rewards footer row;
// - giveaway.open: the giveaway reward card, and the form's giveaway
//   microline and consent wording (SignupForm's giveawayEnabled);
// - leaderboard.public: the leaderboard link in the rewards footer, which
//   also keeps that row when referral is off.
// So the landing is captured in all sixteen combinations. The other three
// are not landing variants: survey.enabled is read only by /verify and /me,
// member.dashboard only by /me and its routes, and email.broadcast only by
// the server's email jobs. They are captured where they change a page.
export const landingFlags = Object.freeze([
  'signup.enabled',
  'referral.enabled',
  'giveaway.open',
  'leaderboard.public',
]);
export const flagAnalysis = Object.freeze({
  'signup.enabled':
    'landing variant: the form card or the paused panel (and no sticky bar)',
  'referral.enabled':
    'landing variant: the referral reward card and the rewards footer row; also /verify (referral card and meter)',
  'giveaway.open':
    'landing variant: the giveaway reward card, the form microline and consent wording; also /giveaway/award',
  'leaderboard.public':
    'landing variant: the leaderboard link in the rewards footer; also /leaderboard (paused)',
  'survey.enabled': 'not read by the landing; /verify and /me (the survey)',
  'member.dashboard':
    'not read by the landing; /me (the dashboard is unavailable)',
  'email.broadcast': 'not read by any page; server-side email jobs only',
});

const on = (value) => (value ? 'on' : 'off');

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

// ---------------------------------------------------------------------------
// Browser-side stand-ins, serialised into each page (from the suites).

// A Turnstile stand-in: `success` resolves at once (and with a fresh token on
// reset), `pending` never resolves, and `interactive` opens the widget at the size asked for,
// as Cloudflare does when it needs the visitor, and waits.
function installTurnstile(mode) {
  globalThis.turnstile = {
    render(element, options) {
      globalThis.testTurnstileOptions = options;
      if (mode === 'success') {
        globalThis.setTimeout(() => options.callback('sheet-token'), 0);
      } else if (mode === 'interactive') {
        globalThis.setTimeout(() => {
          options['before-interactive-callback']();
          const widget = globalThis.document.createElement('div');
          // Cloudflare's sizes: normal 300 × 65, compact 150 × 140.
          const compact = options.size === 'compact';
          widget.style.width = compact ? '150px' : '300px';
          widget.style.height = compact ? '140px' : '65px';
          element.append(widget);
        }, 0);
      }
      return 'sheet-widget';
    },
    reset() {
      if (mode === 'success')
        globalThis.setTimeout(
          () => globalThis.testTurnstileOptions.callback('sheet-token-fresh'),
          0,
        );
    },
  };
}

// The resend control appears after 60 seconds; the stand-in clock runs that
// one timer in 100ms so the after-60-seconds states can be reached.
function accelerateResend() {
  const original = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = (callback, delay, ...args) =>
    original(callback, delay === 60_000 ? 100 : delay, ...args);
}

// The boards draw Share link below 1024px, where navigator.share usually
// exists; the build shows it wherever navigator.share exists.
function shareBelow1024() {
  if (globalThis.innerWidth < 1024)
    globalThis.navigator.share = async () => undefined;
}
function shareEverywhere() {
  globalThis.navigator.share = async () => undefined;
}
function acceptingClipboard() {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: async () => undefined },
  });
}

// ---------------------------------------------------------------------------
// Route answers (the suites' in-browser answers).

const json = (status, body) => ({ status, body });
const signupAnswer = {
  pending: json(200, { status: 'pending', message: signupCopy.pending }),
  invalid: json(400, {
    error: { code: 'invalid_email', message: signupCopy.invalidEmail },
  }),
};
const resendAccepted = json(200, {
  status: 'pending',
  message: resendVerificationCopy.accepted,
});
const surveyAnswer = {
  saved: json(200, { message: surveyCopy.saved, status: 'saved' }),
  skipped: json(200, { message: surveyCopy.skipped, status: 'skipped' }),
  invalid: json(400, {
    error: { code: 'invalid_input', message: surveyCopy.invalidInput },
  }),
  unavailable: json(503, {
    error: { code: 'unavailable', message: surveyCopy.unavailable },
  }),
};
// The canvas's sample leaderboard (Leaderboard.dc.html renderVals).
const sampleHandles = [
  'k7Qx2LmP9aZb',
  'Rt4mW8qLzN2c',
  'p9VbX3kQe7Ls',
  'Hn2Zc8RtY5wd',
  'u6JqP4mXa9Ke',
  'D3sLw7NbQ2vy',
  'mF8xT2pRk6Ga',
  'Yq5Ve9LcH3nb',
  'b2KwR7sZm4Pt',
  'Zp4Rm81QwTxe',
];
const sampleCounts = [12, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const sampleAsOf = '2026-10-28T06:40:00.000Z';
const sampleNow = new Date('2026-10-28T06:43:00.000Z');
const snapshot = (count) =>
  json(200, {
    as_of: sampleAsOf,
    entries: sampleHandles.slice(0, count).map((handle, index) => ({
      confirmed_referrals: count === 3 ? [3, 2, 1][index] : sampleCounts[index],
      display_handle: handle,
      rank: index + 1,
    })),
  });

// ---------------------------------------------------------------------------
// Page drivers.

const waitFor = (selector) => async (page) => {
  await page.locator(selector).first().waitFor();
};

const typed = 'alex.morgan@example.com';

// The 17 signup states of E11.5-11g, reached as test/signup-states-rendered
// reaches them (its `states` and `reach`).
const signupStates = [
  ['01', 'idle', {}],
  ['02', 'focused', { focusOnly: 'alex.morgan@exa' }],
  ['03', 'inline-error-empty', { value: '', field: true }],
  [
    '04',
    'inline-error-invalid',
    { value: 'alex.morgan@example', answer: signupAnswer.invalid, field: true },
  ],
  [
    '05',
    'blocked-domain',
    {
      value: 'alex@throwaway.example',
      answer: json(400, {
        error: { code: 'blocked_domain', message: signupCopy.blockedDomain },
      }),
      field: true,
    },
  ],
  [
    '06',
    'security-check-in-progress',
    { turnstile: 'pending', label: signupFormCopy.challengePending },
  ],
  ['07', 'submitting', { answer: 'hold', label: signupFormCopy.submitting }],
  [
    '08',
    'security-check-visible',
    { turnstile: 'interactive', label: signupFormCopy.challengePending },
  ],
  [
    '09',
    'check-failed',
    {
      answer: json(400, {
        error: {
          code: 'challenge_failed',
          message: signupCopy.challengeFailed,
        },
      }),
      notice: true,
    },
  ],
  ['10', 'network-error', { answer: 'abort', notice: true }],
  [
    '11',
    'unavailable',
    {
      answer: json(503, {
        error: { code: 'unavailable', message: signupCopy.unavailable },
      }),
      notice: true,
    },
  ],
  [
    '12',
    'rate-limited',
    {
      answer: json(429, {
        error: { code: 'rate_limited', message: signupCopy.rateLimitedWait(5) },
      }),
      notice: true,
    },
  ],
  ['13', 'success-first-60-seconds', { success: true }],
  ['14', 'success-after-60-seconds', { success: true, resend: true }],
  ['15', 'success-re-sent', { success: true, resend: true, resent: true }],
  ['16', 'javascript-disabled', { javaScriptEnabled: false }],
  ['17', 'signups-paused', { paused: true }],
];

async function reachSignupState(page, state) {
  await page.evaluate(() =>
    globalThis.customElements.whenDefined('valstara-signup-form'),
  );
  if (state.focusOnly !== undefined) {
    await page.locator('#signup-email').focus();
    await page.keyboard.type(state.focusOnly);
    return;
  }
  if (
    state.value === undefined &&
    state.answer === undefined &&
    state.turnstile === undefined &&
    !state.success
  )
    return;
  await page.locator('#signup-email').fill(state.value ?? typed);
  await page.locator('[data-submit]').click();
  if (state.field) await page.waitForSelector('#signup-email-error:visible');
  else if (state.notice)
    await page.waitForSelector('[data-form-error]:visible');
  else if (state.label !== undefined) {
    await page.waitForFunction(
      (label) =>
        globalThis.document.querySelector('[data-submit-label]')
          ?.textContent === label,
      state.label,
    );
    if (state.turnstile === 'interactive')
      await page.waitForSelector('.signup-turnstile[data-open] > *');
  } else if (state.success) {
    await page.waitForSelector('[data-success]:visible');
    if (state.resend) await page.waitForSelector('[data-resend]:visible');
    if (state.resent) {
      await page.locator('[data-resend]').click();
      await page.waitForSelector('[data-resend-status]:visible');
    }
  }
}

// The mobile sticky bar (E11.5-11h, test/signup-sticky-bar-rendered): it
// exists below 48rem only, so its states are captured at the design widths
// below 768, over the viewport it is fixed to.
export const dockWidths = Object.freeze(
  designWidths.filter((width) => width < 768),
);
const barShown = () => {
  const bar = globalThis.document.querySelector('[data-dock]');
  return bar !== null && !bar.hidden;
};
async function revealBar(page) {
  await page.evaluate(() =>
    globalThis.customElements.whenDefined('valstara-signup-form'),
  );
  await page.evaluate(() => {
    const form = globalThis.document.querySelector('valstara-signup-form form');
    globalThis.scrollTo({
      top: form.getBoundingClientRect().bottom + globalThis.scrollY + 20,
      behavior: 'instant',
    });
  });
  await page.waitForFunction(barShown);
}
const dockStates = [
  ['entry', {}],
  ['focus-while-tabbing', { focus: true }],
  [
    'inline-error',
    {
      answer: signupAnswer.invalid,
      value: 'alex.morgan@example',
      wait: '[data-dock-error]:visible',
    },
  ],
  [
    'checking',
    {
      turnstile: 'pending',
      value: 'alex@example.com',
      label: signupFormCopy.challengePending,
    },
  ],
  [
    'submitting',
    {
      answer: 'hold',
      value: 'alex@example.com',
      label: signupFormCopy.submitting,
    },
  ],
  [
    'success',
    {
      answer: signupAnswer.pending,
      value: 'alex@example.com',
      wait: '[data-dock-confirmation]:visible',
    },
  ],
  ['footer-in-view-bar-hidden', { footer: true }],
  ['entry-giveaway-off', { giveaway: false }],
];
async function reachDockState(page, state) {
  await revealBar(page);
  if (state.focus) {
    // As frame 3 draws it: an FAQ item focused mid-screen, above the bar.
    await page
      .locator('#faq summary')
      .first()
      .evaluate((summary) => {
        summary.scrollIntoView({ block: 'center', behavior: 'instant' });
        summary.focus({ preventScroll: true });
      });
    await page.keyboard.press('Tab');
    await page.waitForFunction(barShown);
    return;
  }
  if (state.footer) {
    await page.evaluate(() =>
      globalThis.document
        .querySelector('body > footer')
        .scrollIntoView({ block: 'start', behavior: 'instant' }),
    );
    await page.waitForFunction(
      () => globalThis.document.querySelector('[data-dock]').hidden,
    );
    return;
  }
  if (state.value === undefined) return;
  await page.locator('#signup-dock-email').fill(state.value);
  await page.locator('[data-dock-submit]').click();
  if (state.label !== undefined)
    await page.waitForFunction(
      (label) =>
        globalThis.document.querySelector('[data-dock-submit-label]')
          ?.textContent === label,
      state.label,
    );
  else await page.waitForSelector(state.wait);
  await page.waitForFunction(barShown);
}

// ---------------------------------------------------------------------------
// The manifest.
//
// Each entry: `label` (unique, filename-safe), `kind` (its group), `covers`
// (the E11-05 inventory route it shows), `path` (what the browser opens; a
// function of the run's context where it needs a token), and how its state
// is reached: `flags` (overrides of the registry defaults), `document` (a
// real server response, fetched once and served at `path`), `answers`
// (in-browser route answers), `turnstile`, `init` scripts, `now` (the page
// clock), `run` (drives the page), `status`, `javaScriptEnabled`, `widths`
// and `fullPage`. `record` marks the one entry per route recorded for the
// motion review.

const mePath = (token) => `/me?t=${encodeURIComponent(token)}`;
const awardPath = (context, token = context.tokens.winnerStatus) =>
  `/giveaway/award?award=${context.awardId}&t=${encodeURIComponent(token)}`;
const exportPath = '/dsr?operation=export';
const deletePath = '/dsr?operation=delete';

async function textOf(response) {
  return { status: response.status, html: await response.text() };
}

// A POST, repeated until the server's own limit answers 429 (as the task
// suite reaches its rate-limited states).
async function untilLimited(context, path, fields, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await context.post(path, fields(attempt));
    if (response.status === 429) return textOf(response);
    await response.arrayBuffer();
  }
  throw new Error(`${path} never reached its rate limit.`);
}

function landingEntries() {
  const entries = [];
  for (const signup of [true, false])
    for (const referral of [true, false])
      for (const giveaway of [true, false])
        for (const leaderboard of [true, false])
          entries.push({
            label: `landing-signup-${on(signup)}-referral-${on(referral)}-giveaway-${on(giveaway)}-leaderboard-${on(leaderboard)}`,
            kind: 'landing-flag',
            covers: '/',
            path: '/',
            flags: {
              'signup.enabled': signup,
              'referral.enabled': referral,
              'giveaway.open': giveaway,
              'leaderboard.public': leaderboard,
            },
            turnstile: 'success',
            run: signup
              ? async (page) => {
                  await page.evaluate(() =>
                    globalThis.customElements.whenDefined(
                      'valstara-signup-form',
                    ),
                  );
                }
              : undefined,
            record: signup && referral && giveaway && leaderboard,
          });
  return entries;
}

function signupEntries() {
  return signupStates.map(([number, name, state]) => ({
    label: `signup-${number}-${name}`,
    kind: 'signup',
    covers: '/',
    path: '/',
    // The frames draw the giveaway open; state 17 is signups paused, as the
    // suite renders it.
    flags: state.paused
      ? { 'signup.enabled': false }
      : { 'giveaway.open': true },
    turnstile: state.turnstile ?? 'success',
    javaScriptEnabled: state.javaScriptEnabled,
    init: state.resend ? [accelerateResend] : [],
    answers: {
      '/api/signup': state.answer ?? signupAnswer.pending,
      '/api/resend-verification': resendAccepted,
    },
    run:
      state.paused || state.javaScriptEnabled === false
        ? undefined
        : (page) => reachSignupState(page, state),
  }));
}

function dockEntries() {
  return dockStates.map(([name, state]) => ({
    label: `signup-sticky-${name}`,
    kind: 'signup-sticky',
    covers: '/',
    path: '/',
    flags: { 'giveaway.open': state.giveaway ?? true },
    widths: dockWidths,
    fullPage: false,
    turnstile: state.turnstile ?? 'success',
    answers: state.answer === undefined ? {} : { '/api/signup': state.answer },
    run: (page) => reachDockState(page, state),
  }));
}

const verifySuccessDocument = async (context) =>
  textOf(await context.post('/verify', { token: context.tokens.verify }));

function verifyEntries() {
  const success = (label, extra = {}) => ({
    label,
    kind: 'verify',
    covers: '/verify',
    path: '/verify',
    document: verifySuccessDocument,
    init: [shareBelow1024, ...(extra.init ?? [])],
    ...extra,
  });
  const invalid = (label, extra = {}) => ({
    label,
    kind: 'verify',
    covers: '/verify',
    path: '/verify',
    ...extra,
  });
  return [
    {
      label: 'verify-confirm',
      kind: 'verify',
      covers: '/verify',
      path: (context) =>
        `/verify?token=${encodeURIComponent(context.tokens.verify)}`,
    },
    success('verify-success', { record: true }),
    success('verify-success-link-copied-survey-saved', {
      init: [acceptingClipboard],
      answers: { '/api/survey': surveyAnswer.saved },
      run: async (page) => {
        await page.locator('[data-copy-referral]').click();
        await page
          .locator('[data-copy-referral][data-copy-state="copied"]')
          .waitFor();
        await page.locator('input[value="ai"]').check();
        await page.locator('[data-survey-form] button[type="submit"]').click();
        await page.getByText(surveyCopy.saved).waitFor();
      },
    }),
    success('verify-success-copy-failed-survey-skipped', {
      answers: { '/api/survey': surveyAnswer.skipped },
      run: async (page) => {
        await page.locator('[data-copy-referral]').click();
        await page.getByText(verificationCopy.referral.copyFailed).waitFor();
        await page.locator('[data-survey-skip]').click();
        await page.getByText(surveyCopy.skipped).waitFor();
      },
    }),
    ...[
      ['verify-success-survey-answers-selected', null],
      ['verify-success-survey-invalid-option', surveyAnswer.invalid],
      ['verify-success-survey-server-error', surveyAnswer.unavailable],
    ].map(([label, answer]) =>
      success(label, {
        answers: answer === null ? {} : { '/api/survey': answer },
        run: async (page) => {
          for (const value of ['ai', 'software', 'game_keys'])
            await page.locator(`input[value="${value}"]`).check();
          await page.locator('input[value="monthly"]').check();
          if (answer === null) return;
          await page
            .locator('[data-survey-form] button[type="submit"]')
            .click();
          await page.getByText(answer.body.error.message).waitFor();
        },
      }),
    ),
    success('verify-success-referral-off', {
      flags: { 'referral.enabled': false },
    }),
    success('verify-success-survey-off', {
      flags: { 'survey.enabled': false },
    }),
    success('verify-success-referral-and-survey-off', {
      flags: { 'referral.enabled': false, 'survey.enabled': false },
    }),
    invalid('verify-invalid'),
    invalid('verify-invalid-new-link-sent', {
      answers: { '/api/resend-verification': resendAccepted },
      run: async (page) => {
        await page
          .locator('#resend-email')
          .fill('alexandra.konstantinidou@example.com');
        await page.locator('[data-resend-submit]').click();
        await page.locator('[data-resend-result="success"]').waitFor();
      },
    }),
    // The real route, unanswered: with no security-check token it answers
    // with its challenge failure.
    invalid('verify-invalid-new-link-check-failed', {
      run: async (page) => {
        await page.locator('#resend-email').fill('nobody@example.test');
        await page.locator('[data-resend-submit]').click();
        await page.locator('[data-resend-result="error"]').waitFor();
      },
    }),
    invalid('verify-invalid-new-link-network-error', {
      answers: { '/api/resend-verification': 'abort' },
      run: async (page) => {
        await page.locator('#resend-email').fill('nobody@example.test');
        await page.locator('[data-resend-submit]').click();
        await page.waitForFunction(
          (message) =>
            globalThis.document.querySelector('[data-resend-status]')
              ?.textContent === message,
          resendVerificationCopy.unavailable,
        );
      },
    }),
    invalid('verify-invalid-javascript-disabled', {
      javaScriptEnabled: false,
    }),
  ];
}

// The canvas's sample survey answers (Me.dc.html renderVals), as the member
// suite sets them on the states the board draws with them.
async function sampleAnswers(page) {
  await page.evaluate(() => {
    for (const value of ['ai', 'software', 'game_keys', 'monthly']) {
      const input = globalThis.document.querySelector(
        `[data-survey-form] input[value="${value}"]`,
      );
      if (input !== null) input.checked = true;
    }
  });
}

function memberEntries() {
  const me = (label, token, extra = {}) => ({
    label,
    kind: 'me',
    covers: '/me',
    path: (context) => mePath(context.tokens[token]),
    ...extra,
  });
  const dashboard = async (page) => {
    await waitFor('[data-member-dashboard]')(page);
    await sampleAnswers(page);
  };
  return [
    me('me-dashboard', 'main', {
      init: [shareBelow1024],
      run: dashboard,
      record: true,
    }),
    me('me-zero', 'zero', { init: [shareBelow1024], run: dashboard }),
    me('me-no-giveaway-entries', 'fresh', {
      init: [shareBelow1024],
      run: waitFor('[data-member-dashboard]'),
    }),
    {
      ...me('me-preferences-saved-survey-open', 'off', {
        init: [shareBelow1024],
      }),
      path: (context) => `${mePath(context.tokens.off)}#marketing-saved`,
      run: async (page) => {
        await waitFor('[data-marketing-result][data-result="success"]')(page);
        await page.locator('details.member-survey summary').click();
        await sampleAnswers(page);
      },
    },
    me('me-marketing-error', 'main', {
      answers: {
        '/api/me/marketing': json(503, {
          error: {
            code: 'unavailable',
            message: memberStatusCopy.marketing.unavailable,
          },
        }),
      },
      run: async (page) => {
        await waitFor('[data-member-dashboard]')(page);
        await page.locator('[data-marketing-switch]').click();
        await page
          .locator('[data-marketing-result][data-result="error"]')
          .waitFor();
      },
    }),
    me('me-copy-failed', 'main', {
      run: async (page) => {
        await waitFor('[data-member-dashboard]')(page);
        await page.locator('[data-copy-referral]').click();
        await page.locator('[data-copy-result="failed"]').waitFor();
      },
    }),
    me('me-share-available', 'main', {
      init: [shareEverywhere],
      run: waitFor('.member-native-share'),
    }),
    me('me-survey-off', 'main', {
      flags: { 'survey.enabled': false },
      init: [shareBelow1024],
      run: waitFor('[data-member-dashboard]'),
    }),
    me('me-recovery', 'expired', { run: waitFor('.member-task__card') }),
    me('me-recovery-javascript-disabled', 'expired', {
      javaScriptEnabled: false,
    }),
    me('me-recovery-sent', 'expired', {
      document: async (context) =>
        textOf(
          await context.post(mePath(context.tokens.expired), {
            turnstile_token: 'sheet-turnstile-token',
          }),
        ),
      run: waitFor('.member-task__card'),
    }),
    me('me-recovery-check-failed', 'expired', {
      status: 400,
      document: async (context) =>
        textOf(
          await context.post(mePath(context.tokens.expired), {
            turnstile_token: 'turnstile-reject',
          }),
        ),
      run: waitFor('.member-task__card'),
    }),
    me('me-left-waitlist', 'left', { run: waitFor('.member-task__card') }),
    me('me-dashboard-unavailable', 'main', {
      flags: { 'member.dashboard': false },
      run: waitFor('[data-member-state="disabled"]'),
    }),
  ];
}

function leaderboardEntries() {
  const board = (label, answer, ready, extra = {}) => ({
    label,
    kind: 'leaderboard',
    covers: '/leaderboard',
    path: '/leaderboard',
    now: sampleNow,
    answers: answer === undefined ? {} : { '/api/leaderboard': answer },
    run: waitFor(ready),
    ...extra,
  });
  return [
    board('leaderboard-ten-rows', snapshot(10), '.leaderboard-entry', {
      record: true,
    }),
    board('leaderboard-three-rows', snapshot(3), '.leaderboard-entry'),
    board(
      'leaderboard-empty',
      json(200, { as_of: sampleAsOf, entries: [] }),
      '[data-state="empty"]',
    ),
    board('leaderboard-loading', 'hold', '[data-state="loading"]'),
    board(
      'leaderboard-unavailable',
      json(500, { error: { code: 'internal', message: 'unavailable' } }),
      '[data-state="unavailable"]',
    ),
    board(
      'leaderboard-paused-poll',
      json(503, {
        error: { code: 'unavailable', message: leaderboardCopy.paused },
      }),
      '[data-leaderboard-paused]',
    ),
    board(
      'leaderboard-paused-flag-off',
      undefined,
      '[data-leaderboard-paused]',
      {
        flags: { 'leaderboard.public': false },
      },
    ),
  ];
}

function documentEntries(rulesRoutes) {
  const page = (route, kind) => ({
    label: `${kind === 'rules' ? 'rules' : 'page'}${route.replaceAll('/', '-').toLowerCase()}`,
    kind,
    covers: route,
    path: route,
    record: true,
  });
  return [
    ...[
      '/legit',
      '/guarantee',
      '/about',
      '/terms',
      '/privacy',
      '/privacy/storage',
    ].map((route) => page(route, 'document')),
    ...rulesRoutes.map((route) => page(route, 'rules')),
  ];
}

// The task pages, in the order the task suite reaches them: each POST's page
// is fetched from the app when its entry is captured, and the award's states
// follow its rows as they change.
function taskEntries() {
  const task = (label, covers, path, extra = {}) => ({
    label,
    kind: 'task',
    covers,
    path,
    ...extra,
  });
  const dsr = (label, path, fields, status, extra = {}) =>
    task(label, '/dsr', path, {
      status,
      document: async (context) =>
        textOf(
          await context.post(path.replace(/&state=.*$/u, ''), fields(context)),
        ),
      ...extra,
    });
  const unsubscribe = (label, status, document, extra = {}) =>
    task(
      label,
      '/unsubscribe',
      `/unsubscribe?state=${label.slice('unsubscribe-'.length)}`,
      {
        status,
        document,
        ...extra,
      },
    );
  const award = (label, extra = {}) =>
    task(label, '/giveaway/award', (context) => awardPath(context), {
      flags: { 'giveaway.open': true },
      ...extra,
    });
  const updateAward = (context, columns) =>
    context.database.query(`UPDATE giveaway_award SET ${columns} WHERE id=$1`, [
      context.awardId,
    ]);
  return [
    task('dsr-export-request', '/dsr', exportPath, { record: true }),
    task('dsr-delete-request', '/dsr', deletePath),
    task('dsr-export-confirm', '/dsr', `${exportPath}&t=emailed-link`),
    task('dsr-delete-confirm', '/dsr', `${deletePath}&t=emailed-link`),
    dsr(
      'dsr-export-accepted',
      `${exportPath}&state=accepted`,
      () => ({
        email: 'task-sheet-export@example.test',
        turnstile_token: 'ok',
      }),
      200,
    ),
    dsr(
      'dsr-export-check-failed',
      `${exportPath}&state=check-failed`,
      () => ({ email: 'task-sheet-export@example.test' }),
      400,
    ),
    dsr(
      'dsr-export-unavailable',
      `${exportPath}&state=unavailable`,
      () => ({
        email: 'task-sheet-export@example.test',
        turnstile_token: 'turnstile-down',
      }),
      503,
    ),
    dsr(
      'dsr-export-invalid-link',
      `${exportPath}&state=invalid`,
      () => ({ token: 'not-a-real-link' }),
      400,
    ),
    task('dsr-export-link-used', '/dsr', `${exportPath}&state=used`, {
      status: 200,
      // The emailed link downloads the export once; a second use is this.
      document: async (context) => {
        const download = await context.post(exportPath, {
          token: context.tokens.export,
        });
        await download.arrayBuffer();
        return textOf(
          await context.post(exportPath, { token: context.tokens.export }),
        );
      },
    }),
    dsr(
      'dsr-delete-pending',
      `${deletePath}&state=pending`,
      (context) => ({ token: context.tokens.delete }),
      200,
    ),
    task(
      'dsr-delete-rate-limited',
      '/dsr',
      `${deletePath}&state=rate-limited`,
      {
        status: 429,
        document: (context) =>
          untilLimited(
            context,
            deletePath,
            (attempt) => ({ token: `not-a-link-${attempt}` }),
            8,
          ),
      },
    ),
    task(
      'unsubscribe-confirm',
      '/unsubscribe',
      (context) =>
        `/unsubscribe?t=${encodeURIComponent(context.tokens.unsubscribe)}`,
      { record: true },
    ),
    task('unsubscribe-invalid-link', '/unsubscribe', '/unsubscribe'),
    unsubscribe('unsubscribe-invalid-post', 400, async (context) =>
      textOf(
        await context.post('/unsubscribe', {
          t: 'not-a-token',
          intent: 'message',
        }),
      ),
    ),
    // The suppression write fails, so the unsubscribe is unavailable.
    unsubscribe('unsubscribe-unavailable', 503, async (context) => {
      await context.database.query(
        "CREATE FUNCTION reject_suppression() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$",
      );
      await context.database.query(
        'CREATE TRIGGER reject_suppression BEFORE INSERT ON suppression FOR EACH ROW EXECUTE FUNCTION reject_suppression()',
      );
      try {
        return await textOf(
          await context.post('/unsubscribe', {
            t: context.tokens.unsubscribe,
            intent: 'message',
          }),
        );
      } finally {
        await context.database.query(
          'DROP TRIGGER reject_suppression ON suppression',
        );
        await context.database.query('DROP FUNCTION reject_suppression()');
      }
    }),
    unsubscribe('unsubscribe-complete', 200, async (context) =>
      textOf(
        await context.post('/unsubscribe', {
          t: context.tokens.unsubscribe,
          intent: 'message',
        }),
      ),
    ),
    unsubscribe('unsubscribe-rate-limited', 429, (context) =>
      untilLimited(
        context,
        '/unsubscribe',
        (attempt) => ({ t: `not-a-token-${attempt}`, intent: 'message' }),
        12,
      ),
    ),
    award('award-checks', {
      document: async (context) =>
        textOf(await context.get(awardPath(context))),
      record: true,
    }),
    award('award-checks-country-error', {
      path: (context) => `${awardPath(context)}&state=country-error`,
      document: async (context) =>
        textOf(
          await context.post(awardPath(context), {
            step: 'checks',
            country: '1X',
            age_confirmed: 'yes',
            skill_answer: '50',
            publicity_permission: 'yes',
            turnstile_token: 'ok',
          }),
        ),
    }),
    award('award-no-link-unavailable', { path: '/giveaway/award' }),
    award('award-exhausted', {
      path: (context) => `${awardPath(context)}&state=exhausted`,
      document: async (context) => {
        await updateAward(context, "state='exhausted'");
        return textOf(await context.get(awardPath(context)));
      },
    }),
    award('award-replaced', {
      path: (context) => awardPath(context, context.tokens.replacedStatus),
      document: async (context) =>
        textOf(
          await context.get(awardPath(context, context.tokens.replacedStatus)),
        ),
    }),
    award('award-substitution', {
      path: (context) => `${awardPath(context)}&state=substitution`,
      document: async (context) => {
        await updateAward(
          context,
          "state='confirmed', country_of_residence='DE', age_confirmed=true, sanctions_passed=true",
        );
        await context.database.query(
          "UPDATE giveaway_award SET substitution_state='offered', substitution_offered_at='2026-10-03T00:00:00Z', substitution_deadline_at='2099-01-01T00:00:00Z', substitution_offer=$2::jsonb WHERE id=$1",
          [context.awardId, JSON.stringify(substitutionOffer)],
        );
        return textOf(await context.get(awardPath(context)));
      },
    }),
    award('award-substitution-invalid', {
      path: (context) => `${awardPath(context)}&state=substitution-invalid`,
      document: async (context) =>
        textOf(
          await context.post(awardPath(context), {
            step: 'substitution',
            choice: 'replacement',
            turnstile_token: 'ok',
          }),
        ),
    }),
    award('award-confirmed', {
      path: (context) => `${awardPath(context)}&state=confirmed`,
      document: async (context) => {
        await updateAward(
          context,
          'substitution_state=\'cash\', substitution=\'{"choice":"cash"}\'::jsonb',
        );
        return textOf(await context.get(awardPath(context)));
      },
    }),
  ];
}

const substitutionOffer = {
  approvedBy: 'founder',
  unavailableProductIds: ['bundle-item'],
  cashEurCents: 5000,
  availableOriginalValueEurCents: 25000,
  statedBundleValueEurCents: 30000,
  replacements: [
    {
      id: 'replacement-one',
      name: 'Replacement one',
      retailValueEurCents: 5000,
    },
    {
      id: 'replacement-two',
      name: 'Replacement two',
      retailValueEurCents: 6000,
    },
  ],
};

function errorEntries() {
  return [
    {
      label: 'error-404-not-found',
      kind: 'error',
      covers: '/404',
      path: '/not-a-page',
      status: 404,
      record: true,
    },
    {
      // The prerendered 500 page, served at /500 as the layout checks open it.
      label: 'error-500-server-error',
      kind: 'error',
      covers: '/500',
      path: '/500',
      status: 500,
      record: true,
    },
  ];
}

/**
 * The full page manifest. `rulesRoutes` is every published rules revision's
 * URL plus /giveaway/rules (from the E11-05 inventory), so a new revision
 * joins the sheet without an edit here.
 */
export function buildManifest({ rulesRoutes }) {
  return [
    ...landingEntries(),
    ...signupEntries(),
    ...dockEntries(),
    ...verifyEntries(),
    ...memberEntries(),
    ...leaderboardEntries(),
    ...documentEntries(rulesRoutes),
    ...taskEntries(),
    ...errorEntries(),
  ];
}

/** One entry per registered email template, from the preview renderers. */
export function buildEmailManifest() {
  return [...emailPreviewRenderers('https://valstara.com').keys()].map(
    (template) => ({
      label: `email-${template.replaceAll('_', '-')}`,
      kind: 'email',
      template,
      path: `/${template}.html`,
    }),
  );
}

export function rulesRoutesOf(inventoryRoutes) {
  return inventoryRoutes.filter(
    (route) =>
      route === '/giveaway/rules' || route.startsWith('/giveaway/rules/'),
  );
}

/**
 * The inventory routes no entry covers, and the covered routes the inventory
 * does not have: both must be empty for a complete sheet.
 */
export function coverageGaps(manifest, inventoryRoutes) {
  const covered = new Set(manifest.map((entry) => entry.covers));
  return {
    uncovered: inventoryRoutes.filter((route) => !covered.has(route)),
    unknown: [...covered].filter((route) => !inventoryRoutes.includes(route)),
  };
}

/** The path an entry opens, given the run's context (tokens, award id). */
export function entryPath(entry, context) {
  return typeof entry.path === 'function' ? entry.path(context) : entry.path;
}

/** Stand-in values for the run's context, for checks with no database. */
export function placeholderContext() {
  const tokens = new Proxy(
    {},
    { get: (_target, key) => `placeholder-${String(key)}` },
  );
  return { tokens, awardId: '00000000-0000-4000-8000-000000000000' };
}

// ---------------------------------------------------------------------------
// The run.

async function createFixture() {
  const name = `valstara_contact_sheet_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(adminDatabaseUrl);
  const fixtureUrl = new URL(adminUrl);
  fixtureUrl.pathname = `/${name}`;
  const appUrl = new URL(fixtureUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  await admin.query(`CREATE DATABASE "${name}"`);
  const database = new Pool({ connectionString: fixtureUrl.toString() });
  const dispose = async () => {
    await database.end();
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await admin.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  };
  try {
    await execFileAsync(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'e11-5-12-contact-sheet'],
      {
        cwd: root,
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: fixtureUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    const seeded = await seed(database, fixtureUrl.toString());
    return { name, appUrl: appUrl.toString(), database, dispose, ...seeded };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function insertToken(database, subscriberId, purpose, expiresAt) {
  const id = randomUUID();
  const token = deriveEmailToken(id, process.env.EMAIL_TOKEN_SECRET);
  await database.query(
    'INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,$4,$5)',
    [
      id,
      subscriberId,
      createHash('sha256').update(token).digest(),
      purpose,
      expiresAt,
    ],
  );
  return { id, token };
}

// The suites' fixtures, in one database: a pending subscriber for /verify
// (E11.5-11q), the canvas's sample members for /me (E11.5-11r), and the task
// pages' subscribers, tokens and published draw (E11.5-11t).
async function seed(database, fixtureUrl) {
  const future = new Date('2099-01-01T00:00:00Z');
  const tokens = {};

  const verifyId = randomUUID();
  await database.query(
    "INSERT INTO subscriber (id,email,email_normalised,email_domain,status) VALUES ($1,$2,$2,'example.test','pending')",
    [verifyId, 'sheet-verify@example.test'],
  );
  tokens.verify = (
    await insertToken(database, verifyId, 'verify', future)
  ).token;

  const ids = {
    main: randomUUID(),
    zero: randomUUID(),
    fresh: randomUUID(),
    off: randomUUID(),
    left: randomUUID(),
    other: randomUUID(),
  };
  const verified = (id, label, code, referrals, wave, marketing) =>
    database.query(
      `INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,referral_code,confirmed_referrals,access_window,marketing_consent_at,marketing_consent_version,marketing_consent_source)
       VALUES ($1,$2,$2,'example.test','verified',$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        `sheet-member-${label}@example.test`,
        new Date('2026-10-02T10:00:00Z'),
        code,
        referrals,
        wave,
        marketing ? new Date('2026-10-02T10:05:00Z') : null,
        marketing ? 'v1' : null,
        marketing ? 'member_status' : null,
      ],
    );
  await verified(ids.main, 'main', 'K7QX2MPR9AZB', 4, 'wave-2', true);
  await verified(ids.zero, 'zero', 'ZERO23456789', 0, null, true);
  await verified(ids.fresh, 'fresh', 'FRESH2345678', 0, null, false);
  await verified(ids.off, 'off', 'OFFX23456789', 4, 'wave-2', false);
  await verified(ids.other, 'other', 'OTHER2345678', 9, 'wave-1', true);
  await database.query(
    "INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,unsubscribed_at,referral_code) VALUES ($1,$2,$2,'example.test','unsubscribed',$3,$3,'LEFT23456789')",
    [
      ids.left,
      'sheet-member-left@example.test',
      new Date('2026-10-02T12:00:00Z'),
    ],
  );
  for (const id of [ids.main, ids.off])
    await database.query(
      "INSERT INTO milestone_award (id,subscriber_id,tier,reward_kind,state,awarded_at) VALUES ($1,$3,1,'wave_upgrade','settled',CURRENT_TIMESTAMP),($2,$3,1,'discount','held',CURRENT_TIMESTAMP)",
      [randomUUID(), randomUUID(), id],
    );
  const pool = createPool(fixtureUrl);
  try {
    await seedGiveawayEntryRows(pool, ids.main, 5, { rulesVersion: '2026-09' });
    await seedGiveawayEntryRows(pool, ids.off, 5, { rulesVersion: '2026-09' });
    await seedGiveawayEntryRows(pool, ids.zero, 1, { rulesVersion: '2026-09' });
  } finally {
    await pool.close();
  }
  for (const label of ['main', 'zero', 'fresh', 'off', 'left', 'other'])
    tokens[label] = (
      await insertToken(database, ids[label], 'status', future)
    ).token;
  tokens.expired = (
    await insertToken(
      database,
      ids.main,
      'status',
      new Date('2000-01-01T00:00:00Z'),
    )
  ).token;

  const rulesVersion = 'VAL-GW-LAUNCH-20261009-r1';
  const task = {
    winner: randomUUID(),
    exporter: randomUUID(),
    eraser: randomUUID(),
    replaced: randomUUID(),
  };
  await database.query(
    "INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,referral_code,access_window) VALUES ($1,'task-sheet-winner@example.test','task-sheet-winner@example.test','example.test','verified','2026-10-01T00:00:00Z','TSWINNER2345','wave-1'),($2,'task-sheet-export@example.test','task-sheet-export@example.test','example.test','verified','2026-10-01T00:00:00Z','TSEXPORT2345','wave-1'),($3,'task-sheet-erase@example.test','task-sheet-erase@example.test','example.test','verified','2026-10-01T00:00:00Z','TSERASER2345','wave-1'),($4,'task-sheet-replaced@example.test','task-sheet-replaced@example.test','example.test','verified','2026-10-01T00:00:00Z','TSREPLACE234','wave-1')",
    [task.winner, task.exporter, task.eraser, task.replaced],
  );
  const unsubscribe = await insertToken(
    database,
    task.winner,
    'unsubscribe',
    future,
  );
  tokens.unsubscribe = unsubscribe.token;
  await database.query(
    "INSERT INTO email_send (id,subscriber_id,template,provider,business_key,state,unsubscribe_token_id) VALUES ($1,$2,'status_link','resend',$3,'sent',$4)",
    [randomUUID(), task.winner, randomUUID(), unsubscribe.id],
  );
  tokens.winnerStatus = (
    await insertToken(database, task.winner, 'status', future)
  ).token;
  tokens.replacedStatus = (
    await insertToken(database, task.replaced, 'status', future)
  ).token;
  tokens.export = (
    await insertToken(database, task.exporter, 'dsr_export', future)
  ).token;
  tokens.delete = (
    await insertToken(database, task.eraser, 'dsr_delete', future)
  ).token;

  const drawId = randomUUID();
  const entryId = randomUUID();
  const replacedEntry = randomUUID();
  await database.query(
    "INSERT INTO giveaway_draw (id,executed_by) VALUES ($1,'e11-5-12-contact-sheet')",
    [drawId],
  );
  for (const [entry, subscriber] of [
    [entryId, task.winner],
    [replacedEntry, task.replaced],
  ]) {
    await database.query(
      "INSERT INTO giveaway_entry (id,subscriber_id,method,entries,rules_version,rules_sha256) VALUES ($1,$2,'base',1,$3,decode($4,'hex'))",
      [entry, subscriber, rulesVersion, 'ab'.repeat(32)],
    );
    await database.query(
      "INSERT INTO giveaway_draw_snapshot_row (draw_id,entry_id,subscriber_id,method,rules_version,rules_sha256) VALUES ($1,$2,$3,'base',$4,decode($5,'hex'))",
      [drawId, entry, subscriber, rulesVersion, 'ab'.repeat(32)],
    );
  }
  await database.query(
    'INSERT INTO giveaway_draw_selection (draw_id,position,subscriber_id,entry_id,is_winner) VALUES ($1,1,$2,$3,true),($1,2,$4,$5,false)',
    [drawId, task.winner, entryId, task.replaced, replacedEntry],
  );
  await database.query(
    "UPDATE giveaway_draw SET snapshot_committed_at='2026-10-01T00:00:00Z', entry_snapshot_hash=decode($2,'hex'), snapshot_count=2, prize_count=1, rules_version=$3, rules_sha256=decode($4,'hex'), drand_chain_hash=decode($5,'hex'), drand_chain_info='{}'::jsonb, target_round=1, target_round_at='2026-10-01T00:06:00Z' WHERE id=$1",
    [drawId, 'cd'.repeat(32), rulesVersion, 'ab'.repeat(32), 'ef'.repeat(32)],
  );
  await database.query(
    "UPDATE giveaway_draw SET state='published', seed=$2, seed_generated_at='2026-10-01T00:01:00Z', beacon_round=1, beacon_randomness=decode($3,'hex'), beacon_signature=decode($4,'hex'), beacon_relay_used='test', beacon_verified_relays='[\"one\",\"two\"]'::jsonb, winners=$5::jsonb, reproduced_at='2026-10-01T00:02:00Z', published_at='2026-10-01T00:02:00Z' WHERE id=$1",
    [
      drawId,
      'ab'.repeat(32),
      '12'.repeat(32),
      '34'.repeat(48),
      JSON.stringify([task.winner]),
    ],
  );
  const awardId = randomUUID();
  await database.query(
    "INSERT INTO giveaway_award (id,draw_id,prize_slot,entry_snapshot_hash,selection_position,entry_id,subscriber_id,notified_at,response_deadline_at) VALUES ($1,$2,1,decode($3,'hex'),1,$4,$5,'2026-10-01T00:03:00Z','2099-01-01T00:00:00Z')",
    [awardId, drawId, 'cd'.repeat(32), entryId, task.winner],
  );
  await database.query(
    "INSERT INTO giveaway_award_candidate (draw_id,selection_position,award_id,subscriber_id,outcome,reason,checked_at) VALUES ($1,2,$2,$3,'replaced','deadline','2026-10-02T00:00:00Z')",
    [drawId, awardId, task.replaced],
  );
  return { tokens, awardId };
}

// Turnstile's siteverify, stubbed inside the app process as the task suite
// does: a missing token is Cloudflare's own missing-input-response, one token
// is rejected, one finds the provider down, and every other one passes. So
// no request leaves the machine.
const siteverifyStub = `data:text/javascript,${encodeURIComponent(`
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      const response = body.get('response') ?? '';
      if (response === '')
        return Response.json({ success: false, 'error-codes': ['missing-input-response'] });
      if (response.includes('turnstile-reject'))
        return Response.json({ success: false, 'error-codes': ['invalid-input-response'] });
      if (response.includes('turnstile-down'))
        return new Response('down', { status: 503 });
      return Response.json({ success: true });
    }
    return realFetch(input, init);
  };
`)}`;

async function startSink() {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.writeHead(200).end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

function startApp(fixture, alertPort) {
  return startAppServer({
    label: 'E11.5-12 contact sheet',
    readyPath: '/privacy',
    cwd: root,
    nodeArguments: ['--import', siteverifyStub],
    env: () => ({
      ...localEnvironment,
      ADMIN_CREDENTIAL: 'contact-sheet-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: fixture.appUrl,
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'contact-sheet-prefix-pepper',
      P1_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertPort}/alert`,
      P1_ALERT_WEBHOOK_TOKEN: 'contact-sheet-alert-token',
      REFERRAL_SIGNING_SECRET: 'contact-sheet-referral-secret',
      RESEND_API_KEY: 'contact-sheet-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'contact-sheet-turnstile-secret',
      WEEKLY_SEND_UTC: '2@09:00',
    }),
  });
}

async function startBrowserServer(container) {
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      container,
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
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const stop = async () => {
    await execFileAsync('docker', ['rm', '--force', container]).catch(
      () => undefined,
    );
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  };
  try {
    for (let attempt = 0; attempt < 720; attempt += 1) {
      if (output.includes('Listening on'))
        return {
          endpoint: `ws://127.0.0.1:${await publishedPort(container, 3000)}/`,
          stop,
        };
      if (child.exitCode !== null)
        throw new Error(`Playwright server exited.\n${output}`);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    throw new Error(`Playwright server did not start.\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

// The browser runs in a container, which reaches a server on the host only
// after a short delay: wait, bounded, until each origin answers there.
async function waitForBrowserReach(endpoint, url) {
  const browser = await chromium.connect(endpoint);
  try {
    const context = await browser.newContext();
    for (let attempt = 0; ; attempt += 1) {
      const ready = await context.request
        .get(url, { timeout: 2_000 })
        .then((response) => response.ok())
        .catch(() => false);
      if (ready) return;
      if (attempt >= 120)
        throw new Error(`The browser container cannot reach ${url}.`);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
  } finally {
    await browser.close();
  }
}

// Flags are applied as campaign_flag rows, then the app's flag cache is let
// expire, so the next page reads them.
function flagController(database) {
  let current = { ...campaignFlagRegistry };
  return async (overrides = {}) => {
    const desired = { ...campaignFlagRegistry, ...overrides };
    const changed = Object.keys(desired).filter(
      (key) => desired[key] !== current[key],
    );
    if (changed.length === 0) return;
    for (const key of changed)
      await database.query(
        "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ($1,$2,'e11-5-12-contact-sheet') ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled",
        [key, desired[key]],
      );
    current = desired;
    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, flagCacheTtlMilliseconds + 250),
    );
  };
}

// The browser-context half of an entry: Turnstile, init scripts, the clock,
// and one same-origin route that serves the entry's fetched document, its
// route answers, and everything else from the app. Every same-origin request
// goes through it: a document the route fulfils counts as public to
// Chromium's Private Network Access, which would otherwise block its
// stylesheets and fonts on this local host.
async function setUpContext(context, entry, origin, prepared) {
  const javaScript = entry.javaScriptEnabled !== false;
  if (entry.turnstile === undefined || !javaScript)
    await context.route('https://challenges.cloudflare.com/**', (route) =>
      route.abort().catch(() => undefined),
    );
  else {
    await context.route('https://challenges.cloudflare.com/**', (route) =>
      route
        .fulfill({ contentType: 'text/javascript', body: '' })
        .catch(() => undefined),
    );
    await context.addInitScript(installTurnstile, entry.turnstile);
  }
  for (const script of entry.init ?? []) await context.addInitScript(script);
  if (entry.now !== undefined) await context.clock.setFixedTime(entry.now);
  const documentUrl =
    prepared.document === undefined
      ? null
      : new URL(prepared.path, origin).href.replace(/#.*$/u, '');
  await context.route(`${origin}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      if (documentUrl !== null && url.href === documentUrl)
        return await route.fulfill({
          status: prepared.document.status,
          contentType: 'text/html; charset=utf-8',
          body: prepared.document.html,
        });
      const answer = entry.answers?.[url.pathname];
      if (answer === 'hold') return undefined;
      if (answer === 'abort') return await route.abort('internetdisconnected');
      if (answer !== undefined)
        return await route.fulfill({
          status: answer.status,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify(answer.body),
        });
      const response = await route.fetch();
      return await route.fulfill({ response });
    } catch {
      // The context closed while this request was in flight.
      return undefined;
    }
  });
}

// The prepared half: the entry's flags, then its document fetched from the
// app under those flags.
async function prepareEntry(entry, run) {
  await run.applyFlags(entry.flags);
  const path = entryPath(entry, run.context);
  const document = entry.document
    ? await entry.document(run.context)
    : undefined;
  if (document !== undefined && document.status !== (entry.status ?? 200))
    throw new Error(
      `${entry.label}: the server answered ${document.status}, expected ${entry.status ?? 200}.`,
    );
  return { path, document };
}

function requestContext(local, database, seeded) {
  return {
    database,
    tokens: seeded.tokens,
    awardId: seeded.awardId,
    get: (path) => globalThis.fetch(`${local}${path}`),
    post: (path, fields) =>
      globalThis.fetch(`${local}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: local,
        },
        body: new globalThis.URLSearchParams(fields),
      }),
  };
}

async function capturePages(manifest, run, endpoint, directory) {
  const captures = [];
  const failures = [];
  for (const [index, entry] of manifest.entries()) {
    const started = globalThis.performance.now();
    let prepared;
    try {
      const result = await captureContactSheet({
        origin: run.origin,
        output: directory,
        browserEndpoint: endpoint,
        entries: [
          {
            state: entry.label,
            route: entryPath(entry, run.context),
            status: entry.status,
            javaScriptEnabled: entry.javaScriptEnabled,
            widths: entry.widths,
            fullPage: entry.fullPage,
            prepare: async () => {
              prepared = await prepareEntry(entry, run);
            },
            setup: (context) =>
              setUpContext(context, entry, run.origin, prepared),
            run: entry.run,
          },
        ],
      });
      captures.push(
        ...result.map((capture) => ({
          ...capture,
          kind: entry.kind,
          covers: entry.covers,
        })),
      );
    } catch (error) {
      failures.push({
        label: entry.label,
        kind: entry.kind,
        error: String(error?.message ?? error).split('\n')[0],
      });
    }
    process.stdout.write(
      `[${index + 1}/${manifest.length}] ${entry.label} ${failures.at(-1)?.label === entry.label ? 'FAILED' : 'ok'} (${Math.round((globalThis.performance.now() - started) / 1000)}s)\n`,
    );
  }
  await writeContactSheetIndex(directory, captures);
  return { captures, failures };
}

// The email previews: rendered from fixture payloads, served from a static
// directory the browser container can reach, and captured the same way.
async function captureEmails(endpoint, directory, selected) {
  const htmlDirectory = join(directory, 'html');
  await mkdir(htmlDirectory, { recursive: true });
  const previews = await renderEmailPreviews('https://valstara.com');
  for (const { template, message } of previews) {
    if (message.html === undefined)
      throw new Error(`${template} has no HTML part.`);
    await writeFile(join(htmlDirectory, `${template}.html`), message.html);
  }
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://host').pathname.slice(1);
    if (!/^[a-z0-9_]+\.html$/u.test(name)) return response.writeHead(404).end();
    try {
      const body = await readFile(join(htmlDirectory, name));
      response
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const origin = `http://host.docker.internal:${server.address().port}`;
  const captures = [];
  const failures = [];
  try {
    const manifest = buildEmailManifest().filter(selected);
    if (manifest.length === 0) return { captures, failures };
    await waitForBrowserReach(endpoint, `${origin}${manifest[0].path}`);
    for (const entry of manifest) {
      try {
        const result = await captureContactSheet({
          origin,
          output: directory,
          browserEndpoint: endpoint,
          entries: [{ state: entry.label, route: entry.path }],
        });
        captures.push(
          ...result.map((capture) => ({ ...capture, kind: 'email' })),
        );
      } catch (error) {
        failures.push({
          label: entry.label,
          kind: 'email',
          error: String(error?.message ?? error).split('\n')[0],
        });
      }
      process.stdout.write(`email ${entry.label} done\n`);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  await writeContactSheetIndex(directory, captures);
  return { captures, failures };
}

// An email is not a site page: it has no site container grid, so that one
// rule does not apply to it. Every other layout rule does.
export const emailNotApplicable = Object.freeze(['missing design container']);

function summarise(pageResult, emailResult, wallSeconds) {
  const groups = {};
  for (const capture of [...pageResult.captures, ...emailResult.captures]) {
    groups[capture.kind] ??= { entries: new Set(), captures: 0 };
    groups[capture.kind].entries.add(capture.state);
    groups[capture.kind].captures += 1;
  }
  const layoutIssues = [];
  const notApplicable = [];
  for (const capture of [...pageResult.captures, ...emailResult.captures]) {
    const issues = capture.layoutIssues.filter(
      (issue) =>
        capture.kind !== 'email' || !emailNotApplicable.includes(issue),
    );
    const skipped = capture.layoutIssues.filter(
      (issue) => !issues.includes(issue),
    );
    if (skipped.length > 0)
      notApplicable.push({
        state: capture.state,
        width: capture.width,
        theme: capture.theme,
        issues: skipped,
      });
    if (issues.length > 0)
      layoutIssues.push({
        state: capture.state,
        kind: capture.kind,
        width: capture.width,
        theme: capture.theme,
        issues,
      });
  }
  return {
    ticket: 'E11.5-12',
    generatedAt: new Date().toISOString(),
    wallTimeSeconds: Math.round(wallSeconds),
    widths: designWidths,
    themes: designThemes,
    flagAnalysis,
    groups: Object.fromEntries(
      Object.entries(groups).map(([kind, { entries, captures }]) => [
        kind,
        { entries: entries.size, captures },
      ]),
    ),
    totalCaptures: pageResult.captures.length + emailResult.captures.length,
    failures: [...pageResult.failures, ...emailResult.failures],
    layoutIssues,
    emailRulesNotApplicable: {
      rules: emailNotApplicable,
      captures: notApplicable.length,
    },
  };
}

// The motion review (build item 4): every page, one representative state per
// inventory route, at 390 and 1440 px, with motion on and with reduced
// motion, scrolled top to bottom, recorded with Playwright's local video.
async function scrollThrough(page) {
  await page.waitForTimeout(1_200);
  const viewport = page.viewportSize();
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  for (let step = 0; step < 400; step += 1) {
    const atEnd = await page.evaluate(
      () =>
        globalThis.scrollY + globalThis.innerHeight >=
        globalThis.document.documentElement.scrollHeight - 2,
    );
    if (atEnd) break;
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(1_200);
}

async function recordPages(manifest, run, endpoint, directory) {
  const recorded = [];
  const failures = [];
  const browser = await chromium.connect(endpoint);
  try {
    for (const entry of manifest.filter((item) => item.record)) {
      const prepared = await prepareEntry(entry, run);
      for (const width of recordingWidths)
        for (const motion of ['no-preference', 'reduce']) {
          const name = `${entry.covers === '/' ? 'landing' : entry.covers.slice(1).replaceAll('/', '-').toLowerCase()}-${width}-${motion === 'reduce' ? 'reduced-motion' : 'motion-on'}.webm`;
          // One bounded retry: a first navigation from a fresh context can
          // time out while the container warms up. Only a recording whose
          // page opened and scrolled to the end is kept.
          let error;
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const context = await browser.newContext({
              viewport: { width, height: 900 },
              colorScheme: 'light',
              reducedMotion: motion,
              javaScriptEnabled: entry.javaScriptEnabled !== false,
              recordVideo: {
                dir: '/tmp/valstara-e11-5-12-videos',
                size: { width, height: 900 },
              },
            });
            let video;
            error = undefined;
            try {
              await setUpContext(context, entry, run.origin, prepared);
              const page = await context.newPage();
              video = page.video();
              const response = await openRoute(page, prepared.path, run.origin);
              if (response?.status() !== (entry.status ?? 200))
                throw new Error(`answered ${response?.status()}`);
              await entry.run?.(page);
              await scrollThrough(page);
            } catch (caught) {
              error = caught;
            } finally {
              await context.close();
            }
            if (error === undefined && video !== undefined) {
              await video.saveAs(join(directory, name));
              recorded.push(name);
              break;
            }
            await video?.delete().catch(() => undefined);
          }
          if (error !== undefined)
            failures.push({
              label: `${entry.label} ${width} ${motion}`,
              error: String(error?.message ?? error).split('\n')[0],
            });
          process.stdout.write(`recorded ${name}\n`);
        }
    }
  } finally {
    await browser.close();
  }
  return { recorded, failures };
}

async function main() {
  for (const [key, value] of Object.entries(localEnvironment))
    process.env[key] ??= value;
  const record = process.argv.includes('--record');
  const started = globalThis.performance.now();
  const cleanups = [];
  const cleanUp = async () => {
    while (cleanups.length > 0) {
      const step = cleanups.pop();
      try {
        await step();
      } catch (error) {
        process.stderr.write(`cleanup: ${error?.message ?? error}\n`);
      }
    }
  };
  const interrupted = () => {
    void cleanUp().finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  let failed;
  try {
    process.stdout.write('Building the app if its inputs changed…\n');
    await ensureAppBuild();
    const { sourcePagePaths } = await import(
      pathToFileURL(join(root, 'test/helpers/page-inventory.mjs')).href
    );
    const { routes } = await sourcePagePaths();
    const complete = buildManifest({ rulesRoutes: rulesRoutesOf(routes) });
    const gaps = coverageGaps(complete, routes);
    if (gaps.uncovered.length > 0 || gaps.unknown.length > 0)
      throw new Error(
        `The manifest does not match the inventory: ${JSON.stringify(gaps)}`,
      );
    // `--only <pattern>` captures the matching labels alone, for a re-check
    // of a few states; its summary says it is partial. The task states follow
    // one another's rows, so a subset of them may not reach its state.
    const only = option('--only');
    const selected = (entry) =>
      only === undefined || new RegExp(only, 'u').test(entry.label);
    const manifest = complete.filter(selected);

    const fixture = await createFixture();
    cleanups.push(() => fixture.dispose());
    const sink = await startSink();
    cleanups.push(() => sink.close());
    const app = await startApp(fixture, sink.port);
    cleanups.push(() => app.stop());
    const local = `http://127.0.0.1:${app.port}`;
    const browserServer = await startBrowserServer(
      `valstara-e11-5-12-contact-sheet-${process.pid}`,
    );
    cleanups.push(() => browserServer.stop());
    const origin = `http://host.docker.internal:${app.port}`;
    await waitForBrowserReach(browserServer.endpoint, `${origin}/privacy`);
    const run = {
      origin,
      context: requestContext(local, fixture.database, fixture),
      applyFlags: flagController(fixture.database),
    };

    if (record) {
      const directory = resolve(root, recordingDirectory);
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      const result = await recordPages(
        manifest,
        run,
        browserServer.endpoint,
        directory,
      );
      const summary = {
        ticket: 'E11.5-12',
        generatedAt: new Date().toISOString(),
        wallTimeSeconds: Math.round(
          (globalThis.performance.now() - started) / 1000,
        ),
        widths: recordingWidths,
        recordings: result.recorded,
        failures: result.failures,
      };
      if (only !== undefined) summary.partial = { only };
      await writeFile(
        join(directory, 'summary.json'),
        JSON.stringify(summary, null, 2),
      );
      process.stdout.write(
        `${result.recorded.length} recordings in ${recordingDirectory}\n`,
      );
      failed = result.failures.length > 0;
    } else {
      const directory = resolve(root, outputDirectory);
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      const pages = await capturePages(
        manifest,
        run,
        browserServer.endpoint,
        join(directory, 'pages'),
      );
      const emails = await captureEmails(
        browserServer.endpoint,
        join(directory, 'emails'),
        selected,
      );
      const summary = summarise(
        pages,
        emails,
        (globalThis.performance.now() - started) / 1000,
      );
      if (only !== undefined) summary.partial = { only };
      await writeFile(
        join(directory, 'summary.json'),
        JSON.stringify(summary, null, 2),
      );
      process.stdout.write(
        `${summary.totalCaptures} captures, ${summary.failures.length} failures, ${summary.layoutIssues.length} captures with layout issues: ${outputDirectory}/summary.json\n`,
      );
      failed = summary.failures.length > 0 || summary.layoutIssues.length > 0;
    }
  } catch (error) {
    failed = true;
    process.stderr.write(`${error?.stack ?? error}\n`);
  } finally {
    await cleanUp();
  }
  process.exitCode = failed ? 1 : 0;
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  import.meta.url === pathToFileURL(resolve(invoked)).href
)
  await main();
