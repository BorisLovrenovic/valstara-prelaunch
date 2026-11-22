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

import { leaderboardCopy } from '../src/copy/leaderboard.ts';
import { memberStatusCopy } from '../src/copy/member-status.ts';
import { referralLadderCopy } from '../src/copy/referral-ladder.ts';
import { createPool } from '../src/server/db/pool.ts';
import { flagCacheTtlMilliseconds } from '../src/server/flags/service.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { presentReferralStatus } from '../src/server/referral/status-presentation.ts';
import { verificationReferralFigures } from '../src/server/referral/verification-presentation.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import {
  checkPageLayout,
  designThemes,
  designWidths,
  enforcedPages,
} from '../scripts/design/layout-checks.mjs';
import { seedGiveawayEntryRows } from './helpers/giveaway-entry-rows.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { entranceEnded, focusMotionIssues } from './helpers/motion.mjs';
import {
  buildSelectors,
  measureMember,
} from './fixtures/final-ui/member-measure.mjs';
import {
  containerOwnerArguments,
  removeOrphanedContainers,
} from './helpers/container-owner.mjs';

// E11.5-08 built /me and /leaderboard; E11.5-11r restyles every state to the
// final-design canvas (Me.dc.html as Me1440, Me768 and Me390 place it, and
// Leaderboard.dc.html as Leaderboard1440 and Leaderboard390 place it) and
// adds its motion. Every box is compared with the canvas's own, measured
// from the pinned snapshot by
// test/fixtures/final-ui/measure-member-geometry.mjs on the self-hosted
// fonts, at rest (a reduced-motion context, design rule 12), with a 1px
// tolerance, in both themes.

const execFileAsync = promisify(execFile);
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = `valstara-member-final-playwright-${process.pid}`;
const canvas = JSON.parse(
  await readFile(
    new URL('./fixtures/final-ui/member-geometry.json', import.meta.url),
    'utf8',
  ),
);
const tolerance = 1;
const turnstileHost = 'challenges.cloudflare.com';

// The canvas's sample leaderboard (Leaderboard.dc.html renderVals): ten
// anonymous handles and exact counts, the snapshot at 06:40 UTC on 28
// October 2026, read three minutes later.
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
const snapshotBody = (count) => ({
  as_of: sampleAsOf,
  entries: sampleHandles.slice(0, count).map((handle, index) => ({
    confirmed_referrals: count === 3 ? [3, 2, 1][index] : sampleCounts[index],
    display_handle: handle,
    rank: index + 1,
  })),
});

let fixture;
let app;
let browser;
let browserServer;
let origin;
let localOrigin;

async function insertStatusToken(database, subscriberId, expiresAt) {
  const tokenId = randomUUID();
  const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET);
  await database.query(
    "INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'status',$4)",
    [
      tokenId,
      subscriberId,
      createHash('sha256').update(token).digest(),
      expiresAt,
    ],
  );
  return token;
}

// The canvas's sample members: the dashboard (four confirmed referrals,
// five giveaway entries, marketing on), the zero state (no wave, no
// referrals, no rewards, one entry), the same dashboard with marketing off
// (frame 03), a member who left, and an expired link. E11.7-04: the canvas's
// dashboard is in wave 2 with the retired tier's two rewards; under the
// coupon ladder four confirmed referrals hold coupon 1 at 5% and put a
// member verified in wave 2 into wave 1.
async function createFixture() {
  const name = 'valstara_member_final_' + randomUUID().replaceAll('-', '');
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
    ['tsx', 'src/server/db/run-migrations.ts', 'e11-5-11r-test'],
    {
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: fixtureUrl.toString(),
        VALSTARA_APP_DB_PASSWORD: appPassword,
      },
    },
  );
  const ids = {
    main: randomUUID(),
    zero: randomUUID(),
    off: randomUUID(),
    left: randomUUID(),
    other: randomUUID(),
  };
  const verified = (id, label, code, referrals, wave, marketing, order) =>
    database.query(
      `INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,referral_code,confirmed_referrals,access_window,marketing_consent_at,marketing_consent_version,marketing_consent_source,verification_order_window)
       VALUES ($1,$2,$2,'example.test','verified',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        `member-final-${label}@example.test`,
        new Date('2026-10-02T10:00:00Z'),
        code,
        referrals,
        wave,
        marketing ? new Date('2026-10-02T10:05:00Z') : null,
        marketing ? 'v1' : null,
        marketing ? 'member_status' : null,
        order,
      ],
    );
  await verified(ids.main, 'main', 'K7QX2MPR9AZB', 4, 'wave-1', true, 'wave-2');
  await verified(ids.zero, 'zero', 'ZERO23456789', 0, null, true, null);
  await verified(ids.off, 'off', 'OFFX23456789', 4, 'wave-1', false, 'wave-2');
  await verified(
    ids.other,
    'other',
    'OTHER2345678',
    9,
    'wave-1',
    true,
    'wave-3',
  );
  await database.query(
    "INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,unsubscribed_at,referral_code) VALUES ($1,$2,$2,'example.test','unsubscribed',$3,$3,'LEFT23456789')",
    [
      ids.left,
      'member-final-left@example.test',
      new Date('2026-10-02T12:00:00Z'),
    ],
  );
  const pool = createPool(fixtureUrl.toString());
  try {
    await seedGiveawayEntryRows(pool, ids.main, 5, { rulesVersion: '2026-09' });
    await seedGiveawayEntryRows(pool, ids.off, 5, { rulesVersion: '2026-09' });
    await seedGiveawayEntryRows(pool, ids.zero, 1, { rulesVersion: '2026-09' });
  } finally {
    await pool.close();
  }
  const future = new Date('2099-01-01T00:00:00Z');
  const tokens = {
    main: await insertStatusToken(database, ids.main, future),
    zero: await insertStatusToken(database, ids.zero, future),
    off: await insertStatusToken(database, ids.off, future),
    left: await insertStatusToken(database, ids.left, future),
    other: await insertStatusToken(database, ids.other, future),
    expired: await insertStatusToken(
      database,
      ids.main,
      new Date('2000-01-01T00:00:00Z'),
    ),
  };
  return {
    appUrl: appUrl.toString(),
    fixtureUrl: fixtureUrl.toString(),
    database,
    ids,
    tokens,
    async setFlag(key, enabled) {
      await database.query(
        "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ($1,$2,'e11-5-11r-test') ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled",
        [key, enabled],
      );
      // The app reads flags through its cache.
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, flagCacheTtlMilliseconds + 100),
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
    label: 'Member and leaderboard final design',
    readyPath: '/leaderboard',
    env: () => ({
      ADMIN_CREDENTIAL: 'member-final-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: fixture.appUrl,
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'member-final-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'member-final-referral-secret',
      RESEND_API_KEY: 'member-final-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      WEEKLY_SEND_UTC: '2@09:00',
    }),
  });
}

async function startBrowserServer() {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  await removeOrphanedContainers();
  browserServer = spawn(
    'docker',
    [
      'run',
      ...containerOwnerArguments(),
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

const mePath = (token) => `/me?t=${encodeURIComponent(token)}`;
const scrollTimelineQuery = /\(\s*animation-timeline\s*:\s*view\(\)\s*\)/gu;
const withoutScrollTimelines = (text) =>
  text.replace(scrollTimelineQuery, '(-x-unsupported-timeline: view())');

// Opens a page in a browser context. `motion` allows motion (otherwise the
// page is at rest, design rule 12); `share` gives the browser
// navigator.share; `clipboard: 'ok'` a clipboard that accepts (otherwise
// none, on this http origin, so a copy fails); `marketing` and `leaderboard`
// answer those routes in the browser (`leaderboard: 'hang'` never answers);
// `supported: false` renders without scroll-driven animations; `frozen`
// stops the animation clock before the page loads; `now` fixes the page's
// clock.
async function openPage({
  path,
  width = 1440,
  height = 900,
  theme = 'light',
  motion = false,
  javaScriptEnabled = true,
  share = false,
  clipboard = null,
  marketing = null,
  leaderboard = null,
  supported = true,
  frozen = false,
  now = null,
  hash = '',
  ready = null,
  html = null,
  open = false,
  answers = false,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: motion ? 'no-preference' : 'reduce',
    javaScriptEnabled,
  });
  // A context closed while a routed request is still in flight disposes its
  // response under the handler, whose late rejection would otherwise surface
  // as an unhandled rejection that fails the file. Each test has finished
  // asserting by the time it closes its context, so closing first unroutes
  // and drops those late handler errors.
  const closeContext = context.close.bind(context);
  context.close = async (options) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    return closeContext(options);
  };
  await context.route(`https://${turnstileHost}/**`, (route) => route.abort());
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
  const requests = [];
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push({ method: route.request().method(), path: url.pathname });
    if (html !== null && url.pathname === '/me')
      return route.fulfill({
        body: html,
        contentType: 'text/html; charset=utf-8',
      });
    if (url.pathname === '/api/me/marketing' && marketing !== null) {
      const answer =
        typeof marketing === 'function' ? await marketing(route) : marketing;
      if (answer === undefined) return undefined;
      return route.fulfill({
        status: answer.status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(answer.body),
      });
    }
    if (url.pathname === '/api/leaderboard' && leaderboard !== null) {
      if (leaderboard === 'hang') return new Promise(() => {});
      const answer =
        typeof leaderboard === 'function' ? leaderboard() : leaderboard;
      return route.fulfill({
        status: answer.status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(answer.body),
      });
    }
    // Every same-origin resource is served through the route: a document
    // the route fulfils counts as public to Chromium's Private Network
    // Access, which would otherwise block its stylesheets and fonts on this
    // local host.
    const response = await route.fetch();
    const type = response.headers()['content-type'] ?? '';
    if (supported || !/text\/(?:html|css)/u.test(type))
      return route.fulfill({ response });
    return route.fulfill({
      response,
      body: withoutScrollTimelines(await response.text()),
    });
  });
  const page = await context.newPage();
  if (now !== null) await page.clock.setFixedTime(now);
  if (frozen) {
    const session = await context.newCDPSession(page);
    await session.send('Animation.enable');
    await session.send('Animation.setPlaybackRate', { playbackRate: 0 });
  }
  await page.goto(`${origin}${path}${hash}`);
  await page.evaluate(() => globalThis.document.fonts.ready);
  if (ready !== null) await page.locator(ready).first().waitFor();
  if (open) await page.locator('details.member-survey summary').click();
  if (answers)
    // The board's sample answers (Me.dc.html renderVals): AI tools,
    // Software and Game keys, and Monthly.
    await page.evaluate(() => {
      for (const value of ['ai', 'software', 'game_keys', 'monthly']) {
        const input = globalThis.document.querySelector(
          `[data-survey-form] input[value="${value}"]`,
        );
        if (input !== null) input.checked = true;
      }
    });
  if (motion && !frozen) await entranceEnded(page);
  return { context, page, requests };
}

