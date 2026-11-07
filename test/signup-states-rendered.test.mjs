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
import {
  entranceEnded,
  focusMotionIssues,
  readStateMotion,
  recordStateMotion,
  resumeStateMotion,
  transitionsEnded,
} from './helpers/motion.mjs';
import { renderLanding } from './helpers/landing-render.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

// E11.5-11g: the 17 signup form states of StatesDesktop.dc.html (on the
// 1440 × 900 hero) and StatesPhone.dc.html (on the 390 × 844 hero). Every
// box below is relative to the H1, asserted with a 1px tolerance in both
// themes; a null is left to the page. The frames draw the giveaway open, so
// the states render with `giveaway.open` on.
//
// E11.5-11l (founder-authorised 2026-11-07): the form is now the hero's card,
// so the boxes of states 01-12 and 16 are the final canvas's
// (docs/design/final-ui, Hero.dc.html with each state's tweak), rendered on
// the self-hosted fonts with the annotation layer off: the card's 24px (20px
// phone) padding, the 552px content width at 1440, the divider above the
// trust facts, the 16px checkbox gap, the 16px notice gap, the field error
// under the field only, and the no-JavaScript notice above the card.
//
// E11.5-11m (rule-7 rewrites): state 08 keeps the spinner while the widget
// is open, as the canvas draws it, so at 1440 its field is the canvas's
// 226px; and states 13-15 and 17 are the canvas's panels, rendered the same
// way, filling the 600px form column: the tile beside the heading, the echo
// with its mail icon, the re-sent line above the actions, and the actions
// over a 1px line.

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
  addressIcon: '[data-success-address] .icon',
  body: '.signup-success__step, .landing-paused p',
  actionsRow: '.signup-success__actions',
  actions: '.signup-success__actions .button',
  actionIcon: '.signup-success__actions .button .icon',
  resent: '[data-resend-status]',
  resentIcon: '[data-resend-status] .icon',
};

