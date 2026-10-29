import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';

import { landingCopy } from '../src/copy/landing.ts';
import { resendVerificationCopy } from '../src/copy/resend-verification.ts';
import { signupCopy, signupFormCopy } from '../src/copy/signup.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { renderLanding } from './helpers/landing-render.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

// E11.5-11g: the 17 signup form states of StatesDesktop.dc.html (on the
// 1440 × 900 hero) and StatesPhone.dc.html (on the 390 × 844 hero). Every
// box below is the frame's: each state frame was rendered on the self-hosted
// fonts with its annotation layer off, and the boxes were read relative to
// the H1. The frames' own `.v p` and `.v ul` resets drop the hint, microline,
// field-error and trust-fact margins their CSS states (4, 12, 8 and 20px, or
// 16px on the phone), so those stated margins were restored before reading,
// as E11.5-11c built them. A null is left to the page; every other number is
// asserted with a 1px tolerance, in both themes. The frames draw the
// giveaway open, so the states render with `giveaway.open` on.

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-signup-states-playwright-${process.pid}`;
const appServerStartupTimeoutMilliseconds = 30_000;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const themes = ['light', 'dark'];
const viewports = {
  1440: { width: 1440, height: 900 },
  390: { width: 390, height: 844 },
};
const tolerance = 1;
const typed = 'alex.morgan@example.com';

// Each element the frames draw, as the page names it. A state draws exactly
// the keys its frame entry lists; every other key must not be displayed.
const selectors = {
  note: '[data-form-error], noscript > .signup-notice',
  noteIcon: '[data-form-error] .icon, noscript > .signup-notice .icon',
  noteText: '[data-form-error] > span, noscript > .signup-notice > span',
  label: '.field__label',
  hint: '.field__description',
  input: '#signup-email',
  button: '[data-submit]',
  spinner: '[data-spinner]',
  error: '#signup-email-error',
  errorIcon: '#signup-email-error .icon',
  micro: 'form > .signup-age',
  check: '.signup-turnstile[data-open] > *',
  facts: '.landing-facts',
  consent: 'label.signup-marketing',
  panel: '[data-success], .landing-paused',
  tile: '.signup-success__tile, .landing-paused__tile',
  tileIcon: '.signup-success__tile .icon, .landing-paused__tile .icon',
  heading: '[data-success] h2, .landing-paused h2',
  address: '[data-success-address]',
  body: '.signup-success__step, .landing-paused p',
  actions: '.signup-success__actions .button',
  actionIcon: '.signup-success__actions .button .icon',
  resent: '[data-resend-status]',
  resentIcon: '[data-resend-status] .icon',
};

// [x, y, width, height] relative to the H1's top-left, per state.
const frames = {
  1440: {
    '01': {
      label: [[0, 136, 560, 20]],
      hint: [[0, 160, 560, 20]],
      input: [[0, 188, 385, 48]],
      button: [[393, 188, 167, 48]],
      micro: [[0, 248, 560, 20]],
      facts: [[0, 288, 560, 20]],
      consent: [[0, 332, 560, 40]],
    },
    '02': {
      label: [[0, 136, 560, 20]],
      hint: [[0, 160, 560, 20]],
      input: [[0, 188, 385, 48]],
      button: [[393, 188, 167, 48]],
      micro: [[0, 248, 560, 20]],
      facts: [[0, 288, 560, 20]],
      consent: [[0, 332, 560, 40]],
    },
    '03': {
      label: [[0, 136, 560, 20]],
      hint: [[0, 160, 560, 20]],
      input: [[0, 188, 385, 48]],
      button: [[393, 188, 167, 48]],
      error: [[0, 244, 560, 20]],
      errorIcon: [[0, 244, 20, 20]],
      micro: [[0, 276, 560, 20]],
      facts: [[0, 316, 560, 20]],
      consent: [[0, 360, 560, 40]],
    },
    '04': {
      label: [[0, 136, 560, 20]],
      hint: [[0, 160, 560, 20]],
      input: [[0, 188, 385, 48]],
      button: [[393, 188, 167, 48]],
      error: [[0, 244, 560, 20]],
      errorIcon: [[0, 244, 20, 20]],
      micro: [[0, 276, 560, 20]],
      facts: [[0, 316, 560, 20]],
      consent: [[0, 360, 560, 40]],
    },
    '05': {
      label: [[0, 136, 560, 20]],
      hint: [[0, 160, 560, 20]],
      input: [[0, 188, 385, 48]],
      button: [[393, 188, 167, 48]],
      error: [[0, 244, 560, 20]],
      errorIcon: [[0, 244, 20, 20]],
      micro: [[0, 276, 560, 20]],
      facts: [[0, 316, 560, 20]],
      consent: [[0, 360, 560, 40]],
    },
    '06': {
      label: [[0, 136, 560, 20]],
      hint: [[0, 160, 560, 20]],
      input: [[0, 188, 234, 48]],
      button: [[242, 188, 318, 48]],
      spinner: [[266, 204, 16, 16]],
      micro: [[0, 248, 560, 20]],
      facts: [[0, 288, 560, 20]],
      consent: [[0, 332, 560, 40]],
    },
    '07': {
      label: [[0, 136, 560, 20]],
      hint: [[0, 160, 560, 20]],
      input: [[0, 188, 272, 48]],
      button: [[280, 188, 280, 48]],
      spinner: [[304, 204, 16, 16]],
      micro: [[0, 248, 560, 20]],
      facts: [[0, 288, 560, 20]],
      consent: [[0, 332, 560, 40]],
    },
    '08': {
      label: [[0, 136, 560, 20]],
      hint: [[0, 160, 560, 20]],
      input: [[0, 188, 258, 48]],
      button: [[266, 188, 294, 48]],
      micro: [[0, 248, 560, 20]],
      check: [[0, 280, 300, 65]],
      facts: [[0, 365, 560, 20]],
      consent: [[0, 409, 560, 40]],
    },
    '09': {
      note: [[0, 136, 560, 52]],
      noteIcon: [[16, 152, 20, 20]],
      noteText: [[48, 152, 326, 20]],
      label: [[0, 208, 560, 20]],
      hint: [[0, 232, 560, 20]],
      input: [[0, 260, 385, 48]],
      button: [[393, 260, 167, 48]],
      micro: [[0, 320, 560, 20]],
      facts: [[0, 360, 560, 20]],
      consent: [[0, 404, 560, 40]],
    },
    10: {
      note: [[0, 136, 560, 72]],
      noteIcon: [[16, 152, 20, 20]],
      noteText: [[48, 152, 496, 40]],
      label: [[0, 228, 560, 20]],
      hint: [[0, 252, 560, 20]],
      input: [[0, 280, 385, 48]],
      button: [[393, 280, 167, 48]],
      micro: [[0, 340, 560, 20]],
      facts: [[0, 380, 560, 20]],
      consent: [[0, 424, 560, 40]],
    },
    11: {
      note: [[0, 136, 560, 52]],
      noteIcon: [[16, 152, 20, 20]],
      noteText: [[48, 152, 396, 20]],
      label: [[0, 208, 560, 20]],
      hint: [[0, 232, 560, 20]],
      input: [[0, 260, 385, 48]],
      button: [[393, 260, 167, 48]],
      micro: [[0, 320, 560, 20]],
      facts: [[0, 360, 560, 20]],
      consent: [[0, 404, 560, 40]],
    },
    12: {
      note: [[0, 136, 560, 52]],
      noteIcon: [[16, 152, 20, 20]],
      noteText: [[48, 152, 287, 20]],
      label: [[0, 208, 560, 20]],
      hint: [[0, 232, 560, 20]],
      input: [[0, 260, 385, 48]],
      button: [[393, 260, 167, 48]],
      micro: [[0, 320, 560, 20]],
      facts: [[0, 360, 560, 20]],
      consent: [[0, 404, 560, 40]],
    },
    13: {
      panel: [[0, 136, 560, 328]],
      tile: [[32, 168, 48, 48]],
      tileIcon: [[44, 180, 24, 24]],
      heading: [[32, 228, 193.17, 32]],
      address: [[32, 272, 208, 36]],
      body: [[32, 320, 496, 48]],
      actions: [[32, 388, 186, 44]],
    },
    14: {
      panel: [[0, 136, 560, 328]],
      tile: [[32, 168, 48, 48]],
      tileIcon: [[44, 180, 24, 24]],
      heading: [[32, 228, 193.17, 32]],
      address: [[32, 272, 208, 36]],
      body: [[32, 320, 496, 48]],
      actions: [
        [32, 388, 186, 44],
        [230, 388, 186, 44],
      ],
      actionIcon: [[246, 402, 16, 16]],
    },
    15: {
      panel: [[0, 136, 560, 380]],
      tile: [[32, 168, 48, 48]],
      tileIcon: [[44, 180, 24, 24]],
      heading: [[32, 228, 193.17, 32]],
      address: [[32, 272, 208, 36]],
      body: [[32, 320, 496, 48]],
      actions: [
        [32, 388, 186, 44],
        [230, 388, 186, 44],
      ],
      actionIcon: [[246, 402, 16, 16]],
      resent: [[32, 444, 496, 40]],
      resentIcon: [[32, 446, 16, 16]],
    },
    16: {
      note: [[0, 136, 560, 52]],
      noteIcon: [[16, 152, 20, 20]],
      noteText: [[48, 152, 480, 20]],
      label: [[0, 204, 560, 20]],
      hint: [[0, 228, 560, 20]],
      input: [[0, 256, 385, 48]],
      button: [[393, 256, 167, 48]],
      micro: [[0, 316, 560, 20]],
      facts: [[0, 356, 560, 20]],
      consent: [[0, 400, 560, 40]],
    },
    17: {
      panel: [[0, 136, 560, 216]],
      tile: [[32, 168, 48, 48]],
      tileIcon: [[44, 180, 24, 24]],
      heading: [[32, 228, 218.69, 32]],
      body: [[32, 272, 496, 48]],
    },
  },
  390: {
    '01': {
      label: [[0, 188, 358, 20]],
      hint: [[0, 212, 358, 20]],
      input: [[0, 240, 358, 48]],
      button: [[0, 300, 358, 48]],
      micro: [[0, 360, 358, null]],
      facts: [[0, 416, 358, 48]],
      consent: [[0, 484, 358, 60]],
    },
    '02': {
      label: [[0, 188, 358, 20]],
      hint: [[0, 212, 358, 20]],
      input: [[0, 240, 358, 48]],
      button: [[0, 300, 358, 48]],
      micro: [[0, 360, 358, null]],
      facts: [[0, 416, 358, 48]],
      consent: [[0, 484, 358, 60]],
    },
    '03': {
      label: [[0, 188, 358, 20]],
      hint: [[0, 212, 358, 20]],
      input: [[0, 240, 358, 48]],
      button: [[0, 328, 358, 48]],
      error: [[0, 296, 358, 20]],
      errorIcon: [[0, 296, 20, 20]],
      micro: [[0, 388, 358, null]],
      facts: [[0, 444, 358, 48]],
      consent: [[0, 512, 358, 60]],
    },
    '04': {
      label: [[0, 188, 358, 20]],
      hint: [[0, 212, 358, 20]],
      input: [[0, 240, 358, 48]],
      button: [[0, 328, 358, 48]],
      error: [[0, 296, 358, 20]],
      errorIcon: [[0, 296, 20, 20]],
      micro: [[0, 388, 358, null]],
      facts: [[0, 444, 358, 48]],
      consent: [[0, 512, 358, 60]],
    },
    '05': {
      label: [[0, 188, 358, 20]],
      hint: [[0, 212, 358, 20]],
      input: [[0, 240, 358, 48]],
      button: [[0, 348, 358, 48]],
      error: [[0, 296, 358, 40]],
      errorIcon: [[0, 296, 20, 20]],
      micro: [[0, 408, 358, null]],
      facts: [[0, 464, 358, 48]],
      consent: [[0, 532, 358, 60]],
    },
    '06': {
      label: [[0, 188, 358, 20]],
      hint: [[0, 212, 358, 20]],
      input: [[0, 240, 358, 48]],
      button: [[0, 300, 358, 48]],
      spinner: [[44, 316, 16, 16]],
      micro: [[0, 360, 358, null]],
      facts: [[0, 416, 358, 48]],
      consent: [[0, 484, 358, 60]],
    },
    '07': {
      label: [[0, 188, 358, 20]],
      hint: [[0, 212, 358, 20]],
      input: [[0, 240, 358, 48]],
      button: [[0, 300, 358, 48]],
      spinner: [[63, 316, 16, 16]],
      micro: [[0, 360, 358, null]],
      facts: [[0, 416, 358, 48]],
      consent: [[0, 484, 358, 60]],
    },
    '08': {
      label: [[0, 188, 358, 20]],
      hint: [[0, 212, 358, 20]],
      input: [[0, 240, 358, 48]],
      button: [[0, 300, 358, 48]],
      micro: [[0, 360, 358, null]],
      check: [[0, 412, 300, 65]],
      facts: [[0, 493, 358, 48]],
      consent: [[0, 561, 358, 60]],
    },
    '09': {
      note: [[0, 188, 358, 72]],
      noteIcon: [[16, 204, 20, 20]],
      noteText: [[48, 204, 294, 40]],
      label: [[0, 276, 358, 20]],
      hint: [[0, 300, 358, 20]],
      input: [[0, 328, 358, 48]],
      button: [[0, 388, 358, 48]],
      micro: [[0, 448, 358, null]],
      facts: [[0, 504, 358, 48]],
      consent: [[0, 572, 358, 60]],
    },
    10: {
      note: [[0, 188, 358, 72]],
      noteIcon: [[16, 204, 20, 20]],
      noteText: [[48, 204, 294, 40]],
      label: [[0, 276, 358, 20]],
      hint: [[0, 300, 358, 20]],
      input: [[0, 328, 358, 48]],
      button: [[0, 388, 358, 48]],
      micro: [[0, 448, 358, null]],
      facts: [[0, 504, 358, 48]],
      consent: [[0, 572, 358, 60]],
    },
    11: {
      note: [[0, 188, 358, 72]],
      noteIcon: [[16, 204, 20, 20]],
      noteText: [[48, 204, 294, 40]],
      label: [[0, 276, 358, 20]],
      hint: [[0, 300, 358, 20]],
      input: [[0, 328, 358, 48]],
      button: [[0, 388, 358, 48]],
      micro: [[0, 448, 358, null]],
      facts: [[0, 504, 358, 48]],
      consent: [[0, 572, 358, 60]],
    },
    12: {
      note: [[0, 188, 358, 52]],
      noteIcon: [[16, 204, 20, 20]],
      noteText: [[48, 204, 287, 20]],
      label: [[0, 256, 358, 20]],
      hint: [[0, 280, 358, 20]],
      input: [[0, 308, 358, 48]],
      button: [[0, 368, 358, 48]],
      micro: [[0, 428, 358, null]],
      facts: [[0, 484, 358, 48]],
      consent: [[0, 552, 358, 60]],
    },
    13: {
      panel: [[0, 188, 358, 332]],
      tile: [[24, 212, 48, 48]],
      tileIcon: [[36, 224, 24, 24]],
      heading: [[24, 272, 193.17, 32]],
      address: [[24, 316, 208, 36]],
      body: [[24, 364, 310, 72]],
      actions: [[24, 452, 310, 44]],
    },
    14: {
      panel: [[0, 188, 358, 384]],
      tile: [[24, 212, 48, 48]],
      tileIcon: [[36, 224, 24, 24]],
      heading: [[24, 272, 193.17, 32]],
      address: [[24, 316, 208, 36]],
      body: [[24, 364, 310, 72]],
      actions: [
        [24, 452, 310, 44],
        [24, 504, 310, 44],
      ],
      actionIcon: [[102, 518, 16, 16]],
    },
    15: {
      panel: [[0, 188, 358, 436]],
      tile: [[24, 212, 48, 48]],
      tileIcon: [[36, 224, 24, 24]],
      heading: [[24, 272, 193.17, 32]],
      address: [[24, 316, 208, 36]],
      body: [[24, 364, 310, 72]],
      actions: [
        [24, 452, 310, 44],
        [24, 504, 310, 44],
      ],
      actionIcon: [[102, 518, 16, 16]],
      resent: [[24, 560, 310, 40]],
      resentIcon: [[24, 562, 16, 16]],
    },
    16: {
      note: [[0, 188, 358, 72]],
      noteIcon: [[16, 204, 20, 20]],
      noteText: [[48, 204, 294, 40]],
      label: [[0, 276, 358, 20]],
      hint: [[0, 300, 358, 20]],
      input: [[0, 328, 358, 48]],
      button: [[0, 388, 358, 48]],
      micro: [[0, 448, 358, null]],
      facts: [[0, 504, 358, 48]],
      consent: [[0, 572, 358, 60]],
    },
    17: {
      panel: [[0, 188, 358, 224]],
      tile: [[24, 212, 48, 48]],
      tileIcon: [[36, 224, 24, 24]],
      heading: [[24, 272, 218.69, 32]],
      body: [[24, 316, 310, 72]],
    },
  },
};

// How each state is reached. `value` is typed before submitting; `respond`
// answers the signup request; `message` is the state's copy-layer string
// and `focus` where focus must land.
const states = {
  '01': { name: 'idle' },
  '02': { name: 'focused', focusOnly: 'alex.morgan@exa' },
  '03': {
    name: 'inline error, empty',
    value: '',
    message: signupFormCopy.emailRequired,
    field: true,
    focus: '#signup-email',
  },
  '04': {
    name: 'inline error, invalid',
    value: 'alex.morgan@example',
    respond: [400, 'invalid_email', signupCopy.invalidEmail],
    message: signupCopy.invalidEmail,
    field: true,
    focus: '#signup-email',
  },
  '05': {
    name: 'blocked domain',
    value: 'alex@throwaway.example',
    respond: [400, 'blocked_domain', signupCopy.blockedDomain],
    message: signupCopy.blockedDomain,
    field: true,
    focus: '#signup-email',
  },
  '06': {
    name: 'security check in progress',
    turnstile: 'pending',
    label: signupFormCopy.challengePending,
    spinner: true,
  },
  '07': {
    name: 'submitting',
    respond: 'hold',
    label: signupFormCopy.submitting,
    spinner: true,
  },
  '08': {
    name: 'security check visible',
    turnstile: 'interactive',
    label: signupFormCopy.challengePending,
  },
  '09': {
    name: 'check failed',
    respond: [400, 'challenge_failed', signupCopy.challengeFailed],
    message: signupCopy.challengeFailed,
    focus: '[data-form-error]',
  },
  10: {
    name: 'network error',
    respond: 'abort',
    message: signupFormCopy.connection,
    focus: '[data-form-error]',
  },
  11: {
    name: 'unavailable',
    respond: [503, 'unavailable', signupCopy.unavailable],
    message: signupCopy.unavailable,
    focus: '[data-form-error]',
  },
  // The wait comes from the server: the route builds it from Retry-After.
  12: {
    name: 'rate limited',
    respond: [429, 'rate_limited', signupCopy.rateLimitedWait(5)],
    message: signupCopy.rateLimitedWait(5),
    focus: '[data-form-error]',
  },
  13: { name: 'success, first 60 seconds', success: true },
  14: { name: 'success, after 60 seconds', success: true, resend: true },
  15: {
    name: 'success, re-sent',
    success: true,
    resend: true,
    resent: true,
  },
  16: { name: 'JavaScript disabled', javaScriptEnabled: false },
  17: { name: 'signups paused', paused: true },
};

let app;
let browser;
let browserOrigin;
let hostOrigin;
let browserServer;
let browserServerError;
let giveawayOpenPage;
let signupsPausedPage;

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
      return `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
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