const leaderboardAnswers = {
  full: { status: 200, body: snapshotBody(10) },
  short: { status: 200, body: snapshotBody(3) },
  empty: { status: 200, body: { as_of: sampleAsOf, entries: [] } },
  unavailable: {
    status: 500,
    body: { error: { code: 'internal', message: 'unavailable' } },
  },
};

// How each canvas state is opened. A /me state at a width below 1024 gives
// the browser navigator.share, because the board draws Share link there
// (the build shows it wherever navigator.share exists, E11.5-08).
function stateOptions(board, state, width) {
  if (board === 'Leaderboard') {
    const ready = {
      full: '.leaderboard-entry',
      short: '.leaderboard-entry',
      empty: '[data-state="empty"]',
      loading: '[data-state="loading"]',
      paused: '[data-leaderboard-paused]',
      unavailable: '[data-state="unavailable"]',
    }[state];
    return {
      path: '/leaderboard',
      leaderboard:
        state === 'loading'
          ? 'hang'
          : state === 'paused'
            ? null
            : leaderboardAnswers[state],
      now: sampleNow,
      ready,
    };
  }
  const token = {
    dashboard: fixture.tokens.main,
    zero: fixture.tokens.zero,
    'prefs-saved': fixture.tokens.off,
    recovery: fixture.tokens.expired,
    'recovery-sent': fixture.tokens.expired,
    left: fixture.tokens.left,
    unavailable: fixture.tokens.main,
  }[state];
  return {
    path: mePath(token),
    share: width < 1024 && ['dashboard', 'zero', 'prefs-saved'].includes(state),
    hash: state === 'prefs-saved' ? '#marketing-saved' : '',
    // Frame 03 draws the survey disclosure open for re-answering.
    open: state === 'prefs-saved',
    answers: ['dashboard', 'zero', 'prefs-saved'].includes(state),
    ready: ['recovery', 'recovery-sent', 'left', 'unavailable'].includes(state)
      ? '.member-task__card'
      : '[data-member-dashboard]',
  };
}

