import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import axe from 'axe-core';
import { chromium } from 'playwright';
import { Pool } from 'pg';

import {
  leaderboardCopy,
  leaderboardPanelCopy,
} from '../src/copy/leaderboard.ts';
import { memberStatusCopy } from '../src/copy/member-status.ts';
import { createPool } from '../src/server/db/pool.ts';
import { flagCacheTtlMilliseconds } from '../src/server/flags/service.ts';
import { createSharedLeaderboardSnapshotStore } from '../src/server/leaderboard/persisted.ts';
import { createRankingIntegrityService } from '../src/server/referral/ranking.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { presentReferralStatus } from '../src/server/referral/status-presentation.ts';
import { verificationReferralFigures } from '../src/server/referral/verification-presentation.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import {
  checkPageLayout,
  designThemes,
  designWidths,
  enforcedPages,
} from '../scripts/design/layout-checks.mjs';
import { captureContactSheet } from '../scripts/design/contact-sheet.mjs';
import { seedGiveawayEntryRows } from './helpers/giveaway-entry-rows.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';

const executeFile = promisify(execFile);
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const browserImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = 'valstara-member-design-' + process.pid;
const turnstileHost = 'challenges.cloudflare.com';

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

async function fixture() {
  const name = 'valstara_member_design_' + randomUUID().replaceAll('-', '');
  const adminUrl = new URL(databaseUrl);
  const fixtureUrl = new URL(adminUrl);
  fixtureUrl.pathname = '/' + name;
  const appUrl = new URL(fixtureUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  await admin.query('CREATE DATABASE "' + name + '"');
  const database = new Pool({ connectionString: fixtureUrl.toString() });
  try {
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'e11-5-08-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: fixtureUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    const ids = {
      member: randomUUID(),
      fresh: randomUUID(),
      left: randomUUID(),
      leader: randomUUID(),
      runnerUp: randomUUID(),
    };
    const verified = (id, email, code, referrals, wave, verifiedAt) =>
      database.query(
        "INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,referral_code,confirmed_referrals,access_window) VALUES ($1,$2,$2,'example.test','verified',$3,$4,$5,$6)",
        [id, email, verifiedAt, code, referrals, wave],
      );
    await verified(
      ids.member,
      'member-design@example.test',
      'MEMBER234567',
      2,
      'wave-2',
      new Date('2026-10-02T10:00:00Z'),
    );
    await verified(
      ids.fresh,
      'fresh-design@example.test',
      'FRESH2345678',
      0,
      null,
      new Date('2026-10-02T10:01:00Z'),
    );
    await verified(
      ids.leader,
      'leader-design@example.test',
      'LEADER234567',
      5,
      'wave-1',
      new Date('2026-10-02T09:00:00Z'),
    );
    await verified(
      ids.runnerUp,
      'runner-design@example.test',
      'RUNNER234567',
      2,
      'wave-3',
      new Date('2026-10-02T11:00:00Z'),
    );
    await database.query(
      "INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,unsubscribed_at,referral_code) VALUES ($1,$2,$2,'example.test','unsubscribed',$3,$3,'LEFT23456789')",
      [ids.left, 'left-design@example.test', new Date('2026-10-02T12:00:00Z')],
    );
    await database.query(
      "INSERT INTO milestone_award (id,subscriber_id,tier,reward_kind,state,awarded_at) VALUES ($1,$3,1,'wave_upgrade','settled',CURRENT_TIMESTAMP),($2,$3,1,'discount','held',CURRENT_TIMESTAMP)",
      [randomUUID(), randomUUID(), ids.member],
    );
    const pool = createPool(fixtureUrl.toString());
    try {
      await seedGiveawayEntryRows(pool, ids.member, 4, {
        rulesVersion: '2026-09',
      });
      await createSharedLeaderboardSnapshotStore(
        pool,
        createRankingIntegrityService(pool),
        () => new Date('2026-10-02T12:30:00.000Z'),
      ).refresh();
    } finally {
      await pool.close();
    }
    const future = new Date('2099-01-01T00:00:00Z');
    const tokens = {
      member: await insertStatusToken(database, ids.member, future),
      fresh: await insertStatusToken(database, ids.fresh, future),
      left: await insertStatusToken(database, ids.left, future),
      expired: await insertStatusToken(
        database,
        ids.member,
        new Date('2000-01-01T00:00:00Z'),
      ),
    };
    return {
      appUrl: appUrl.toString(),
      database,
      fixtureUrl: fixtureUrl.toString(),
      ids,
      tokens,
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
  } catch (error) {
    await database.end();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    await admin.query('DROP DATABASE "' + name + '"');
    await admin.end();
    throw error;
  }
}

async function startBrowser() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = spawn(
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
      root + ':/work:ro',
      '--workdir',
      '/work',
      browserImage,
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
  server.stdout.on('data', (chunk) => {
    output += chunk;
  });
  server.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (
    let attempt = 0;
    attempt < 240 && !output.includes('Listening on');
    attempt += 1
  ) {
    if (server.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  assert.match(output, /Listening on/u);
  const browserEndpoint =
    'ws://127.0.0.1:' + (await publishedPort(browserContainer, 3000)) + '/';
  return {
    server,
    browserEndpoint,
    browser: await chromium.connect(browserEndpoint),
  };
}

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

// Everything about a reward state that is not a colour: its words, its icon
// geometry and its outline style.
async function rewardStateShape(page, state) {
  return page
    .locator(`[data-reward-state="${state}"] .member-reward__state`)
    .evaluate((element) => {
      const style = globalThis.getComputedStyle(element);
      return {
        text: element.textContent.trim(),
        icon: element.querySelector('svg path')?.getAttribute('d') ?? null,
        border: style.borderTopStyle,
      };
    });
}

async function renderedFigure(page, selector) {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const style = globalThis.getComputedStyle(element);
      return {
        family: style.fontFamily,
        numeric: style.fontVariantNumeric,
        text: element.textContent.trim(),
      };
    });
}

test('the member page and the leaderboard render every state from their sources, accessibly', async () => {
  await executeFile('npm', ['run', 'build']);
  const data = await fixture();
  let app;
  let remote;
  try {
    app = await startAppServer({
      label: 'Member and leaderboard redesign',
      readyPath: '/leaderboard',
      env: () => ({
        ADMIN_CREDENTIAL: 'member-design-admin-credential-32-chars',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL: data.appUrl,
        HOST: '0.0.0.0',
        IP_PREFIX_PEPPER: 'member-design-prefix-pepper',
        REFERRAL_SIGNING_SECRET: 'member-design-referral-secret',
        RESEND_API_KEY: 'member-design-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        WEEKLY_SEND_UTC: '2@09:00',
      }),
    });
    remote = await startBrowser();
    const origin = 'http://host.docker.internal:' + app.port;
    const hostOrigin = 'http://127.0.0.1:' + app.port;
    assert.deepEqual(enforcedPages, ['/verify', '/me', '/leaderboard']);

    const mePath = (token) => '/me?t=' + encodeURIComponent(token);
    const fetchHtml = async (path) => {
      const response = await globalThis.fetch(hostOrigin + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('set-cookie'), null, path);
      return response.text();
    };

    // Every figure on the member card matches the shared status computation
    // the emails use.
    const statusPool = createPool(data.fixtureUrl);
    let memberStatus;
    let freshStatus;
    try {
      const referrals = createReferralService(statusPool);
      memberStatus = await referrals.status(data.ids.member);
      freshStatus = await referrals.status(data.ids.fresh);
    } finally {
      await statusPool.close();
    }
    const memberView = presentReferralStatus(memberStatus);
    assert.equal(memberStatus.giveawayEntries, 4);
    assert.equal(memberStatus.confirmedReferrals, 2);
    assert.equal(freshStatus.giveawayEntries, 0);

    const memberHtml = await fetchHtml(mePath(data.tokens.member));
    const freshHtml = await fetchHtml(mePath(data.tokens.fresh));
    for (const forbidden of [
      data.ids.member,
      data.ids.fresh,
      'member-design@example.test',
      'fresh-design@example.test',
      'FRESH2345678',
      'LEADER234567',
    ]) {
      assert.ok(!memberHtml.includes(forbidden), forbidden);
    }
    assert.ok(!freshHtml.includes('MEMBER234567'));

    const page = await remote.browser.newPage();
    const requests = [];
    // Only network requests matter; Turnstile's frame also loads about: and
    // blob: documents, which reach no host.
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol.startsWith('http')) requests.push(url.host);
    });
    await page.goto(origin + mePath(data.tokens.member));
    assert.deepEqual(
      await page
        .locator('[data-member-card]')
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-member-card')),
        ),
      [
        'status',
        'referral',
        'rewards',
        'entries',
        'preferences',
        'data-rights',
        'leave',
      ],
    );
    const renderedFields = await page
      .locator('[data-member-field]')
      .evaluateAll((fields) =>
        fields.map((field) => [
          field.getAttribute('data-member-field'),
          field.querySelector('dt').textContent.trim(),
          field.querySelector('data')?.getAttribute('value') ??
            field.querySelector('dd').textContent.trim(),
        ]),
      );
    const byKey = new Map(memberView.fields.map((field) => [field.key, field]));
    assert.deepEqual(
      renderedFields,
      [
        'subscriberStatus',
        'accessWindow',
        'ownRank',
        'confirmedReferrals',
        'tier',
        'giveawayEntries',
      ].map((key) => [key, byKey.get(key).label, byKey.get(key).value]),
    );
    assert.equal(
      (await page.locator('[data-access-wave]').textContent()).trim(),
      memberStatusCopy.authenticated.waveBadge(memberStatus.accessWindow),
    );
    const ladder = verificationReferralFigures(memberStatus).ladder;
    assert.equal(
      await page.locator('[data-referral-progress]').getAttribute('value'),
      String(ladder.progress),
    );
    assert.equal(
      await page.locator('[data-referral-progress]').getAttribute('max'),
      String(ladder.threshold),
    );
    assert.equal(
      (
        await page
          .locator('label[for="member-referral-progress"]')
          .textContent()
      ).trim(),
      memberStatusCopy.referral.progress(2, 3, 1),
    );
    assert.equal(
      await page.locator('[data-referral-link]').inputValue(),
      memberStatus.referralLink,
    );
    for (const key of ['ownRank', 'confirmedReferrals', 'giveawayEntries']) {
      const figure = await renderedFigure(
        page,
        `[data-member-field="${key}"] dd`,
      );
      assert.match(figure.family, /mono/iu, key);
      assert.equal(figure.numeric, 'tabular-nums', key);
    }

    // Held and settled stay distinguishable with colour removed.
    const settled = await rewardStateShape(page, 'settled');
    const held = await rewardStateShape(page, 'held');
    assert.equal(settled.text, memberStatusCopy.rewards.states.settled);
    assert.equal(held.text, memberStatusCopy.rewards.states.held);
    assert.ok(settled.icon !== null && held.icon !== null);
    assert.notEqual(settled.icon, held.icon);
    assert.notEqual(settled.border, held.border);
    for (const state of ['settled', 'held']) {
      const key = page.locator(`[data-reward-key="${state}"]`);
      assert.equal(await key.locator('svg path').count(), 1);
      assert.match(
        await key.textContent(),
        new RegExp(memberStatusCopy.rewards.explanations[state], 'u'),
      );
    }

    // The marketing switch is still the Turnstile form on its route; leaving
    // is one plain, separated action with no confirmation step.
    const marketing = page.locator('form[data-marketing-form]');
    assert.equal(await marketing.getAttribute('action'), '/api/me/marketing');
    assert.equal(await marketing.getAttribute('method'), 'post');
    assert.equal(
      await marketing
        .locator('.cf-turnstile[data-response-field-name="turnstile_token"]')
        .count(),
      1,
    );
    assert.equal(await marketing.locator('button').count(), 1);
    const marketingSwitch = marketing.locator('[data-marketing-switch]');
    assert.equal(await marketingSwitch.getAttribute('type'), 'submit');
    assert.equal(await marketingSwitch.getAttribute('name'), 'marketing');
    assert.equal(await marketingSwitch.getAttribute('value'), 'on');
    assert.match(
      await marketingSwitch.textContent(),
      new RegExp(memberStatusCopy.marketing.turnOn, 'u'),
    );
    assert.equal(
      (await marketing.locator('[data-marketing-state]').textContent()).trim(),
      memberStatusCopy.marketing.disabled,
    );
    const leave = page.locator('form[data-leave-form]');
    assert.equal(await page.locator('form[data-leave-form]').count(), 1);
    assert.equal(await leave.getAttribute('action'), '/api/me/leave');
    assert.equal(await leave.locator('button').count(), 1);
    assert.equal(
      await leave.locator('input[type="checkbox"], select').count(),
      0,
    );
    assert.equal(
      await leave
        .locator('.cf-turnstile[data-response-field-name="turnstile_token"]')
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator('[data-member-card="leave"]')
        .evaluate(
          (section) =>
            globalThis.getComputedStyle(section).borderTopStyle !== 'none' &&
            section.closest('.card') === null,
        ),
      true,
    );
    assert.doesNotMatch(memberHtml, /\bconfirm\(|beforeunload/u);
    assert.equal(
      await page.locator('details.member-survey').getAttribute('open'),
      null,
    );
    assert.deepEqual(
      await page
        .locator('[data-member-card="data-rights"] a')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
      ['/dsr?operation=export', '/dsr?operation=delete'],
    );
    await page.locator('[data-copy-referral]').click();
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('[data-copy-status]')?.textContent !==
        '',
    );
    assert.ok(
      requests.every(
        (host) => host === new URL(origin).host || host === turnstileHost,
      ),
      requests.join(', '),
    );
    assert.deepEqual(await page.context().cookies(), []);
    await page.close();

    // A member with no entries and no rewards gets no entries card, and their
    // progress still comes from the ladder.
    assert.doesNotMatch(freshHtml, /data-member-card="entries"/u);
    assert.match(freshHtml, new RegExp(memberStatusCopy.rewards.empty, 'u'));
    assert.match(freshHtml, />\s*0 of 3 to Tier 1\s*</u);
    assert.match(
      freshHtml,
      new RegExp(memberStatusCopy.authenticated.wavePending, 'u'),
    );
    assert.doesNotMatch(freshHtml, /data-access-wave/u);

    const recoveryHtml = await fetchHtml(mePath(data.tokens.expired));
    assert.match(recoveryHtml, /data-member-state="recovery"/u);
    assert.match(recoveryHtml, /<form method="post"/u);
    assert.equal(
      recoveryHtml,
      await fetchHtml(mePath('tampered-member-design-token')),
    );
    const leftHtml = await fetchHtml(mePath(data.tokens.left));
    assert.match(leftHtml, /data-member-state="left"/u);
    assert.doesNotMatch(leftHtml, /data-member-dashboard/u);

    // The leaderboard: the snapshot as stored, short and unpadded, with its age.
    // The web process loads the persisted snapshot into its cache on demand.
    let snapshot;
    for (let attempt = 0; attempt < 60 && !snapshot?.entries; attempt += 1) {
      if (attempt > 0)
        await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
      snapshot = await (
        await globalThis.fetch(hostOrigin + '/api/leaderboard')
      ).json();
    }
    // Four verified, unflagged people: a short board, never padded to ten.
    assert.equal(snapshot.entries.length, 4);
    const board = await remote.browser.newPage();
    const boardRequests = [];
    board.on('request', (request) =>
      boardRequests.push(new URL(request.url()).host),
    );
    await board.goto(origin + '/leaderboard');
    await board.locator('.leaderboard-entry').first().waitFor();
    assert.equal(await board.locator('.leaderboard-entry').count(), 4);
    assert.deepEqual(
      await board
        .locator('.leaderboard-entry')
        .evaluateAll((rows) =>
          rows.map((row) => [
            row.querySelector('.leaderboard-rank').textContent,
            row.querySelector('.leaderboard-handle').textContent,
            row.querySelector('.leaderboard-count').textContent,
          ]),
        ),
      snapshot.entries.map((entry) => [
        leaderboardCopy.rank(entry.rank),
        leaderboardCopy.handle(entry.display_handle),
        leaderboardCopy.confirmedReferrals(entry.confirmed_referrals),
      ]),
    );
    for (const selector of [
      '.leaderboard-rank-figure',
      '.leaderboard-count-figure',
    ]) {
      const figure = await renderedFigure(board, selector);
      assert.match(figure.family, /mono/iu, selector);
      assert.equal(figure.numeric, 'tabular-nums', selector);
    }
    const meta = await board.locator('[data-leaderboard-meta]').textContent();
    assert.match(meta, new RegExp(leaderboardCopy.snapshotAsOf, 'u'));
    assert.match(meta, /Snapshot age: \d+ (?:seconds?|minutes?)\./u);
    assert.deepEqual(
      (
        await board.locator('[data-leaderboard-counts] li').allTextContents()
      ).map((line) => line.trim()),
      leaderboardPanelCopy.counts.lines,
    );
    const join = board.locator('[data-leaderboard-cta] a');
    assert.equal(await join.getAttribute('href'), '/#join');
    assert.equal(
      (await join.textContent()).trim(),
      leaderboardPanelCopy.cta.join,
    );
    assert.equal(
      await board
        .locator('[data-leaderboard-section] [data-leaderboard-cta]')
        .count(),
      1,
    );
    assert.ok(boardRequests.every((host) => host === new URL(origin).host));
    await board.close();

    // Layout checks and axe on every state, at every width, in both themes.
    const states = [
      ['member', mePath(data.tokens.member), '[data-member-dashboard]'],
      ['member-new', mePath(data.tokens.fresh), '[data-member-dashboard]'],
      ['member-recovery', mePath(data.tokens.expired), '.member-boundary'],
      ['member-left', mePath(data.tokens.left), '.member-boundary'],
      ['leaderboard', '/leaderboard', '.leaderboard-entry'],
    ];
    const checkStates = async (entries) => {
      for (const width of designWidths) {
        for (const theme of designThemes) {
          for (const [label, path, ready] of entries) {
            const context = await remote.browser.newContext({
              viewport: { width, height: 900 },
              colorScheme: theme,
            });
            try {
              const statePage = await context.newPage();
              await statePage.goto(origin + path);
              await statePage.locator(ready).first().waitFor();
              assert.deepEqual(
                await checkPageLayout(statePage),
                [],
                label + ' at ' + width + 'px in ' + theme,
              );
              if (label === 'member') {
                await statePage
                  .locator('details.member-survey summary')
                  .click();
                assert.deepEqual(
                  await checkPageLayout(statePage),
                  [],
                  label + ' survey open at ' + width + 'px in ' + theme,
                );
              }
              if (width === 390 || width === 1440) {
                assert.deepEqual(
                  await axeViolations(statePage),
                  [],
                  label + ' axe at ' + width + 'px in ' + theme,
                );
              }
            } finally {
              await context.close();
            }
          }
        }
      }
    };
    await checkStates(states);

    const captures = await captureContactSheet({
      origin,
      browserEndpoint: remote.browserEndpoint,
      output: '.design-contact-sheets/e11-5-08',
      entries: [
        { route: mePath(data.tokens.member), state: 'me-dashboard' },
        {
          route: mePath(data.tokens.member),
          state: 'me-dashboard-survey-open',
          actions: [
            { action: 'click', selector: 'details.member-survey summary' },
          ],
        },
        { route: mePath(data.tokens.fresh), state: 'me-new-member' },
        { route: mePath(data.tokens.expired), state: 'me-recovery' },
        { route: mePath(data.tokens.left), state: 'me-left' },
        {
          route: '/leaderboard',
          state: 'leaderboard',
          actions: [
            { action: 'waitFor', selector: '.leaderboard-entry:first-child' },
          ],
        },
      ],
    });
    assert.equal(
      captures.length,
      designWidths.length * designThemes.length * 6,
    );
    assert.ok(captures.every((capture) => capture.layoutIssues.length === 0));

    // With member.dashboard off, /me renders its unavailable card and nothing
    // of the bearer's status.
    await data.database.query(
      "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ('member.dashboard',false,'e11-5-08-test')",
    );
    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, flagCacheTtlMilliseconds + 100),
    );
    const disabledResponse = await globalThis.fetch(
      hostOrigin + mePath(data.tokens.member),
    );
    const disabledHtml = await disabledResponse.text();
    assert.equal(disabledResponse.status, 200);
    assert.match(disabledHtml, /data-member-state="disabled"/u);
    assert.doesNotMatch(disabledHtml, /MEMBER234567|data-member-dashboard/u);
    for (const width of designWidths) {
      for (const theme of designThemes) {
        const context = await remote.browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        try {
          const disabledPage = await context.newPage();
          await disabledPage.goto(origin + mePath(data.tokens.member));
          assert.deepEqual(
            await checkPageLayout(disabledPage),
            [],
            'member-disabled at ' + width + 'px in ' + theme,
          );
          if (width === 390 || width === 1440)
            assert.deepEqual(
              await axeViolations(disabledPage),
              [],
              'member-disabled axe in ' + theme,
            );
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await remote?.browser.close();
    await executeFile('docker', ['rm', '--force', browserContainer]).catch(
      () => {},
    );
    if (remote?.server.exitCode === null) {
      const exited = once(remote.server, 'exit');
      remote.server.kill('SIGTERM');
      await exited;
    }
    await app?.stop();
    await data.dispose();
  }
});