async function waitForBrowserAppServer() {
  const deadline =
    globalThis.performance.now() + appServerStartupTimeoutMilliseconds;
  const context = await browser.newContext();
  const page = await context.newPage();
  let lastError;
  try {
    while (globalThis.performance.now() < deadline) {
      try {
        const response = await page.goto(browserOrigin, { timeout: 2_000 });
        if (response?.ok()) return;
      } catch (error) {
        lastError = error;
      }
      if (app.server.exitCode !== null) break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
    throw new Error(
      `Signup states browser could not reach the app server. ${String(lastError)}\n${app.output() || '(no server output)'}`,
    );
  } finally {
    await context.close();
  }
}

before(async () => {
  await ensureAppBuild();
  // The flag variants are rendered by a server reading real campaign_flag
  // rows; the browser then loads that HTML at this app's origin, so its
  // stylesheets and island come from the same build.
  [giveawayOpenPage, signupsPausedPage] = [
    (await renderLanding({ flags: [{ key: 'giveaway.open', enabled: true }] }))
      .body,
    (
      await renderLanding({
        flags: [{ key: 'signup.enabled', enabled: false }],
      })
    ).body,
  ];
  app = await startAppServer({
    label: 'Signup states test',
    env: () => ({
      ADMIN_CREDENTIAL: 'signup-states-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-states',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'signup-states-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'signup-states-referral-secret',
      RESEND_API_KEY: 'signup-states-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'signup-states-turnstile-secret',
    }),
  });
  hostOrigin = `http://127.0.0.1:${app.port}`;
  browserOrigin = `http://host.docker.internal:${app.port}`;
  browser = await chromium.connect(await startBrowserServer());
  await waitForBrowserAppServer();
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

// A Turnstile stand-in: `success` resolves at once (and with a fresh token
// on reset), `pending` never resolves, and `interactive` opens a 300 × 65
// widget, as Cloudflare does when it needs the visitor, and waits.
function installTurnstile(mode) {
  globalThis.turnstile = {
    render(element, options) {
      globalThis.testTurnstileOptions = options;
      if (mode === 'success') {
        globalThis.setTimeout(() => options.callback('states-token'), 0);
      } else if (mode === 'interactive') {
        globalThis.setTimeout(() => {
          options['before-interactive-callback']();
          const widget = globalThis.document.createElement('div');
          widget.style.width = '300px';
          widget.style.height = '65px';
          element.append(widget);
        }, 0);
      }
      return 'states-widget';
    },
    reset() {
      if (mode === 'success')
        globalThis.setTimeout(
          () => globalThis.testTurnstileOptions.callback('states-token-fresh'),
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

// Opens a landing variant's HTML at the app origin, with its same-origin
// requests answered from the running app server.
async function openPage({
  html,
  viewport,
  colorScheme = 'light',
  reducedMotion = 'no-preference',
  javaScriptEnabled = true,
  turnstile = 'success',
  resendSoon = false,
  island = html !== signupsPausedPage,
}) {
  const context = await browser.newContext({
    viewport,
    colorScheme,
    reducedMotion,
    javaScriptEnabled,
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  if (javaScriptEnabled) {
    await context.addInitScript(installTurnstile, turnstile);
    if (resendSoon) await context.addInitScript(accelerateResend);
  }
  await context.route(`${browserOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/')
      return route.fulfill({
        body: html,
        contentType: 'text/html; charset=utf-8',
      });
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 204 });
    const response = await globalThis.fetch(
      `${hostOrigin}${url.pathname}${url.search}`,
    );
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? undefined,
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  const page = await context.newPage();
  await page.goto(browserOrigin);
  await page.evaluate(() => globalThis.document.fonts.ready);
  if (javaScriptEnabled && island) {
    await page.evaluate(() =>
      globalThis.customElements.whenDefined('valstara-signup-form'),
    );
  }
  return { context, page };
}

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

// Drives a fresh page into the state.
async function reach(page, state) {
  if (state.focusOnly !== undefined) {
    await page.locator('#signup-email').focus();
    await page.keyboard.type(state.focusOnly);
    return;
  }
  if (state.paused || state.javaScriptEnabled === false) return;
  if (state.value === undefined && state.respond === undefined) {
    if (state.turnstile === undefined && !state.success) return;
  }
  await page.route('**/api/signup', (route) => {
    const respond = state.respond;
    if (respond === 'hold') return undefined;
    if (respond === 'abort') return route.abort('internetdisconnected');
    if (Array.isArray(respond)) {
      const [status, code, message] = respond;
      return json(route, status, { error: { code, message } });
    }
    return json(route, 200, { status: 'pending', message: signupCopy.pending });
  });
  await page.route('**/api/resend-verification', (route) =>
    json(route, 200, {
      status: 'pending',
      message: resendVerificationCopy.accepted,
    }),
  );
  await page.locator('#signup-email').fill(state.value ?? typed);
  await page.locator('[data-submit]').click();
  if (state.message !== undefined) {
    await page.waitForSelector(
      state.field ? '#signup-email-error:visible' : '[data-form-error]:visible',
    );
  } else if (state.label !== undefined) {
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

// Lets every state-change transition finish, so colours read at rest, and
// holds the spinner at its first frame, so its box is the drawn 16px square
// rather than the bounds of a turned one.
function settle(page) {
  return page.evaluate(async () => {
    const animations = globalThis.document.getAnimations();
    await Promise.all(
      animations
        .filter((animation) => animation instanceof globalThis.CSSTransition)
        .map((animation) => animation.finished),
    );
    for (const animation of animations) {
      if (animation instanceof globalThis.CSSAnimation) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
  });
}

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance}px of ${expected}`,
  );
}

// The boxes of every displayed element each selector names, relative to the
// H1's top-left.
function measure(page) {
  return page.evaluate((entries) => {
    const { document } = globalThis;
    const base = document
      .querySelector('#landing-title')
      .getBoundingClientRect();
    const boxes = {};
    for (const [key, selector] of Object.entries(entries)) {
      boxes[key] = [...document.querySelectorAll(selector)]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return [
            rect.left - base.left,
            rect.top - base.top,
            rect.width,
            rect.height,
          ];
        });
    }
    return boxes;
  }, selectors);
}

// The tokens as the browser resolves them in the page's theme.
function resolveTokens(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const probe = document.createElement('div');
    document.body.append(probe);
    const colour = (token) => {
      probe.style.color = `var(--${token})`;
      return getComputedStyle(probe).color;
    };
    const shadow = (value) => {
      probe.style.boxShadow = value;
      return getComputedStyle(probe).boxShadow;
    };
    const tokens = {
      ink: colour('ink'),
      ink600: colour('ink-600'),
      ink300: colour('ink-300'),
      line: colour('line'),
      paper: colour('paper'),
      surface: colour('surface'),
      coral: colour('coral'),
      coralTint: colour('coral-tint'),
      error: colour('error'),
      errorText: colour('error-text'),
      panel: shadow('var(--shadow-1), var(--edge)'),
      ring: shadow('var(--ring-focus)'),
      insetLine: shadow('var(--inset-line)'),
    };
    probe.remove();
    return tokens;
  });
}

function styles(page) {
  return page.evaluate((entries) => {
    const { document, getComputedStyle } = globalThis;
    const read = (selector) => {
      const element = [...document.querySelectorAll(selector)].find(
        (candidate) => candidate.getClientRects().length > 0,
      );
      if (element === undefined) return null;
      const css = getComputedStyle(element);
      return {
        font: `${css.fontSize}/${css.lineHeight} ${css.fontWeight}`,
        family: css.fontFamily,
        letterSpacing: css.letterSpacing,
        color: css.color,
        background: css.backgroundColor,
        shadow: css.boxShadow,
        radius: css.borderTopLeftRadius,
        border: `${css.borderTopWidth} ${css.borderTopStyle} ${css.borderTopColor}`,
        borders: [
          css.borderTopColor,
          css.borderRightColor,
          css.borderBottomColor,
          css.borderLeftColor,
        ],
        borderWidths: [
          css.borderTopWidth,
          css.borderRightWidth,
          css.borderBottomWidth,
          css.borderLeftWidth,
        ],
        role: element.getAttribute('role'),
      };
    };
    return Object.fromEntries(
      Object.entries(entries).map(([key, selector]) => [key, read(selector)]),
    );
  }, selectors);
}

function text(page, selector) {
  return page.evaluate(
    (target) =>
      [...globalThis.document.querySelectorAll(target)]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.textContent),
    selector,
  );
}

// The drawn styles and copy that the boxes cannot show.
async function assertDrawn(page, number, state, where) {
  const tokens = await resolveTokens(page);
  const css = await styles(page);
  const error = state.message !== undefined && !state.field;

  if (error) {
    assert.deepEqual(await text(page, selectors.note), [state.message], where);
    assert.equal(css.note.role, 'alert', where);
    assert.deepEqual(css.note.borderWidths, Array(4).fill('2px'), where);
    assert.deepEqual(css.note.borders, Array(4).fill(tokens.error), where);
    assert.equal(css.note.radius, '8px', where);
    assert.equal(css.note.background, tokens.surface, where);
    assert.equal(css.note.font, '14px/20px 500', where);
    assert.equal(css.note.color, tokens.ink, where);
    assert.equal(css.noteIcon.color, tokens.error, where);
  }
  if (state.javaScriptEnabled === false) {
    assert.deepEqual(
      await text(page, selectors.note),
      [signupFormCopy.javaScriptRequired],
      where,
    );
    assert.deepEqual(css.note.borderWidths, Array(4).fill('1px'), where);
    assert.deepEqual(css.note.borders, Array(4).fill(tokens.line), where);
    assert.equal(css.note.radius, '8px', where);
    assert.equal(css.note.background, tokens.surface, where);
    assert.equal(css.note.font, '14px/20px 500', where);
    assert.equal(css.note.color, tokens.ink, where);
    assert.equal(css.noteIcon.color, tokens.ink, where);
    assert.equal(
      await page.locator('noscript > .signup-notice .icon--info').count(),
      1,
      where,
    );
  }
  if (state.field) {
    assert.deepEqual(await text(page, selectors.error), [state.message], where);
    assert.equal(css.error.font, '14px/20px 600', where);
    assert.equal(css.error.color, tokens.errorText, where);
    assert.equal(css.errorIcon.color, tokens.error, where);
    assert.equal(css.input.border, `2px solid ${tokens.error}`, where);
    const input = page.locator('#signup-email');
    assert.equal(await input.getAttribute('aria-invalid'), 'true', where);
    assert.match(
      await input.getAttribute('aria-describedby'),
      /\bsignup-email-error\b/u,
      where,
    );
  }
  if (number === '02') {
    assert.equal(css.input.border, `1px solid ${tokens.coral}`, where);
    assert.equal(css.input.shadow, tokens.ring, where);
  }
  if (state.label !== undefined) {
    const button = page.locator('[data-submit]');
    assert.equal(await button.isDisabled(), true, where);
    assert.equal(await button.textContent(), state.label, where);
    assert.equal(css.button.background, tokens.coralTint, where);
    assert.equal(css.button.color, tokens.ink600, where);
    assert.equal(css.button.shadow, 'none', where);
  }
  if (state.spinner) {
    assert.deepEqual(
      css.spinner.borders,
      [tokens.ink, tokens.ink300, tokens.ink300, tokens.ink300],
      where,
    );
    assert.deepEqual(css.spinner.borderWidths, Array(4).fill('2px'), where);
    assert.equal(css.spinner.radius, '999px', where);
  }
  if (state.focus !== undefined) {
    assert.equal(
      await page.evaluate(
        (target) =>
          globalThis.document.activeElement ===
          globalThis.document.querySelector(target),
        state.focus,
      ),
      true,
      `${where}: focus moves to ${state.focus}`,
    );
  }
  if (state.success || state.paused) {
    assert.equal(css.panel.role, 'status', where);
    assert.equal(css.panel.background, tokens.surface, where);
    assert.equal(css.panel.shadow, tokens.panel, where);
    assert.equal(css.panel.radius, '12px', where);
    assert.equal(css.tile.background, tokens.coralTint, where);
    assert.equal(css.tile.radius, '8px', where);
    assert.equal(css.tileIcon.color, tokens.ink, where);
    assert.equal(css.heading.font, '24px/32px 600', where);
    assert.equal(css.heading.letterSpacing, '-0.24px', where);
    assert.equal(css.body.font, '16px/24px 400', where);
    assert.equal(css.body.color, tokens.ink600, where);
    const icon = state.paused ? '.icon--pause' : '.icon--mail';
    assert.equal(
      await page
        .locator(
          `${selectors.tile.split(', ')[0]} ${icon}, .landing-paused__tile ${icon}`,
        )
        .count(),
      1,
      where,
    );
    // Never a position, count or rank: no digit but the visitor's own input.
    const panelText = (await text(page, selectors.panel))[0];
    assert.doesNotMatch(panelText.replace(typed, ''), /\d/u, where);
  }
  if (state.paused) {
    assert.deepEqual(
      await text(page, selectors.heading),
      [landingCopy.paused.heading],
      where,
    );
    assert.deepEqual(
      await text(page, selectors.body),
      [landingCopy.paused.body],
      where,
    );
  }
  if (state.success) {
    assert.deepEqual(
      await text(page, selectors.heading),
      [signupFormCopy.successHeading],
      where,
    );
    assert.deepEqual(await text(page, selectors.address), [typed], where);
    assert.deepEqual(
      await text(page, selectors.body),
      [signupFormCopy.successStep],
      where,
    );
    assert.deepEqual(
      (await text(page, selectors.actions)).map((label) => label.trim()),
      [
        signupFormCopy.differentAddress,
        ...(state.resend ? [signupFormCopy.resendLink] : []),
      ],
      where,
    );
    assert.equal(css.address.font, '14px/20px 400', where);
    assert.match(css.address.family, /^"JetBrains Mono"/u, where);
    assert.equal(css.address.background, tokens.paper, where);
    assert.equal(css.address.shadow, tokens.insetLine, where);
    assert.equal(css.address.radius, '8px', where);
    assert.equal(css.actions.font, '14px/20px 600', where);
    assert.equal(css.actions.background, tokens.surface, where);
    if (state.resend)
      assert.equal(
        await page.locator('[data-resend] .icon--refresh').count(),
        1,
        where,
      );
    if (state.resent) {
      assert.deepEqual(
        await text(page, selectors.resent),
        [resendVerificationCopy.accepted],
        where,
      );
      assert.equal(css.resent.font, '14px/20px 400', where);
      assert.equal(css.resent.color, tokens.ink600, where);
      assert.equal(
        await page.locator('[data-resend-status] .icon--check').count(),
        1,
        where,
      );
    }
  }
}

for (const [number, state] of Object.entries(states)) {
  test(`state ${number}, ${state.name}, renders as drawn at 1440 × 900 and 390 × 844, in both themes`, async () => {
    for (const colorScheme of themes) {
      for (const [width, viewport] of Object.entries(viewports)) {
        const where = `state ${number} at ${width}, ${colorScheme}`;
        const { context, page } = await openPage({
          html: state.paused ? signupsPausedPage : giveawayOpenPage,
          viewport,
          colorScheme,
          javaScriptEnabled: state.javaScriptEnabled ?? true,
          turnstile: state.turnstile ?? 'success',
          resendSoon: state.resend === true,
        });
        try {
          await reach(page, state);
          await settle(page);
          const boxes = await measure(page);
          const frame = frames[width][number];
          for (const key of Object.keys(selectors)) {
            const expected = frame[key] ?? [];
            assert.equal(
              boxes[key].length,
              expected.length,
              `${where}: ${key} count`,
            );
            expected.forEach((box, index) => {
              box.forEach((value, axis) => {
                if (value !== null)
                  near(
                    boxes[key][index][axis],
                    value,
                    `${where}: ${key}[${index}] ${'xywh'[axis]}`,
                  );
              });
            });
          }
          await assertDrawn(page, number, state, where);
        } finally {
          await context.close();
        }
      }
    }
  });
}

test('the spinner turns only without reduced motion, and the label explains the wait either way', async () => {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const { context, page } = await openPage({
      html: giveawayOpenPage,
      viewport: viewports[1440],
      reducedMotion,
      turnstile: 'pending',
    });
    try {
      await reach(page, states['06']);
      const spinner = await page.evaluate(() => {
        const element = globalThis.document.querySelector('[data-spinner]');
        return {
          animation: globalThis.getComputedStyle(element).animationName,
          running: element
            .getAnimations()
            .filter((animation) => animation.playState === 'running').length,
        };
      });
      if (reducedMotion === 'reduce') {
        assert.deepEqual(spinner, { animation: 'none', running: 0 });
      } else {
        assert.deepEqual(spinner, { animation: 'signup-spin', running: 1 });
      }
      assert.ok(await page.locator('[data-spinner]').isVisible());
      assert.equal(
        await page.locator('[data-submit]').textContent(),
        signupFormCopy.challengePending,
      );
    } finally {
      await context.close();
    }
  }
});

// axe schedules its work asynchronously, which a page without JavaScript
// never runs. So state 16 is audited as a snapshot: the DOM the browser
// builds with JavaScript disabled (the noscript notice parsed as elements),
// with the page's own scripts removed, opened where axe can run.
async function noScriptSnapshot(viewport, colorScheme) {
  const { context, page } = await openPage({
    html: giveawayOpenPage,
    viewport,
    colorScheme,
    javaScriptEnabled: false,
  });
  try {
    return (await page.content())
      .replace(/<script\b[\s\S]*?<\/script>/gu, '')
      .replaceAll('<noscript>', '<div data-noscript>')
      .replaceAll('</noscript>', '</div>');
  } finally {
    await context.close();
  }
}

test('states 03, 09, 13 and 16 pass WCAG axe in both themes', async () => {
  for (const number of ['03', '09', '13', '16']) {
    const state = states[number];
    for (const colorScheme of themes) {
      for (const [width, viewport] of Object.entries(viewports)) {
        const noScript = state.javaScriptEnabled === false;
        const { context, page } = await openPage({
          html: noScript
            ? await noScriptSnapshot(viewport, colorScheme)
            : giveawayOpenPage,
          viewport,
          colorScheme,
          island: !noScript,
        });
        try {
          if (noScript)
            assert.equal(
              await page.locator('[data-noscript] .signup-notice').isVisible(),
              true,
            );
          else await reach(page, state);
          await page.addScriptTag({ content: axe.source });
          const violations = await page.evaluate(async () => {
            const result = await globalThis.axe.run(
              globalThis.document.querySelector('#join'),
              {
                runOnly: {
                  type: 'tag',
                  values: [
                    'wcag2a',
                    'wcag2aa',
                    'wcag21a',
                    'wcag21aa',
                    'wcag22aa',
                  ],
                },
              },
            );
            return result.violations.map((violation) => ({
              id: violation.id,
              targets: violation.nodes.map((node) => node.target),
            }));
          });
          assert.deepEqual(
            violations,
            [],
            `state ${number} axe, ${colorScheme}, ${width}px`,
          );
        } finally {
          await context.close();
        }
      }
    }
  }
});