// The recovery-sent state is the page a recovery POST renders. It is served
// from that POST at the same URL, so the test never depends on a send.
async function recoverySentHtml() {
  const response = await globalThis.fetch(
    `${localOrigin}${mePath(fixture.tokens.expired)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: localOrigin,
      },
      body: new globalThis.URLSearchParams({
        turnstile_token: 'member-final-turnstile-token',
      }),
    },
  );
  const html = await response.text();
  assert.match(html, new RegExp(memberStatusCopy.recovery.sent, 'u'));
  return html;
}

function measure(page) {
  return page.evaluate(measureMember, buildSelectors);
}

// Compares a measured structure with the canvas's, box by box, collecting
// every difference.
function canvasIssues(actual, expected, label, issues = []) {
  if (expected === null || actual === null || actual === undefined) {
    if ((actual ?? null) !== expected)
      issues.push(`${label} presence: ${JSON.stringify(actual)}`);
    return issues;
  }
  if (typeof expected === 'string') {
    if (actual !== expected)
      issues.push(`${label}: ${actual} is not ${expected}`);
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
// applied (docs/brand/page-design.md). Each is checked on its own here, so
// no box is left unmeasured.
function canvasFor(board, width, state, actual) {
  const expected = globalThis.structuredClone(
    canvas.boards[board][width][state],
  );
  if (board === 'Leaderboard') {
    const bottom = (item) => (item === null ? 0 : item[1] + item[3]);
    const { board: card, aside } = expected;
    // The column head ("Rank", "Handle", "Confirmed referrals") has no
    // copy-layer entry for "Handle", so it is not built (final-design rule
    // 5): every row and the meta line move up by its height, and the card's
    // content ends that much higher.
    const shift = card.head === null ? 0 : card.head[3];
    for (const key of ['rows', 'ranks', 'skeleton'])
      for (const item of card[key]) item[1] -= shift;
    if (card.meta !== null) card.meta[1] -= shift;
    card.head = null;
    const content = Math.max(
      bottom(card.meta),
      bottom(card.state),
      ...card.rows.map(bottom),
      ...card.skeleton.map(bottom),
    );
    if (state === 'loading') {
      // The board's skeleton rows are its list rows on the canvas; the
      // build keeps them apart from the ranked list, which is empty while
      // loading.
      card.rows = [];
      card.ranks = [];
    }
    if (state === 'paused') {
      // Founder decision 2026-11-11 (E11.5-11r decision 3): no side panel
      // with the switch off, so the card is its content's height rather
      // than stretched beside the panel, and the grid is the card.
      card.card[3] = content;
      expected.grid[3] = content;
      expected.aside = null;
    } else if (width >= 1024) {
      // Side by side, the row is as tall as the taller of the two.
      const row = Math.max(content, bottom(aside.panels.at(-1)));
      card.card[3] = row;
      aside.box[3] = row;
      expected.grid[3] = row;
    } else {
      // Stacked, the panel follows the card at the grid's gap.
      const gap =
        aside.box[1] - bottom(canvas.boards[board][width][state].board.card);
      card.card[3] = content;
      aside.box[1] = content + gap;
      expected.grid[3] = bottom(aside.box);
    }
    return expected;
  }
  if (expected.rewards !== undefined) {
    // E11.7-04: the canvas's rewards card shows the retired tier's two
    // rewards, one settled and one held. The build shows one row per coupon,
    // and every coupon is held, so each row takes the canvas's held row's
    // x, width and badge position, stacked from the canvas's first row, at
    // its own text's height. The coupons' held condition follows the rows
    // (or the empty note) 16px (--space-2) below, as wide as they are.
    const rows = expected.rewards.rows;
    const heldIndex = expected.rewards.states.indexOf('held');
    const template = rows[heldIndex] ?? null;
    const badge = expected.rewards.badges[heldIndex] ?? null;
    let top = rows[0]?.[1] ?? null;
    expected.rewards.rows = actual.rewards.rows.map((row) => {
      const placed = [template[0], top, template[2], row[3]];
      top += row[3];
      return placed;
    });
    expected.rewards.badges = actual.rewards.rows.map((row, index) => [
      badge[0],
      expected.rewards.rows[index][1] + badge[1] - template[1],
      badge[2],
      badge[3],
    ]);
    expected.rewards.states = actual.rewards.states;
    // The empty note names the first coupon's unlock, so it takes its own
    // text's height.
    if (expected.rewards.empty !== null)
      expected.rewards.empty[3] = actual.rewards.empty[3];
    const above = expected.rewards.rows.at(-1) ?? expected.rewards.empty;
    expected.rewards.held = [
      above[0],
      above[1] + above[3] + 16,
      above[2],
      actual.rewards.held[3],
    ];
  }
  if (expected.referral) {
    // Copy referral link cross-fades to "Referral link copied." in place
    // (E11.5-11q decision 3, inherited), so from 48rem the button is as wide
    // as its wider face and the link box gives up that width. Its right
    // edge, height and row are the canvas's. Below 48rem it is full width.
    const copy = expected.referral.copy;
    const built = actual.referral.copy;
    const grown = built[2] - copy[2];
    assert.ok(grown >= 0, `${width} ${state}: Copy referral link is narrower`);
    assert.ok(
      grown <= 32 + tolerance,
      `${width} ${state}: Copy referral link is ${grown}px wider than the board's`,
    );
    if (width < 768) assert.equal(grown, 0);
    expected.referral.copy = [copy[0] - grown, copy[1], built[2], copy[3]];
    expected.referral.linkbox[2] -= grown;
    // The meter draws one segment per referral the enabled tier needs: the
    // board's sample is "4 of 6 to Tier 2", the configured ladder's "3 of 3
    // to Tier 1". The figure is right-aligned at the board's right edge and
    // height, so only its width differs.
    const value = expected.referral.meterValue;
    const builtValue = actual.referral.meterValue;
    expected.referral.meterValue = [
      value[0] + value[2] - builtValue[2],
      value[1],
      builtValue[2],
      value[3],
    ];
  }
  if (expected.status && expected.referral && expected.rewards) {
    // E11.7-04: the ladder's words are longer than the retired tier's. The
    // meter value keeps its right edge and takes its own height, moving the
    // track down; the early-access line sits 24px (--space-3) under the
    // facts, as wide as they are; each card is then its content's height
    // plus the canvas's padding, cards side by side share the taller's
    // height, and every card below moves by what the cards above it grew.
    const bottom = (item) => item[1] + item[3];
    const referral = expected.referral;
    const meterGrow = actual.referral.meterValue[3] - referral.meterValue[3];
    referral.meterValue[3] += meterGrow;
    referral.track[1] += meterGrow;
    referral.well[3] += meterGrow;
    const facts = expected.status.facts;
    expected.status.access = [
      facts[0],
      bottom(facts) + 24,
      facts[2],
      actual.status.access[3],
    ];
    const sections = [
      expected.status.card,
      referral.card,
      expected.rewards.card,
      expected.preferences.card,
      expected.data.card,
      expected.leave.box,
    ];
    // A changed card's natural height is its last box's bottom plus the
    // card's padding, which is its head's inset.
    const naturalOf = new Map([
      [
        expected.status.card,
        bottom(expected.status.access) + expected.status.head[0],
      ],
      [referral.card, bottom(referral.well) + referral.head[0]],
      [
        expected.rewards.card,
        bottom(expected.rewards.held) + expected.rewards.head[0],
      ],
    ]);
    const old = sections.map((item) => [...item]);
    const natural = sections.map(
      (item, index) => naturalOf.get(item) ?? old[index][3],
    );
    // Cards in one row (the referral and rewards cards from 64rem) are
    // stretched to the taller; otherwise each is its own height.
    sections.forEach((item, index) => {
      const row = sections
        .map((other, otherIndex) => otherIndex)
        .filter((otherIndex) => old[otherIndex][1] === old[index][1]);
      item[3] =
        row.length > 1 && item !== expected.leave.box
          ? Math.max(...row.map((otherIndex) => natural[otherIndex]))
          : natural[index];
    });
    // A card keeps the canvas's gap to the row directly above it.
    sections.forEach((item, index) => {
      const above = old
        .map((before, otherIndex) => [before, sections[otherIndex]])
        .filter(([before]) => bottom(before) <= old[index][1]);
      if (above.length === 0) return;
      const nearest = Math.max(...above.map(([before]) => bottom(before)));
      item[1] += Math.max(
        ...above
          .filter(([before]) => bottom(before) === nearest)
          .map(([before, after]) => bottom(after) - bottom(before)),
      );
    });
    expected.grid[3] +=
      Math.max(...sections.map(bottom)) - Math.max(...old.map(bottom));
  }
  return expected;
}