// [x, y, width, height] relative to the H1's top-left, per state. One
// founder decision overrides the frame (2026-10-29): the success panel's
// buttons are the secondary primitive as the component sheet draws it, 48px
// with 20px padding and 16/24 text from 48rem (the canvas page's bare .btn
// pads 24px). So at 1440 the actions and the icon in the second are read
// from the canvas rendered with that primitive, in the canvas's placement.
// Below 48rem the primitive is the drawn 44px, so 390 is the canvas's.
const frames = {
  1440: {
    '01': {
      label: [[24, 160, 552, 20]],
      hint: [[24, 184, 552, 20]],
      input: [[24, 212, 377, 48]],
      button: [[409, 212, 167, 48]],
      micro: [[24, 272, 552, 20]],
      facts: [[24, 329, 552, 20]],
      consent: [[24, 365, 552, 40]],
    },
    '02': {
      label: [[24, 160, 552, 20]],
      hint: [[24, 184, 552, 20]],
      input: [[24, 212, 377, 48]],
      button: [[409, 212, 167, 48]],
      micro: [[24, 272, 552, 20]],
      facts: [[24, 329, 552, 20]],
      consent: [[24, 365, 552, 40]],
    },
    '03': {
      label: [[24, 160, 552, 20]],
      hint: [[24, 184, 552, 20]],
      input: [[24, 212, 377, 48]],
      button: [[409, 212, 167, 48]],
      error: [[24, 268, 377, 20]],
      errorIcon: [[24, 268, 20, 20]],
      micro: [[24, 300, 552, 20]],
      facts: [[24, 357, 552, 20]],
      consent: [[24, 393, 552, 40]],
    },
    '04': {
      label: [[24, 160, 552, 20]],
      hint: [[24, 184, 552, 20]],
      input: [[24, 212, 377, 48]],
      button: [[409, 212, 167, 48]],
      error: [[24, 268, 377, 20]],
      errorIcon: [[24, 268, 20, 20]],
      micro: [[24, 300, 552, 20]],
      facts: [[24, 357, 552, 20]],
      consent: [[24, 393, 552, 40]],
    },
    '05': {
      label: [[24, 160, 552, 20]],
      hint: [[24, 184, 552, 20]],
      input: [[24, 212, 377, 48]],
      button: [[409, 212, 167, 48]],
      error: [[24, 268, 377, 20]],
      errorIcon: [[24, 268, 20, 20]],
      micro: [[24, 300, 552, 20]],
      facts: [[24, 357, 552, 20]],
      consent: [[24, 393, 552, 40]],
    },
    '06': {
      label: [[24, 160, 552, 20]],
      hint: [[24, 184, 552, 20]],
      input: [[24, 212, 226, 48]],
      button: [[258, 212, 318, 48]],
      spinner: [[282, 228, 16, 16]],
      micro: [[24, 272, 552, 20]],
      facts: [[24, 329, 552, 20]],
      consent: [[24, 365, 552, 40]],
    },
    '07': {
      label: [[24, 160, 552, 20]],
      hint: [[24, 184, 552, 20]],
      input: [[24, 212, 264, 48]],
      button: [[296, 212, 280, 48]],
      spinner: [[320, 228, 16, 16]],
      micro: [[24, 272, 552, 20]],
      facts: [[24, 329, 552, 20]],
      consent: [[24, 365, 552, 40]],
    },
    '08': {
      label: [[24, 160, 552, 20]],
      hint: [[24, 184, 552, 20]],
      input: [[24, 212, 226, 48]],
      button: [[258, 212, 318, 48]],
      spinner: [[282, 228, 16, 16]],
      micro: [[24, 272, 552, 20]],
      check: [[24, 304, 300, 65]],
      facts: [[24, 406, 552, 20]],
      consent: [[24, 442, 552, 40]],
    },
    '09': {
      note: [[24, 160, 552, 52]],
      noteIcon: [[40, 176, 20, 20]],
      noteText: [[72, 176, 326, 20]],
      label: [[24, 228, 552, 20]],
      hint: [[24, 252, 552, 20]],
      input: [[24, 280, 377, 48]],
      button: [[409, 280, 167, 48]],
      micro: [[24, 340, 552, 20]],
      facts: [[24, 397, 552, 20]],
      consent: [[24, 433, 552, 40]],
    },
    10: {
      note: [[24, 160, 552, 72]],
      noteIcon: [[40, 176, 20, 20]],
      noteText: [[72, 176, 488, 40]],
      label: [[24, 248, 552, 20]],
      hint: [[24, 272, 552, 20]],
      input: [[24, 300, 377, 48]],
      button: [[409, 300, 167, 48]],
      micro: [[24, 360, 552, 20]],
      facts: [[24, 417, 552, 20]],
      consent: [[24, 453, 552, 40]],
    },
    11: {
      note: [[24, 160, 552, 52]],
      noteIcon: [[40, 176, 20, 20]],
      noteText: [[72, 176, 396, 20]],
      label: [[24, 228, 552, 20]],
      hint: [[24, 252, 552, 20]],
      input: [[24, 280, 377, 48]],
      button: [[409, 280, 167, 48]],
      micro: [[24, 340, 552, 20]],
      facts: [[24, 397, 552, 20]],
      consent: [[24, 433, 552, 40]],
    },
    12: {
      note: [[24, 160, 552, 52]],
      noteIcon: [[40, 176, 20, 20]],
      noteText: [[72, 176, 287, 20]],
      label: [[24, 228, 552, 20]],
      hint: [[24, 252, 552, 20]],
      input: [[24, 280, 377, 48]],
      button: [[409, 280, 167, 48]],
      micro: [[24, 340, 552, 20]],
      facts: [[24, 397, 552, 20]],
      consent: [[24, 433, 552, 40]],
    },
    13: {
      panel: [[0, 136, 600, 329]],
      tile: [[32, 168, 48, 48]],
      tileIcon: [[44, 180, 24, 24]],
      heading: [[96, 176, 193.17, 32]],
      address: [[32, 240, 232, 36]],
      addressIcon: [[44, 250, 16, 16]],
      body: [[32, 288, 512, 48]],
      actionsRow: [[32, 360, 536, 73]],
      actions: [[32, 385, 213, 48]],
    },
    14: {
      panel: [[0, 136, 600, 329]],
      tile: [[32, 168, 48, 48]],
      tileIcon: [[44, 180, 24, 24]],
      heading: [[96, 176, 193.17, 32]],
      address: [[32, 240, 232, 36]],
      addressIcon: [[44, 250, 16, 16]],
      body: [[32, 288, 512, 48]],
      actionsRow: [[32, 360, 536, 73]],
      actions: [
        [32, 385, 213, 48],
        [253, 385, 207, 48],
      ],
      actionIcon: [[273, 401, 16, 16]],
    },
    15: {
      panel: [[0, 136, 600, 385]],
      tile: [[32, 168, 48, 48]],
      tileIcon: [[44, 180, 24, 24]],
      heading: [[96, 176, 193.17, 32]],
      address: [[32, 240, 232, 36]],
      addressIcon: [[44, 250, 16, 16]],
      body: [[32, 288, 512, 48]],
      resent: [[32, 352, 536, 40]],
      resentIcon: [[32, 354, 16, 16]],
      actionsRow: [[32, 416, 536, 73]],
      actions: [
        [32, 441, 213, 48],
        [253, 441, 207, 48],
      ],
      actionIcon: [[273, 457, 16, 16]],
    },
    16: {
      note: [[0, 136, 600, 52]],
      noteIcon: [[16, 152, 20, 20]],
      noteText: [[48, 152, 480, 20]],
      label: [[24, 228, 552, 20]],
      hint: [[24, 252, 552, 20]],
      input: [[24, 280, 377, 48]],
      button: [[409, 280, 167, 48]],
      micro: [[24, 340, 552, 20]],
      facts: [[24, 397, 552, 20]],
      consent: [[24, 433, 552, 40]],
    },
    17: {
      panel: [[0, 136, 600, 172]],
      tile: [[32, 168, 48, 48]],
      tileIcon: [[44, 180, 24, 24]],
      heading: [[96, 176, 218.69, 32]],
      body: [[32, 228, 512, 48]],
    },
  },
  390: {
    '01': {
      label: [[20, 208, 318, 20]],
      hint: [[20, 232, 318, 20]],
      input: [[20, 260, 318, 48]],
      button: [[20, 320, 318, 48]],
      micro: [[20, 380, 318, null]],
      facts: [[20, 457, 318, 48]],
      consent: [[20, 521, 318, 60]],
    },
    '02': {
      label: [[20, 208, 318, 20]],
      hint: [[20, 232, 318, 20]],
      input: [[20, 260, 318, 48]],
      button: [[20, 320, 318, 48]],
      micro: [[20, 380, 318, null]],
      facts: [[20, 457, 318, 48]],
      consent: [[20, 521, 318, 60]],
    },
    '03': {
      label: [[20, 208, 318, 20]],
      hint: [[20, 232, 318, 20]],
      input: [[20, 260, 318, 48]],
      button: [[20, 348, 318, 48]],
      error: [[20, 316, 318, 20]],
      errorIcon: [[20, 316, 20, 20]],
      micro: [[20, 408, 318, null]],
      facts: [[20, 485, 318, 48]],
      consent: [[20, 549, 318, 60]],
    },
    '04': {
      label: [[20, 208, 318, 20]],
      hint: [[20, 232, 318, 20]],
      input: [[20, 260, 318, 48]],
      button: [[20, 348, 318, 48]],
      error: [[20, 316, 318, 20]],
      errorIcon: [[20, 316, 20, 20]],
      micro: [[20, 408, 318, null]],
      facts: [[20, 485, 318, 48]],
      consent: [[20, 549, 318, 60]],
    },
    '05': {
      label: [[20, 208, 318, 20]],
      hint: [[20, 232, 318, 20]],
      input: [[20, 260, 318, 48]],
      button: [[20, 368, 318, 48]],
      error: [[20, 316, 318, 40]],
      errorIcon: [[20, 316, 20, 20]],
      micro: [[20, 428, 318, null]],
      facts: [[20, 505, 318, 48]],
      consent: [[20, 569, 318, 60]],
    },
    '06': {
      label: [[20, 208, 318, 20]],
      hint: [[20, 232, 318, 20]],
      input: [[20, 260, 318, 48]],
      button: [[20, 320, 318, 48]],
      spinner: [[44, 336, 16, 16]],
      micro: [[20, 380, 318, null]],
      facts: [[20, 457, 318, 48]],
      consent: [[20, 521, 318, 60]],
    },
    '07': {
      label: [[20, 208, 318, 20]],
      hint: [[20, 232, 318, 20]],
      input: [[20, 260, 318, 48]],
      button: [[20, 320, 318, 48]],
      spinner: [[63, 336, 16, 16]],
      micro: [[20, 380, 318, null]],
      facts: [[20, 457, 318, 48]],
      consent: [[20, 521, 318, 60]],
    },
    '08': {
      label: [[20, 208, 318, 20]],
      hint: [[20, 232, 318, 20]],
      input: [[20, 260, 318, 48]],
      button: [[20, 320, 318, 48]],
      spinner: [[44, 336, 16, 16]],
      micro: [[20, 380, 318, null]],
      check: [[20, 432, 300, 65]],
      facts: [[20, 534, 318, 48]],
      consent: [[20, 598, 318, 60]],
    },
    '09': {
      note: [[20, 208, 318, 72]],
      noteIcon: [[36, 224, 20, 20]],
      noteText: [[68, 224, 254, 40]],
      label: [[20, 296, 318, 20]],
      hint: [[20, 320, 318, 20]],
      input: [[20, 348, 318, 48]],
      button: [[20, 408, 318, 48]],
      micro: [[20, 468, 318, null]],
      facts: [[20, 545, 318, 48]],
      consent: [[20, 609, 318, 60]],
    },
    10: {
      note: [[20, 208, 318, 72]],
      noteIcon: [[36, 224, 20, 20]],
      noteText: [[68, 224, 254, 40]],
      label: [[20, 296, 318, 20]],
      hint: [[20, 320, 318, 20]],
      input: [[20, 348, 318, 48]],
      button: [[20, 408, 318, 48]],
      micro: [[20, 468, 318, null]],
      facts: [[20, 545, 318, 48]],
      consent: [[20, 609, 318, 60]],
    },
    11: {
      note: [[20, 208, 318, 72]],
      noteIcon: [[36, 224, 20, 20]],
      noteText: [[68, 224, 254, 40]],
      label: [[20, 296, 318, 20]],
      hint: [[20, 320, 318, 20]],
      input: [[20, 348, 318, 48]],
      button: [[20, 408, 318, 48]],
      micro: [[20, 468, 318, null]],
      facts: [[20, 545, 318, 48]],
      consent: [[20, 609, 318, 60]],
    },
    12: {
      note: [[20, 208, 318, 72]],
      noteIcon: [[36, 224, 20, 20]],
      noteText: [[68, 224, 254, 40]],
      label: [[20, 296, 318, 20]],
      hint: [[20, 320, 318, 20]],
      input: [[20, 348, 318, 48]],
      button: [[20, 408, 318, 48]],
      micro: [[20, 468, 318, null]],
      facts: [[20, 545, 318, 48]],
      consent: [[20, 609, 318, 60]],
    },
    13: {
      panel: [[0, 188, 358, 333]],
      tile: [[24, 212, 48, 48]],
      tileIcon: [[36, 224, 24, 24]],
      heading: [[88, 220, 193.17, 32]],
      address: [[24, 284, 232, 36]],
      addressIcon: [[36, 294, 16, 16]],
      body: [[24, 332, 310, 72]],
      actionsRow: [[24, 428, 310, 69]],
      actions: [[24, 453, 310, 44]],
    },
    14: {
      panel: [[0, 188, 358, 385]],
      tile: [[24, 212, 48, 48]],
      tileIcon: [[36, 224, 24, 24]],
      heading: [[88, 220, 193.17, 32]],
      address: [[24, 284, 232, 36]],
      addressIcon: [[36, 294, 16, 16]],
      body: [[24, 332, 310, 72]],
      actionsRow: [[24, 428, 310, 121]],
      actions: [
        [24, 453, 310, 44],
        [24, 505, 310, 44],
      ],
      actionIcon: [[102, 519, 16, 16]],
    },
    15: {
      panel: [[0, 188, 358, 441]],
      tile: [[24, 212, 48, 48]],
      tileIcon: [[36, 224, 24, 24]],
      heading: [[88, 220, 193.17, 32]],
      address: [[24, 284, 232, 36]],
      addressIcon: [[36, 294, 16, 16]],
      body: [[24, 332, 310, 72]],
      resent: [[24, 420, 310, 40]],
      resentIcon: [[24, 422, 16, 16]],
      actionsRow: [[24, 484, 310, 121]],
      actions: [
        [24, 509, 310, 44],
        [24, 561, 310, 44],
      ],
      actionIcon: [[102, 575, 16, 16]],
    },
    16: {
      note: [[0, 188, 358, 72]],
      noteIcon: [[16, 204, 20, 20]],
      noteText: [[48, 204, 294, 40]],
      label: [[20, 296, 318, 20]],
      hint: [[20, 320, 318, 20]],
      input: [[20, 348, 318, 48]],
      button: [[20, 408, 318, 48]],
      micro: [[20, 468, 318, null]],
      facts: [[20, 545, 318, 48]],
      consent: [[20, 609, 318, 60]],
    },
    17: {
      panel: [[0, 188, 358, 180]],
      tile: [[24, 212, 48, 48]],
      tileIcon: [[36, 224, 24, 24]],
      heading: [[88, 220, 218.69, 32]],
      body: [[24, 272, 310, 72]],
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
  forcedColors = 'none',
  turnstile = 'success',
  resendSoon = false,
  island = html !== signupsPausedPage,
}) {
  const context = await browser.newContext({
    viewport,
    colorScheme,
    reducedMotion,
    javaScriptEnabled,
    forcedColors,
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
  // The boxes are read at rest, after the hero entrance (E11.5-11l).
  await entranceEnded(page);
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
// E11.5-11m setup change (founder-authorised 2026-11-07), no assertion
// value changed: a transition the pointer cancels (state 15's re-sent line
// now moves the actions out from under it, as the canvas draws) is replaced
// by a new one, so the wait runs until none is left, bounded at ten rounds,
// rather than failing on the cancelled one.
function settle(page) {
  return page.evaluate(async () => {
    for (let round = 0; round < 10; round += 1) {
      const running = globalThis.document
        .getAnimations()
        .filter((animation) => animation instanceof globalThis.CSSTransition);
      if (running.length === 0) break;
      await Promise.allSettled(running.map((animation) => animation.finished));
    }
    for (const animation of globalThis.document.getAnimations()) {
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
      wash: colour('wash'),
      line: colour('line'),
      paper: colour('paper'),
      well: colour('well'),
      successIcon: colour('success-icon'),
      surface: colour('surface'),
      coral: colour('coral'),
      coralTint: colour('coral-tint'),
      error: colour('error'),
      errorText: colour('error-text'),
      // E11.5-11j, rule-7 rewrite: the library's panels are E2, not E1.
      panel: shadow('var(--shadow-2), var(--edge)'),
      ring: shadow('var(--ring-focus)'),
      insetLine: shadow('var(--inset-line)'),
      insetError: shadow('var(--inset-error)'),
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
        padding: css.paddingLeft,
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
async function assertDrawn(page, number, state, where, width) {
  const tokens = await resolveTokens(page);
  const css = await styles(page);
  const error = state.message !== undefined && !state.field;

  if (error) {
    assert.deepEqual(await text(page, selectors.note), [state.message], where);
    assert.equal(css.note.role, 'alert', where);
    // E11.5-11j, rule-7 rewrite: the library's 1.5px inset rule, not a 2px
    // border (ChangeLog "Notices · error rule").
    assert.deepEqual(css.note.borderWidths, Array(4).fill('0px'), where);
    assert.equal(css.note.shadow, tokens.insetError, where);
    assert.equal(css.note.padding, '16px', where);
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
    // E11.5-11j, rule-7 rewrite: the library's info notice, a quiet wash with
    // no edge and an ink-600 icon (Components.dc.html, Hero.dc.html).
    assert.deepEqual(css.note.borderWidths, Array(4).fill('0px'), where);
    assert.equal(css.note.shadow, 'none', where);
    assert.equal(css.note.padding, '16px', where);
    assert.equal(css.note.radius, '8px', where);
    assert.equal(css.note.background, tokens.wash, where);
    assert.equal(css.note.font, '14px/20px 500', where);
    assert.equal(css.note.color, tokens.ink, where);
    assert.equal(css.noteIcon.color, tokens.ink600, where);
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
    // E11.5-11j, rule-7 rewrite: the library's spinner is a ring in the label's
    // colour with a clear segment, not ink-300 with an ink top.
    assert.deepEqual(
      css.spinner.borders,
      [tokens.ink600, 'rgba(0, 0, 0, 0)', tokens.ink600, tokens.ink600],
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
    // E11.5-11j, rule-7 rewrite: the paused tile is the library's neutral tile.
    assert.equal(
      css.tile.background,
      state.paused ? tokens.wash : tokens.coralTint,
      where,
    );
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
    // E11.5-11m, rule-7 rewrite: the echo is on the well (paper in light,
    // midnight-deep in dark, Hero.dc.html), with an ink-600 mail icon.
    assert.equal(css.address.background, tokens.well, where);
    assert.equal(css.address.color, tokens.ink, where);
    assert.equal(css.addressIcon.color, tokens.ink600, where);
    assert.equal(
      await page.locator('[data-success-address] .icon--mail').count(),
      1,
      where,
    );
    // The actions sit over a 1px line.
    assert.equal(css.actionsRow.border, `1px solid ${tokens.line}`, where);
    assert.equal(css.address.shadow, tokens.insetLine, where);
    assert.equal(css.address.radius, '8px', where);
    // The secondary primitive: 16/24 and 20px padding from 48rem, 14/20
    // and 16px padding below (founder-authorised 2026-10-29).
    assert.equal(
      css.actions.font,
      width >= 768 ? '16px/24px 600' : '14px/20px 600',
      where,
    );
    assert.equal(css.actions.padding, width >= 768 ? '20px' : '16px', where);
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
      // E11.5-11m named rewrite (founder-authorised 2026-11-07): the canvas's
      // check-circle, not check (Hero.dc.html), in --success-icon.
      assert.equal(
        await page.locator('[data-resend-status] .icon--check-circle').count(),
        1,
        where,
      );
      assert.equal(css.resentIcon.color, tokens.successIcon, where);
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
          await assertDrawn(page, number, state, where, Number(width));
        } finally {
          await context.close();
        }
      }
    }
  });
}

// E11.5-11l: the hero entrance runs once per page load. A form shown again
// by "Use a different address" stays at rest instead of entering again.
test('after a signup, "Use a different address" shows the form at rest, with no second entrance', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openPage({
      html: giveawayOpenPage,
      viewport: viewports[width],
    });
    try {
      await reach(page, states[13]);
      await page.locator('[data-different-address]').click();
      await page.waitForSelector('valstara-signup-form form:visible');
      const form = await page.evaluate(() => {
        const element = globalThis.document.querySelector(
          'valstara-signup-form form',
        );
        const island = element.closest('valstara-signup-form');
        return {
          entering: island.querySelectorAll('[data-enter]').length,
          own: element.hasAttribute('data-enter'),
          animations: [...island.querySelectorAll('*')].flatMap((node) =>
            node
              .getAnimations()
              .filter(
                (animation) =>
                  animation instanceof globalThis.CSSAnimation &&
                  animation.animationName.startsWith('motion-enter'),
              ),
          ).length,
          translate: globalThis.getComputedStyle(element).translate,
        };
      });
      assert.deepEqual(
        form,
        { entering: 0, own: false, animations: 0, translate: 'none' },
        `${width}px`,
      );
    } finally {
      await context.close();
    }
  }
});

// E11.5-11m: the state motion. Each entrance or exit is a CSS transition of
// exactly its stated property, duration and start value, focus lands where
// E11.5-11g says both as the transition starts and once it has ended, and
// nothing focused is ever left mid-motion. The durations are the tokens.
const fast = 150;
const base = 200;

// The transitions a note shows on one target, as [property, duration, from,
// to], sorted.
function on(note, target) {
  return note.transitions
    .filter((entry) => entry.target === target)
    .map((entry) => [entry.property, entry.duration, entry.from, entry.to])
    .sort();
}

function note(notes, event, target) {
  const found = notes.find(
    (entry) => entry.event === event && entry.target === target,
  );
  assert.ok(found, `a ${event} change on ${target}`);
  return found;
}

// The page at rest: nothing transitions and the element is opaque, unmoved.
async function atRest(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const style = globalThis.getComputedStyle(element);
    return {
      opacity: style.opacity,
      translate: style.translate,
      scale: style.scale,
    };
  });
}

const rest = { opacity: '1', translate: 'none', scale: 'none' };

test('form to success and back: the form fades out, the panel enters, and focus lands as E11.5-11g says', async () => {
  for (const width of [1440, 390]) {
    const where = `${width}px`;
    const { context, page } = await openPage({
      html: giveawayOpenPage,
      viewport: viewports[width],
    });
    try {
      await recordStateMotion(page);
      const announcers = await page
        .locator(
          'valstara-signup-form [role="status"], valstara-signup-form [role="alert"], valstara-signup-form [aria-live]',
        )
        .count();
      await reach(page, states[13]);
      // Focus is on the panel as it enters, and the E11.5-11i guard accepts
      // the entering panel: its transitions end within --duration-base.
      assert.deepEqual(await focusMotionIssues(page), [], where);
      await transitionsEnded(page);
      let notes = await readStateMotion(page);
      const leaving = note(notes, 'leaving', 'form');
      assert.deepEqual(
        on(leaving, 'form'),
        [['opacity', fast, '1', '0']],
        `${where}: the form fades out over --duration-fast`,
      );
      const shown = note(notes, 'shown', '[data-success]');
      assert.ok(
        shown.t - leaving.t >= fast - 20,
        `${where}: the panel enters after the form has faded (${shown.t - leaving.t}ms)`,
      );
      assert.deepEqual(
        on(shown, '[data-success]'),
        [
          ['opacity', base, '0', '1'],
          ['translate', base, '0px 12px', 'none'],
        ],
        `${where}: the panel fades in and rises by --enter-distance`,
      );
      assert.deepEqual(
        on(shown, 'span.signup-success__tile'),
        [['scale', base, '0.9', 'none']],
        `${where}: the tile scales up from --enter-scale`,
      );
      assert.equal(shown.focus, '[data-success]', `${where}: focus on entry`);
      assert.equal(
        await page.evaluate(() =>
          globalThis.document.activeElement?.hasAttribute('data-success'),
        ),
        true,
        `${where}: focus after the transition`,
      );
      assert.deepEqual(await atRest(page, '[data-success]'), rest, where);
      assert.deepEqual(
        await atRest(page, '.signup-success__tile'),
        rest,
        where,
      );
      // It announces nothing extra: the island's live regions are the same.
      assert.equal(
        await page
          .locator(
            'valstara-signup-form [role="status"], valstara-signup-form [role="alert"], valstara-signup-form [aria-live]',
          )
          .count(),
        announcers,
        `${where}: no live region added`,
      );

      // "Use a different address" reverses the sequence.
      await page.evaluate(() => {
        globalThis.stateMotion.length = 0;
      });
      await page.locator('[data-different-address]').click();
      await page.locator('form').waitFor({ state: 'visible', timeout: 2_000 });
      assert.deepEqual(await focusMotionIssues(page), [], where);
      await transitionsEnded(page);
      notes = await readStateMotion(page);
      const exit = note(notes, 'leaving', '[data-success]');
      assert.deepEqual(
        on(exit, '[data-success]'),
        [
          ['opacity', base, '1', '0'],
          ['translate', base, 'none', '0px 12px'],
        ],
        `${where}: the panel fades out and sinks`,
      );
      assert.deepEqual(
        on(exit, 'span.signup-success__tile'),
        [['scale', base, 'none', '0.9']],
        `${where}: the tile shrinks back`,
      );
      const back = note(notes, 'returning', 'form');
      assert.ok(
        back.t - exit.t >= base - 20,
        `${where}: the form returns after the panel has left (${back.t - exit.t}ms)`,
      );
      assert.deepEqual(
        on(back, 'form'),
        [['opacity', fast, '0', '1']],
        `${where}: the form fades back in over --duration-fast`,
      );
      assert.equal(back.focus, '#signup-email', `${where}: focus on return`);
      assert.equal(
        await page.evaluate(() => globalThis.document.activeElement?.id),
        'signup-email',
        `${where}: focus after the transition`,
      );
      assert.deepEqual(await atRest(page, 'valstara-signup-form form'), rest);
    } finally {
      await context.close();
    }
  }
});

test('notices and field errors enter as the E11.5-11j field error does, with focus where E11.5-11g says', async () => {
  for (const [number, target, focus] of [
    ['03', '#signup-email-error', '#signup-email'],
    ['05', '#signup-email-error', '#signup-email'],
    ['09', '[data-form-error]', '[data-form-error]'],
    [12, '[data-form-error]', '[data-form-error]'],
  ]) {
    const where = `state ${number}`;
    const { context, page } = await openPage({
      html: giveawayOpenPage,
      viewport: viewports[1440],
    });
    try {
      await recordStateMotion(page);
      await reach(page, states[number]);
      assert.deepEqual(await focusMotionIssues(page), [], where);
      await transitionsEnded(page);
      const shown = note(await readStateMotion(page), 'shown', target);
      assert.deepEqual(
        on(shown, target),
        [
          ['opacity', fast, '0', '1'],
          ['translate', fast, '0px 4px', 'none'],
        ],
        `${where}: fades in and rises from --error-rise, nothing shakes`,
      );
      assert.equal(shown.focus, focus, `${where}: focus as it enters`);
      assert.equal(
        await page.evaluate(
          (selector) =>
            globalThis.document.activeElement ===
            globalThis.document.querySelector(selector),
          focus,
        ),
        true,
        `${where}: focus after the transition`,
      );
      assert.deepEqual(await atRest(page, target), rest, where);
    } finally {
      await context.close();
    }
  }
});

test('the resend control and the re-sent line fade in over --duration-base', async () => {
  const { context, page } = await openPage({
    html: giveawayOpenPage,
    viewport: viewports[390],
    resendSoon: true,
  });
  try {
    await recordStateMotion(page);
    await reach(page, states[15]);
    await transitionsEnded(page);
    const notes = await readStateMotion(page);
    assert.deepEqual(
      on(note(notes, 'shown', '[data-resend]'), '[data-resend]').filter(
        ([property]) => property === 'opacity',
      ),
      [['opacity', base, '0', '1']],
    );
    assert.deepEqual(
      on(note(notes, 'shown', '[data-resend-status]'), '[data-resend-status]'),
      [['opacity', base, '0', '1']],
    );
    assert.deepEqual(await atRest(page, '[data-resend]'), rest);
    assert.deepEqual(await atRest(page, '[data-resend-status]'), rest);
  } finally {
    await context.close();
  }
});

test('the in-flight button cross-fades its label and its name is only ever the current label', async () => {
  const { context, page } = await openPage({
    html: giveawayOpenPage,
    viewport: viewports[1440],
    turnstile: 'pending',
  });
  try {
    await recordStateMotion(page, { pauseOn: 'label' });
    await page.locator('#signup-email').fill(typed);
    await page.locator('[data-submit]').click();
    await page.waitForFunction(() =>
      globalThis.stateMotion.some((entry) => entry.event === 'label'),
    );
    const change = note(await readStateMotion(page), 'label', '[data-submit]');
    assert.deepEqual(
      on(change, '[data-submit]::after'),
      [['opacity', fast, '1', '0']],
      'the old label fades out',
    );
    assert.deepEqual(
      on(change, 'label'),
      [['opacity', fast, '0', '1']],
      'the new label fades in',
    );
    // Paused mid-fade: the old label is drawn, but neither the button's text
    // nor its accessible name carries it.
    const button = page.locator('[data-submit]');
    assert.equal(
      await button.evaluate(
        (element) => globalThis.getComputedStyle(element, '::after').content,
      ),
      `"${landingCopy.form.submit}" / ""`,
    );
    assert.equal(await button.textContent(), signupFormCopy.challengePending);
    assert.equal(
      await page
        .getByRole('button', {
          name: signupFormCopy.challengePending,
          exact: true,
        })
        .count(),
      1,
    );
    await resumeStateMotion(page);
    await transitionsEnded(page);
    await page.waitForFunction(
      () =>
        !globalThis.document
          .querySelector('[data-submit]')
          .hasAttribute('data-previous-label'),
    );
    assert.equal(
      await button.evaluate(
        (element) => globalThis.getComputedStyle(element, '::after').content,
      ),
      'none',
      'the old label is gone once the fade ends',
    );
  } finally {
    await context.close();
  }
});

test('with reduced motion the states swap at once: no transition runs and focus lands as before', async () => {
  for (const width of [1440, 390]) {
    const where = `${width}px`;
    const { context, page } = await openPage({
      html: giveawayOpenPage,
      viewport: viewports[width],
      reducedMotion: 'reduce',
      resendSoon: true,
    });
    try {
      await recordStateMotion(page);
      await reach(page, states['09']);
      await reach(page, states[15]);
      const notes = await readStateMotion(page);
      assert.ok(notes.length > 0, where);
      for (const entry of notes)
        assert.deepEqual(
          entry.transitions,
          [],
          `${where}: ${entry.event} ${entry.target}`,
        );
      // The form leaves and the panel shows in the same task.
      const leaving = note(notes, 'leaving', 'form');
      const shown = note(notes, 'shown', '[data-success]');
      assert.equal(shown.t, leaving.t, `${where}: no wait before the panel`);
      assert.equal(shown.focus, '[data-success]', where);
      // "Use a different address" brings the form back in the same task.
      assert.deepEqual(
        await page.evaluate(() => {
          const { document } = globalThis;
          document.querySelector('[data-different-address]').click();
          return {
            form: !document.querySelector('valstara-signup-form form').hidden,
            panel: document.querySelector('[data-success]').hidden,
            focus: document.activeElement?.id,
            running: document.getAnimations().length,
          };
        }),
        { form: true, panel: true, focus: 'signup-email', running: 0 },
        where,
      );
    } finally {
      await context.close();
    }
  }
});

// E11.5-11j: the notices' edges are box shadows, which forced-colours mode
// removes, so an outline is the only edge they have there.
test('a signup notice keeps a visible edge in forced-colours mode', async () => {
  const viewport = viewports[390];
  const notices = [
    ['[data-form-error]', giveawayOpenPage, true],
    [
      '[data-noscript] .signup-notice',
      await noScriptSnapshot(viewport, 'light'),
      false,
    ],
  ];
  for (const [selector, html, island] of notices) {
    const { context, page } = await openPage({
      html,
      viewport,
      island,
      forcedColors: 'active',
    });
    try {
      if (island) await reach(page, states['09']);
      assert.deepEqual(
        await page.locator(selector).evaluate((element) => {
          const style = globalThis.getComputedStyle(element);
          return {
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
          };
        }),
        { outlineStyle: 'solid', outlineWidth: '1px' },
        selector,
      );
    } finally {
      await context.close();
    }
  }
});

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
        assert.deepEqual(spinner, { animation: 'button-spin', running: 1 });
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