// The states that need a flag off: /me's unavailable card and the paused
// leaderboard.
const flagStates = { Me: 'unavailable', Leaderboard: 'paused' };

async function measureStates(boardStates, issues) {
  for (const [board, state] of boardStates)
    for (const width of Object.keys(canvas.boards[board]).map(Number))
      for (const theme of designThemes) {
        const options = stateOptions(board, state, width);
        const { context, page } = await openPage({
          ...options,
          width,
          theme,
          html: state === 'recovery-sent' ? await recoverySentHtml() : null,
        });
        try {
          const actual = await measure(page);
          issues.push(
            ...canvasIssues(
              actual,
              canvasFor(board, width, state, actual),
              `${board} ${state} ${width} ${theme}`,
            ),
          );
        } finally {
          await context.close();
        }
      }
}

test('every /me and /leaderboard state matches the canvas at its widths, in both themes, at rest', async () => {
  const issues = [];
  const switchedOn = Object.entries(canvas.boards).flatMap(([board, widths]) =>
    Object.keys(widths[Object.keys(widths)[0]])
      .filter((state) => state !== flagStates[board])
      .map((state) => [board, state]),
  );
  await measureStates(switchedOn, issues);
  await fixture.setFlag('member.dashboard', false);
  await fixture.setFlag('leaderboard.public', false);
  try {
    await measureStates(Object.entries(flagStates), issues);
  } finally {
    await fixture.setFlag('member.dashboard', true);
    await fixture.setFlag('leaderboard.public', true);
  }
  assert.deepEqual(issues, []);
});

test('/me renders only the bearer’s data, every fact from the shared status computation, in today’s field order', async () => {
  const statusPool = createPool(fixture.fixtureUrl);
  let mainStatus;
  let zeroStatus;
  try {
    const referrals = createReferralService(statusPool);
    mainStatus = await referrals.status(fixture.ids.main);
    zeroStatus = await referrals.status(fixture.ids.zero);
  } finally {
    await statusPool.close();
  }
  for (const [token, status] of [
    [fixture.tokens.main, mainStatus],
    [fixture.tokens.zero, zeroStatus],
  ]) {
    const { context, page } = await openPage({
      path: mePath(token),
      ready: '[data-member-dashboard]',
    });
    try {
      const view = presentReferralStatus(status);
      const byKey = new Map(view.fields.map((field) => [field.key, field]));
      const keys = [
        'subscriberStatus',
        'accessWindow',
        'ownRank',
        'confirmedReferrals',
        'earlyAccess',
        ...(status.giveawayEntries > 0 ? ['giveawayEntries'] : []),
      ];
      // Every fact sits on the status card (E11.5-11r decision 1).
      assert.deepEqual(
        await page
          .locator('[data-member-card="status"] [data-member-field]')
          .evaluateAll((facts) =>
            facts.map((fact) => [
              fact.getAttribute('data-member-field'),
              fact.querySelector('dt').textContent.trim(),
              fact.querySelector('data')?.getAttribute('value') ??
                fact.querySelector('dd').textContent.trim(),
            ]),
          ),
        keys.map((key) => [key, byKey.get(key).label, byKey.get(key).value]),
      );
      assert.equal(
        await page.locator('[data-member-field]').count(),
        keys.length,
      );
      const ladder = verificationReferralFigures(status).ladder;
      assert.equal(
        (await page.locator('[data-meter-text]').textContent()).trim(),
        ladder.line,
      );
      assert.equal(
        await page.locator('.member-meter__segment').count(),
        ladder.meter.span,
      );
      assert.equal(
        await page.locator('.member-meter__segment.is-filled').count(),
        ladder.meter.progress,
      );
      // E11.7-04: early access, its reason or what earns it, and every
      // coupon with its first-order condition.
      assert.equal(
        (await page.locator('[data-early-access]').textContent()).trim(),
        view.earlyAccess.line,
      );
      assert.deepEqual(
        await page
          .locator('[data-coupon]')
          .evaluateAll((rows) =>
            rows.map((row) =>
              [...row.children]
                .map((part) => part.textContent.trim())
                .join(' '),
            ),
          ),
        view.coupons.map(
          ({ label, state, percent, condition }) =>
            `${label} ${state} ${percent} ${condition}`,
        ),
      );
      assert.equal(
        (await page.locator('[data-held-condition]').textContent()).trim(),
        view.ladder.held,
      );
      assert.equal(
        await page
          .locator('[data-referral-link]')
          .getAttribute('data-referral-url'),
        status.referralLink,
      );
      const html = await page.content();
      for (const other of [
        'OTHER2345678',
        fixture.ids.other,
        'member-final-other@example.test',
        ...(token === fixture.tokens.main
          ? ['ZERO23456789', fixture.ids.main, 'member-final-main@example.test']
          : ['K7QX2MPR9AZB', fixture.ids.zero]),
      ])
        assert.ok(!html.includes(other), other);
    } finally {
      await context.close();
    }
  }
  // A member with no entries shows no entries fact.
  await fixture.database.query(
    'UPDATE giveaway_entry SET voided_at = CURRENT_TIMESTAMP WHERE subscriber_id = $1',
    [fixture.ids.other],
  );
  const otherHtml = await (
    await globalThis.fetch(`${localOrigin}${mePath(fixture.tokens.other)}`)
  ).text();
  assert.doesNotMatch(otherHtml, /data-member-field="giveawayEntries"/u);
  assert.match(otherHtml, /data-member-field="earlyAccess"/u);
  assert.doesNotMatch(otherHtml, /data-member-field="tier"/u);
});

test('a held coupon is readable without colour: word, icon and a real outline, in both themes and in forced colours', async () => {
  for (const theme of designThemes)
    for (const forced of [false, true]) {
      const { context, page } = await openPage({
        path: mePath(fixture.tokens.main),
        theme,
        ready: '[data-member-dashboard]',
      });
      try {
        if (forced) await page.emulateMedia({ forcedColors: 'active' });
        const shapes = await page
          .locator('.member-reward__state')
          .evaluateAll((badges) =>
            badges.map((badge) => {
              const style = globalThis.getComputedStyle(badge);
              const path = badge.querySelector('svg path');
              return {
                text: badge.textContent.trim(),
                hidden: badge.querySelector('svg').getAttribute('aria-hidden'),
                paint: [path.getAttribute('fill'), path.getAttribute('stroke')],
                filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
                outline:
                  style.borderTopStyle !== 'none' &&
                  Number.parseFloat(style.borderTopWidth) > 0,
                why: badge
                  .closest('.member-reward')
                  .querySelector('.member-reward__why')
                  .textContent.trim(),
              };
            }),
          );
        // Four confirmed referrals hold coupon 1, and only coupon 1.
        assert.equal(shapes.length, 1);
        for (const shape of shapes) {
          assert.equal(shape.text, referralLadderCopy.heldState);
          assert.equal(shape.why, referralLadderCopy.heldShort);
          assert.equal(shape.hidden, 'true');
          assert.ok(shape.paint.includes('currentColor'));
          // Held is an outline, which forced colours keep.
          assert.equal(shape.outline, true, `${theme} forced ${forced}`);
          if (!forced) assert.equal(shape.filled, false);
        }
      } finally {
        await context.close();
      }
    }
});

test('the marketing switch is still the Turnstile form on the existing route, and only the current label is in the page', async () => {
  for (const [token, on] of [
    [fixture.tokens.main, true],
    [fixture.tokens.off, false],
  ]) {
    const html = await (
      await globalThis.fetch(`${localOrigin}${mePath(token)}`)
    ).text();
    const current = on
      ? memberStatusCopy.marketing.turnOff
      : memberStatusCopy.marketing.turnOn;
    const other = on
      ? memberStatusCopy.marketing.turnOn
      : memberStatusCopy.marketing.turnOff;
    assert.ok(html.includes(current));
    assert.ok(!html.includes(other), other);
    const form = html.match(
      /<form[^>]+action="\/api\/me\/marketing"[\s\S]*?<\/form>/u,
    )?.[0];
    assert.ok(form);
    assert.match(form, /method="post"/u);
    assert.match(form, /name="t" type="hidden"/u);
    assert.match(
      form,
      /class="cf-turnstile"[^>]*data-appearance="interaction-only"[^>]*data-response-field-name="turnstile_token"/u,
    );
    assert.equal((form.match(/<button\b/gu) ?? []).length, 1);
    const button = form.match(/<button\b[^>]*>/u)[0];
    assert.match(button, /type="submit"/u);
    assert.match(button, /name="marketing"/u);
    assert.match(button, new RegExp(`value="${on ? 'off' : 'on'}"`, 'u'));
    assert.match(button, /role="switch"/u);
    assert.match(button, new RegExp(`aria-checked="${on}"`, 'u'));
  }
  // The leave and recovery forms' Turnstile widgets render only when the
  // check needs interaction too (E11.5-11r decision 6).
  const mainHtml = await (
    await globalThis.fetch(`${localOrigin}${mePath(fixture.tokens.main)}`)
  ).text();
  const recoveryHtml = await (
    await globalThis.fetch(`${localOrigin}${mePath(fixture.tokens.expired)}`)
  ).text();
  for (const html of [mainHtml, recoveryHtml])
    for (const widget of html.match(/<div class="cf-turnstile"[^>]*>/gu))
      assert.match(widget, /data-appearance="interaction-only"/u);
  assert.equal((mainHtml.match(/<div class="cf-turnstile"/gu) ?? []).length, 2);
});

test('the switch posts the same fields, reloads with #marketing-saved on success and shows the saved notice, and an error puts it back', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const posted = [];
  const { context, page, requests } = await openPage({
    path: mePath(fixture.tokens.main),
    motion: true,
    ready: '[data-member-dashboard]',
    marketing: async (route) => {
      posted.push(route.request().postDataBuffer()?.toString() ?? '');
      await held;
      return {
        status: 200,
        body: { status: 'accepted', message: memberStatusCopy.marketing.saved },
      };
    },
  });
  try {
    await page.evaluate(() => {
      const field = globalThis.document.querySelector(
        '[data-marketing-form] [name="turnstile_token"]',
      );
      if (field === null) {
        const input = globalThis.document.createElement('input');
        input.type = 'hidden';
        input.name = 'turnstile_token';
        input.value = 'switch-test-token';
        globalThis.document
          .querySelector('[data-marketing-form] .cf-turnstile')
          .append(input);
      }
    });
    const toggle = page.locator('[data-marketing-switch]');
    const knob = page.locator('.member-switch__knob');
    const rest = await knob.evaluate(
      (element) => globalThis.getComputedStyle(element).transform,
    );
    await toggle.click();
    // While the request is in flight the knob slides to Off over
    // --duration-base (200ms) and the word cross-fades over --duration-fast
    // (150ms).
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('[data-marketing-switch]').dataset
          .switchState === 'off',
    );
    const pending = await page.evaluate(() => {
      const { document, getComputedStyle } = globalThis;
      const knobStyle = getComputedStyle(
        document.querySelector('.member-switch__knob'),
      );
      const words = document.querySelector('[data-marketing-words]');
      return {
        checked: document
          .querySelector('[data-marketing-switch]')
          .getAttribute('aria-checked'),
        knob: [knobStyle.transitionProperty, knobStyle.transitionDuration],
        word: getComputedStyle(words.querySelector('[data-marketing-state]'))
          .transitionDuration,
        next: words.querySelector('.member-switch__word--next')?.textContent,
        nextHidden: words.getAttribute('aria-hidden'),
      };
    });
    assert.equal(pending.checked, 'false');
    assert.match(pending.knob[0], /transform/u);
    assert.equal(pending.knob[1].split(',')[0].trim(), '0.2s');
    assert.equal(pending.word, '0.15s');
    assert.equal(pending.next, memberStatusCopy.marketing.disabled);
    assert.equal(pending.nextHidden, 'true');
    await page.waitForTimeout(250);
    assert.notEqual(
      await knob.evaluate(
        (element) => globalThis.getComputedStyle(element).transform,
      ),
      rest,
    );
    // The request is the existing one.
    assert.equal(posted.length, 1);
    const fields = new globalThis.URLSearchParams(
      posted[0].includes('Content-Disposition')
        ? [...posted[0].matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/gu)].map(
            ([, key, value]) => [key, value],
          )
        : posted[0],
    );
    assert.equal(fields.get('marketing'), 'off');
    assert.equal(fields.get('t'), fixture.tokens.main);
    assert.equal(fields.get('turnstile_token'), 'switch-test-token');
    // Success reloads, and the reloaded page shows the route's saved message,
    // focuses it and drops the fragment.
    const reloaded = page.waitForEvent('load');
    release();
    await reloaded;
    await page
      .locator('[data-marketing-result][data-result="success"]')
      .waitFor();
    assert.equal(
      (await page.locator('[data-marketing-status]').textContent()).trim(),
      memberStatusCopy.marketing.saved,
    );
    assert.equal(
      await page.evaluate(() =>
        globalThis.document.activeElement?.hasAttribute(
          'data-marketing-result',
        ),
      ),
      true,
    );
    assert.equal(await page.evaluate(() => globalThis.location.hash), '');
    assert.equal(
      requests.filter(({ path }) => path === '/me').length,
      2,
      'one load and one reload',
    );
  } finally {
    await context.close();
  }

  // An error: the switch returns, the route's message shows, no reload.
  for (const answer of [
    {
      status: 400,
      body: {
        error: {
          code: 'challenge_failed',
          message: memberStatusCopy.marketing.challengeFailed,
        },
      },
    },
    {
      status: 429,
      body: {
        error: {
          code: 'rate_limited',
          message: memberStatusCopy.marketing.rateLimited,
        },
      },
    },
  ]) {
    const errored = await openPage({
      path: mePath(fixture.tokens.main),
      ready: '[data-member-dashboard]',
      marketing: answer,
    });
    try {
      await errored.page.locator('[data-marketing-switch]').click();
      await errored.page
        .locator('[data-marketing-result][data-result="error"]')
        .waitFor();
      assert.equal(
        (
          await errored.page.locator('[data-marketing-status]').textContent()
        ).trim(),
        answer.body.error.message,
      );
      assert.equal(
        await errored.page
          .locator('[data-marketing-switch]')
          .getAttribute('data-switch-state'),
        'on',
      );
      assert.equal(
        await errored.page
          .locator('[data-marketing-switch]')
          .getAttribute('aria-checked'),
        'true',
      );
      assert.equal(
        errored.requests.filter(({ path }) => path === '/me').length,
        1,
      );
    } finally {
      await errored.context.close();
    }
  }
});

test('Copy referral link behaves as on /verify: it cross-fades to the copied line, announces it and returns; a refused copy selects the link', async () => {
  const copied = await openPage({
    path: mePath(fixture.tokens.main),
    motion: true,
    clipboard: 'ok',
    ready: '[data-member-dashboard]',
  });
  try {
    const { page } = copied;
    await page.clock.install();
    await page.locator('[data-copy-referral]').click();
    await page
      .locator('[data-copy-referral][data-copy-state="copied"]')
      .waitFor();
    assert.deepEqual(await page.evaluate(() => globalThis.copied), [
      await page
        .locator('[data-referral-link]')
        .getAttribute('data-referral-url'),
    ]);
    assert.equal(
      await page.locator('[data-copy-status]').textContent(),
      memberStatusCopy.referral.copied,
    );
    // Announced, not shown: the visible confirmation is the button's label.
    assert.notEqual(
      await page
        .locator('[data-copy-result]')
        .evaluate((element) => globalThis.getComputedStyle(element).clipPath),
      'none',
    );
    assert.equal(
      await page
        .locator('.member-copy__face--done')
        .evaluate(
          (element) => globalThis.getComputedStyle(element).transitionDuration,
        ),
      '0.15s',
    );
    await page.clock.runFor(2_100);
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('[data-copy-referral]').dataset
          .copyState === '',
    );
    assert.equal(await page.locator('[data-copy-status]').textContent(), '');
  } finally {
    await copied.context.close();
  }
  const refused = await openPage({
    path: mePath(fixture.tokens.main),
    ready: '[data-member-dashboard]',
  });
  try {
    const { page } = refused;
    await page.locator('[data-copy-referral]').click();
    await page.getByText(memberStatusCopy.referral.copyFailed).waitFor();
    assert.equal(
      await page.locator('[data-referral-link]').getAttribute('data-selected'),
      'true',
    );
    assert.equal(
      await page.evaluate(() => globalThis.getSelection().toString()),
      await page
        .locator('[data-referral-link]')
        .getAttribute('data-referral-url'),
    );
  } finally {
    await refused.context.close();
  }
});

test('the leaderboard is never padded, its counts are exact in every frame of the entrance, rows step by --stagger-row and end by 600ms, and a refresh does not animate', async () => {
  for (const count of [10, 3]) {
    let served = 0;
    const { context, page } = await openPage({
      path: '/leaderboard',
      motion: true,
      frozen: true,
      leaderboard: () => {
        served += 1;
        return { status: 200, body: snapshotBody(count) };
      },
      ready: '.leaderboard-entry',
      now: sampleNow,
    });
    try {
      const expected = snapshotBody(count).entries.map((entry) =>
        leaderboardCopy.confirmedReferrals(entry.confirmed_referrals),
      );
      const frames = await page.evaluate(async () => {
        const { document, getComputedStyle } = globalThis;
        const rows = [...document.querySelectorAll('.leaderboard-entry')];
        const animations = rows.map((row) => row.getAnimations()[0]);
        const timing = animations.map((animation) => ({
          name: animation.animationName,
          delay: Math.round(animation.effect.getComputedTiming().delay),
          end: Math.round(animation.effect.getComputedTiming().endTime),
        }));
        const samples = [];
        for (const time of [0, 50, 150, 300, 450, 580, 600]) {
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = time;
          }
          samples.push({
            time,
            counts: rows.map(
              (row) => row.querySelector('.leaderboard-count').textContent,
            ),
            opacity: rows.map((row) => Number(getComputedStyle(row).opacity)),
          });
        }
        const step = getComputedStyle(document.documentElement)
          .getPropertyValue('--stagger-row')
          .trim();
        return { timing, samples, step };
      });
      assert.equal(frames.step, '20ms');
      assert.equal(frames.timing.length, count, 'never padded');
      frames.timing.forEach(({ name, delay, end }, index) => {
        assert.equal(name, 'leaderboard-row-enter');
        assert.equal(delay, index * 20);
        assert.ok(end <= 600, `row ${index + 1} ends at ${end}`);
      });
      if (count === 10)
        assert.equal(Math.max(...frames.timing.map(({ end }) => end)), 580);
      for (const sample of frames.samples)
        assert.deepEqual(sample.counts, expected, `at ${sample.time}ms`);
      assert.ok(frames.samples[0].opacity.every((value) => value === 0));
      assert.ok(frames.samples.at(-1).opacity.every((value) => value === 1));
      // The next poll renders the snapshot again, without the entrance.
      await page.waitForFunction(() => true);
      const before = served;
      await page.waitForTimeout(6_000);
      assert.ok(served > before, 'the island polled again');
      assert.deepEqual(
        await page
          .locator('.leaderboard-entry')
          .evaluateAll((rows) =>
            rows.map(
              (row) =>
                row.hasAttribute('data-row-enter') ||
                row.getAnimations().length > 0,
            ),
          ),
        Array(count).fill(false),
      );
      assert.deepEqual(
        await page.locator('.leaderboard-count').allTextContents(),
        expected,
      );
    } finally {
      await context.close();
    }
  }
});

test('the leaderboard is still the third island, and a paused poll swaps the whole section for the paused card', async () => {
  const html = await (
    await globalThis.fetch(`${localOrigin}/leaderboard`)
  ).text();
  assert.equal((html.match(/<valstara-leaderboard\b/gu) ?? []).length, 1);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)];
  assert.equal(
    scripts.filter(([, content]) => content.includes('valstara-leaderboard'))
      .length,
    1,
  );
  // The paused card is never inside the flagged section.
  assert.doesNotMatch(
    html.slice(html.indexOf('data-leaderboard-section')),
    /data-leaderboard-paused(?![\w-])(?![\s\S]*<\/template>)/u,
  );
  const { context, page } = await openPage({
    path: '/leaderboard',
    leaderboard: {
      status: 503,
      body: { error: { code: 'unavailable', message: leaderboardCopy.paused } },
    },
    ready: '[data-leaderboard-paused]',
  });
  try {
    assert.equal(await page.locator('[data-leaderboard-section]').count(), 0);
    assert.equal(await page.locator('valstara-leaderboard').count(), 0);
    assert.equal(await page.locator('[data-leaderboard-counts]').count(), 0);
    assert.equal(await page.locator('[data-leaderboard-cta]').count(), 0);
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(
      (
        await page
          .locator('[data-leaderboard-paused] [role="status"]')
          .textContent()
      ).trim(),
      leaderboardCopy.paused,
    );
  } finally {
    await context.close();
  }
});

test('the status card enters (heading, facts, wave badge) within 600ms, the cards below reveal in order, and the meter fills on its view timeline with exact text', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openPage({
      path: mePath(fixture.tokens.main),
      width,
      motion: true,
      frozen: true,
      ready: '[data-member-dashboard]',
    });
    try {
      const motion = await page.evaluate(() => {
        const { document, getComputedStyle } = globalThis;
        const entering = [...document.querySelectorAll('[data-enter]')].map(
          (element) => {
            const [animation] = element.getAnimations();
            return [
              element.matches('.member-head')
                ? 'heading'
                : element.matches('.member-facts')
                  ? 'facts'
                  : element.matches('[data-access-wave]')
                    ? 'badge'
                    : element.tagName,
              element.getAttribute('data-enter'),
              getComputedStyle(element)
                .getPropertyValue('--enter-index')
                .trim(),
              animation?.animationName,
              Math.round(animation.effect.getComputedTiming().endTime),
            ];
          },
        );
        const revealing = [...document.querySelectorAll('[data-reveal]')].map(
          (element) => [
            element.getAttribute('data-member-card'),
            getComputedStyle(element).getPropertyValue('--reveal-index').trim(),
          ],
        );
        const fill = document.querySelector('.member-meter__fill');
        const [fillAnimation] = fill.getAnimations();
        return {
          entering,
          revealing,
          fill: {
            name: fillAnimation?.animationName,
            scroll: !(
              fillAnimation?.timeline instanceof globalThis.DocumentTimeline
            ),
            keyframes: fillAnimation?.effect
              .getKeyframes()
              .map((keyframe) => keyframe.transform ?? null),
          },
          meterText: document
            .querySelector('[data-meter-text]')
            .textContent.trim(),
          leave: document
            .querySelector('[data-member-card="leave"]')
            .getAnimations({ subtree: true }).length,
        };
      });
      assert.deepEqual(
        motion.entering.map((entry) => entry.slice(0, 4)),
        [
          ['heading', 'shift', '0', 'motion-enter-shift'],
          ['facts', 'shift', '1', 'motion-enter-shift'],
          ['badge', 'shift', '2', 'motion-enter-shift'],
        ],
      );
      assert.ok(motion.entering.every((entry) => entry[4] <= 600));
      assert.deepEqual(motion.revealing, [
        ['referral', '0'],
        ['rewards', '1'],
        ['preferences', '0'],
        ['data-rights', '1'],
      ]);
      assert.equal(motion.fill.name, 'member-meter-fill');
      assert.equal(motion.fill.scroll, true);
      assert.equal(motion.fill.keyframes[0], 'scaleX(0)');
      assert.equal(
        motion.meterText,
        'Coupon 1: 5% · 2 more confirmed referrals to 10%.',
      );
      assert.equal(motion.leave, 0, 'leaving has no motion');
    } finally {
      await context.close();
    }
  }
});

test('the cards reveal and are at rest by 70% of the viewport height and at the page end, at every design width', async () => {
  for (const width of designWidths) {
    const { context, page } = await openPage({
      path: mePath(fixture.tokens.main),
      width,
      motion: true,
      ready: '[data-member-dashboard]',
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
            problems.push(`${element.className} ${where}`);
        };
        const fills = [...document.querySelectorAll('.member-meter__fill')];
        for (const element of document.querySelectorAll('[data-reveal]')) {
          const top = element.getBoundingClientRect().top + globalThis.scrollY;
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
        for (const fill of fills)
          if (
            !['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(
              getComputedStyle(fill).transform,
            )
          )
            problems.push('meter fill at the end');
        return problems;
      });
      assert.deepEqual(issues, [], `${width}`);
    } finally {
      await context.close();
    }
  }
});

test('focus is never mid-motion: a keyboard walk through /me during its entrance and reveals', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openPage({
      path: mePath(fixture.tokens.main),
      width,
      motion: true,
      share: true,
      ready: '[data-member-dashboard]',
    });
    try {
      const issues = [];
      for (let step = 0; step < 60; step += 1) {
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

test('under reduced motion nothing moves on /me or /leaderboard, and without scroll-driven animations or with animations off everything is at rest', async () => {
  const rest = (page) =>
    page.evaluate(() => {
      const { document, getComputedStyle } = globalThis;
      return [
        ...document.querySelectorAll(
          '[data-enter], [data-reveal], .member-meter__fill, .leaderboard-entry',
        ),
      ]
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            what: String(element.className) || element.tagName,
            opacity: style.opacity,
            translate: style.translate,
            transform: style.transform,
          };
        })
        .filter(
          ({ opacity, translate, transform }) =>
            opacity !== '1' ||
            !['none', '0px', '0px 0px'].includes(translate) ||
            !['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(transform),
        );
    });
  const pages = [
    { path: mePath(fixture.tokens.main), ready: '[data-member-dashboard]' },
    {
      path: '/leaderboard',
      leaderboard: leaderboardAnswers.full,
      ready: '.leaderboard-entry',
    },
    {
      path: '/leaderboard',
      leaderboard: 'hang',
      ready: '[data-state="loading"]',
    },
  ];
  for (const width of [1440, 390])
    for (const options of pages) {
      const reduced = await openPage({ ...options, width });
      try {
        assert.equal(
          await reduced.page.evaluate(
            () => globalThis.document.getAnimations().length,
          ),
          0,
          options.path,
        );
        assert.deepEqual(await rest(reduced.page), []);
        assert.deepEqual(
          await reduced.page.evaluate(() =>
            [
              ...globalThis.document.querySelectorAll(
                '.member-switch__track, .member-switch__knob, .member-switch__word, .member-copy__face, .member-chip',
              ),
            ]
              .map((element) => globalThis.getComputedStyle(element))
              .filter((style) => style.transitionProperty !== 'none')
              .map((style) => style.transitionProperty),
          ),
          [],
        );
        // Turning the switch under reduced motion moves nothing.
        if (options.path.startsWith('/me')) {
          await reduced.page.evaluate(() => {
            globalThis.document.querySelector(
              '[data-marketing-switch]',
            ).dataset.switchState = 'off';
          });
          assert.equal(
            await reduced.page.evaluate(
              () => globalThis.document.getAnimations().length,
            ),
            0,
          );
        }
      } finally {
        await reduced.context.close();
      }
      const unsupported = await openPage({
        ...options,
        width,
        motion: true,
        supported: false,
      });
      try {
        await unsupported.page.waitForTimeout(700);
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
      const off = await openPage({
        ...options,
        width,
        motion: true,
        frozen: true,
      });
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

async function axeViolations(page) {
  await page.addScriptTag({ content: axe.source });
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

// Every state of both pages, as the user reaches it.
function everyState() {
  return [
    [
      'me-dashboard',
      { path: mePath(fixture.tokens.main), ready: '[data-member-dashboard]' },
    ],
    [
      'me-zero',
      { path: mePath(fixture.tokens.zero), ready: '[data-member-dashboard]' },
    ],
    [
      'me-saved-survey-open',
      {
        path: mePath(fixture.tokens.off),
        hash: '#marketing-saved',
        open: true,
        ready: '[data-marketing-result][data-result="success"]',
      },
    ],
    [
      'me-marketing-error',
      {
        path: mePath(fixture.tokens.main),
        ready: '[data-member-dashboard]',
        marketing: {
          status: 503,
          body: {
            error: {
              code: 'unavailable',
              message: memberStatusCopy.marketing.unavailable,
            },
          },
        },
        after: async (page) => {
          await page.locator('[data-marketing-switch]').click();
          await page
            .locator('[data-marketing-result][data-result="error"]')
            .waitFor();
        },
      },
    ],
    [
      'me-copy-failed',
      {
        path: mePath(fixture.tokens.main),
        ready: '[data-member-dashboard]',
        after: async (page) => {
          await page.locator('[data-copy-referral]').click();
          await page.locator('[data-copy-result="failed"]').waitFor();
        },
      },
    ],
    [
      'me-share',
      {
        path: mePath(fixture.tokens.main),
        share: true,
        ready: '.member-native-share',
      },
    ],
    [
      'me-recovery',
      { path: mePath(fixture.tokens.expired), ready: '.member-task__card' },
    ],
    [
      'me-left',
      { path: mePath(fixture.tokens.left), ready: '.member-task__card' },
    ],
    [
      'lb-full',
      {
        path: '/leaderboard',
        leaderboard: leaderboardAnswers.full,
        ready: '.leaderboard-entry',
      },
    ],
    [
      'lb-short',
      {
        path: '/leaderboard',
        leaderboard: leaderboardAnswers.short,
        ready: '.leaderboard-entry',
      },
    ],
    [
      'lb-empty',
      {
        path: '/leaderboard',
        leaderboard: leaderboardAnswers.empty,
        ready: '[data-state="empty"]',
      },
    ],
    [
      'lb-loading',
      {
        path: '/leaderboard',
        leaderboard: 'hang',
        ready: '[data-state="loading"]',
      },
    ],
    [
      'lb-unavailable',
      {
        path: '/leaderboard',
        leaderboard: leaderboardAnswers.unavailable,
        ready: '[data-state="unavailable"]',
      },
    ],
  ];
}

const flagOffStates = [
  ['me-unavailable', { path: '', ready: '[data-member-state="disabled"]' }],
  ['lb-paused', { path: '/leaderboard', ready: '[data-leaderboard-paused]' }],
];

async function checkEveryState(states, { layout, axeCheck }) {
  const issues = [];
  for (const width of layout ? designWidths : [390, 1440])
    for (const theme of designThemes)
      for (const [label, { after, ...options }] of states) {
        const { context, page } = await openPage({
          ...options,
          path: options.path || mePath(fixture.tokens.main),
          width,
          theme,
          html: label === 'me-recovery-sent' ? await recoverySentHtml() : null,
        });
        try {
          if (after) await after(page);
          if (layout)
            for (const issue of await checkPageLayout(page))
              issues.push(
                `${label} ${width} ${theme}: ${JSON.stringify(issue)}`,
              );
          if (axeCheck)
            for (const violation of await axeViolations(page))
              issues.push(`${label} ${width} ${theme}: axe ${violation}`);
        } finally {
          await context.close();
        }
      }
  return issues;
}

test('/me and /leaderboard stay in the enforced layout-check set, and every state passes the layout checks at every design width in both themes', async () => {
  assert.ok(enforcedPages.includes('/me'));
  assert.ok(enforcedPages.includes('/leaderboard'));
  const states = [
    ...everyState(),
    [
      'me-recovery-sent',
      { path: mePath(fixture.tokens.expired), ready: '.member-task__card' },
    ],
  ];
  const issues = await checkEveryState(states, { layout: true });
  await fixture.setFlag('member.dashboard', false);
  await fixture.setFlag('leaderboard.public', false);
  try {
    issues.push(...(await checkEveryState(flagOffStates, { layout: true })));
  } finally {
    await fixture.setFlag('member.dashboard', true);
    await fixture.setFlag('leaderboard.public', true);
  }
  assert.deepEqual(issues, []);
});

test('every /me and /leaderboard state passes WCAG axe in both themes', async () => {
  const states = [
    ...everyState(),
    [
      'me-recovery-sent',
      { path: mePath(fixture.tokens.expired), ready: '.member-task__card' },
    ],
  ];
  const issues = await checkEveryState(states, { axeCheck: true });
  await fixture.setFlag('member.dashboard', false);
  await fixture.setFlag('leaderboard.public', false);
  try {
    issues.push(...(await checkEveryState(flagOffStates, { axeCheck: true })));
  } finally {
    await fixture.setFlag('member.dashboard', true);
    await fixture.setFlag('leaderboard.public', true);
  }
  assert.deepEqual(issues, []);
});

test('both pages load nothing off-origin beyond the existing Turnstile script, set no cookie and write no storage', async () => {
  for (const options of [
    { path: mePath(fixture.tokens.main), ready: '[data-member-dashboard]' },
    {
      path: '/leaderboard',
      ready: 'valstara-leaderboard:not([data-state="loading"])',
    },
  ]) {
    const context = await browser.newContext();
    await context.route(`https://${turnstileHost}/**`, (route) =>
      route.abort(),
    );
    const page = await context.newPage();
    const hosts = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol.startsWith('http')) hosts.push(url.host);
    });
    try {
      await page.goto(`${origin}${options.path}`);
      await page.locator(options.ready).first().waitFor();
      assert.ok(
        hosts.every(
          (host) => host === new URL(origin).host || host === turnstileHost,
        ),
        hosts.join(', '),
      );
      assert.deepEqual(await context.cookies(), []);
      assert.deepEqual(
        await page.evaluate(() => [
          Object.keys(globalThis.localStorage).filter(
            (key) => key !== 'valstara-theme',
          ),
          Object.keys(globalThis.sessionStorage),
        ]),
        [[], []],
      );
    } finally {
      await context.close();
    }
  }
});
