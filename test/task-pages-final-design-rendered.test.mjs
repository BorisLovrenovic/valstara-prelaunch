// E11.5-11t: the final-design task pages (Task.dc.html and its placements on
// TaskUnsubDsr1440/390, Award1440/390 and Errors). Asserts /dsr's own POST
// and every outcome it renders, the award checks step's country field error,
// the canvas geometry at rest at 390 and 1440 in both themes, the entrance
// and the outcome fade with motion allowed, nothing moving under reduced
// motion, focus never mid-motion, the layout checks and axe.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import axe from 'axe-core';
import { chromium } from 'playwright';
import { Pool } from 'pg';
import { dsrCopy } from '../src/copy/dsr.ts';
import { giveawayAwardCopy } from '../src/copy/giveaway-award.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import {
  atRest,
  atRestContext,
  checkPageLayout,
  designThemes,
} from '../scripts/design/layout-checks.mjs';
import { entranceEnded, focusMotionIssues } from './helpers/motion.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const browserImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = 'valstara-task-final-' + process.pid;
const rulesVersion = 'VAL-GW-LAUNCH-20261009-r1';
// The canvas draws the task pages at these two widths.
const canvasWidths = [390, 1440];
const offer = {
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

function token(id) {
  return deriveEmailToken(id, process.env.EMAIL_TOKEN_SECRET);
}

async function insertToken(database, subscriberId, purpose) {
  const id = randomUUID();
  const value = token(id);
  await database.query(
    "INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,$4,'2099-01-01T00:00:00Z')",
    [id, subscriberId, createHash('sha256').update(value).digest(), purpose],
  );
  return value;
}

async function fixture() {
  const name = 'valstara_task_final_' + randomUUID().replaceAll('-', '');
  const adminUrl = new URL(databaseUrl);
  const fixtureUrl = new URL(adminUrl);
  fixtureUrl.pathname = '/' + name;
  const appUrl = new URL(fixtureUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  await admin.query('CREATE DATABASE "' + name + '"');
  const database = new Pool({ connectionString: fixtureUrl.toString() });
  const dispose = async () => {
    await database.end();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    await admin.query('DROP DATABASE "' + name + '"');
    await admin.end();
  };
  try {
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'e11-5-11t-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: fixtureUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    const winnerId = randomUUID();
    const exporterId = randomUUID();
    const eraserId = randomUUID();
    await database.query(
      "INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,referral_code,access_window) VALUES ($1,'task-final-winner@example.test','task-final-winner@example.test','example.test','verified','2026-10-01T00:00:00Z','TFWINNER2345','wave-1'),($2,'task-final-export@example.test','task-final-export@example.test','example.test','verified','2026-10-01T00:00:00Z','TFEXPORT2345','wave-1'),($3,'task-final-erase@example.test','task-final-erase@example.test','example.test','verified','2026-10-01T00:00:00Z','TFERASER2345','wave-1')",
      [winnerId, exporterId, eraserId],
    );
    const unsubscribeId = randomUUID();
    const unsubscribe = token(unsubscribeId);
    await database.query(
      "INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'unsubscribe','2099-01-01T00:00:00Z')",
      [
        unsubscribeId,
        winnerId,
        createHash('sha256').update(unsubscribe).digest(),
      ],
    );
    await database.query(
      "INSERT INTO email_send (id,subscriber_id,template,provider,business_key,state,unsubscribe_token_id) VALUES ($1,$2,'status_link','resend',$3,'sent',$4)",
      [randomUUID(), winnerId, randomUUID(), unsubscribeId],
    );
    const winnerStatus = await insertToken(database, winnerId, 'status');
    const exportToken = await insertToken(database, exporterId, 'dsr_export');
    const deleteToken = await insertToken(database, eraserId, 'dsr_delete');

    await database.query(
      "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ('giveaway.open',true,'task-final-test') ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled",
    );
    const drawId = randomUUID();
    const entryId = randomUUID();
    await database.query(
      "INSERT INTO giveaway_draw (id,executed_by) VALUES ($1,'task-final-test')",
      [drawId],
    );
    await database.query(
      "INSERT INTO giveaway_entry (id,subscriber_id,method,entries,rules_version,rules_sha256) VALUES ($1,$2,'base',1,$3,decode($4,'hex'))",
      [entryId, winnerId, rulesVersion, 'ab'.repeat(32)],
    );
    await database.query(
      "INSERT INTO giveaway_draw_snapshot_row (draw_id,entry_id,subscriber_id,method,rules_version,rules_sha256) VALUES ($1,$2,$3,'base',$4,decode($5,'hex'))",
      [drawId, entryId, winnerId, rulesVersion, 'ab'.repeat(32)],
    );
    await database.query(
      'INSERT INTO giveaway_draw_selection (draw_id,position,subscriber_id,entry_id,is_winner) VALUES ($1,1,$2,$3,true)',
      [drawId, winnerId, entryId],
    );
    await database.query(
      "UPDATE giveaway_draw SET snapshot_committed_at='2026-10-01T00:00:00Z', entry_snapshot_hash=decode($2,'hex'), snapshot_count=1, prize_count=1, rules_version=$3, rules_sha256=decode($4,'hex'), drand_chain_hash=decode($5,'hex'), drand_chain_info='{}'::jsonb, target_round=1, target_round_at='2026-10-01T00:06:00Z' WHERE id=$1",
      [drawId, 'cd'.repeat(32), rulesVersion, 'ab'.repeat(32), 'ef'.repeat(32)],
    );
    await database.query(
      "UPDATE giveaway_draw SET state='published', seed=$2, seed_generated_at='2026-10-01T00:01:00Z', beacon_round=1, beacon_randomness=decode($3,'hex'), beacon_signature=decode($4,'hex'), beacon_relay_used='test', beacon_verified_relays='[\"one\",\"two\"]'::jsonb, winners=$5::jsonb, reproduced_at='2026-10-01T00:02:00Z', published_at='2026-10-01T00:02:00Z' WHERE id=$1",
      [
        drawId,
        'ab'.repeat(32),
        '12'.repeat(32),
        '34'.repeat(48),
        JSON.stringify([winnerId]),
      ],
    );
    const awardId = randomUUID();
    await database.query(
      "INSERT INTO giveaway_award (id,draw_id,prize_slot,entry_snapshot_hash,selection_position,entry_id,subscriber_id,notified_at,response_deadline_at) VALUES ($1,$2,1,decode($3,'hex'),1,$4,$5,'2026-10-01T00:03:00Z','2099-01-01T00:00:00Z')",
      [awardId, drawId, 'cd'.repeat(32), entryId, winnerId],
    );
    return {
      appUrl: appUrl.toString(),
      awardId,
      database,
      deleteToken,
      dispose,
      exporterId,
      exportToken,
      unsubscribe,
      winnerStatus,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

// Turnstile's siteverify, stubbed inside the app process: one token is
// rejected, one finds the provider down, every other one passes.
const siteverifyStub = `data:text/javascript,${encodeURIComponent(`
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
      const body = String(init?.body ?? '');
      if (body.includes('turnstile-reject'))
        return Response.json({ success: false, 'error-codes': ['invalid-input-response'] });
      if (body.includes('turnstile-down'))
        return new Response('down', { status: 503 });
      return Response.json({ success: true });
    }
    return realFetch(input, init);
  };
`)}`;

function appEnvironment(databaseUrlForApp, alertPort) {
  return () => ({
    P1_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertPort}/alert`,
    P1_ALERT_WEBHOOK_TOKEN: 'task-final-alert-token',
    ADMIN_CREDENTIAL: 'task-final-admin-credential-32-chars',
    ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    DATABASE_URL: databaseUrlForApp,
    HOST: '0.0.0.0',
    IP_PREFIX_PEPPER: 'task-final-prefix-pepper',
    REFERRAL_SIGNING_SECRET: 'task-final-referral-secret',
    RESEND_API_KEY: 'task-final-resend-key',
    RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
    RESEND_KEY_MODE: 'test',
    RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
    RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
    RESEND_SENDING_DOMAIN: 'send.valstara.com',
    TURNSTILE_SECRET_KEY: 'task-final-turnstile-secret',
  });
}

async function startBrowser() {
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
  try {
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
    return { server, browser: await chromium.connect(browserEndpoint) };
  } catch (error) {
    await executeFile('docker', ['rm', '--force', browserContainer]).catch(
      () => {},
    );
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    throw error;
  }
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

// The task card (the `data-task-state` article).
function card(html, state) {
  const start = html.indexOf(`data-task-state="${state}"`);
  assert.notEqual(start, -1, `task card ${state} renders`);
  const open = html.lastIndexOf('<article', start);
  return html.slice(open, html.indexOf('</article>', start));
}

// Boxes of the card's parts, relative to the viewport, plus the theme
// colours the tile and notices resolve to.
function measureCard() {
  const { document, getComputedStyle } = globalThis;
  const box = (element) => {
    if (element === null) return null;
    const style = getComputedStyle(element);
    if (style.display === 'none' || element.getClientRects().length === 0)
      return null;
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
      right: rect.right,
    };
  };
  const probe = (value) => {
    const element = document.createElement('div');
    element.style.backgroundColor = value;
    document.body.append(element);
    const colour = getComputedStyle(element).backgroundColor;
    element.remove();
    return colour;
  };
  const article = document.querySelector('[data-task-state]');
  const style = getComputedStyle(article);
  // The nearest drawn box before an element: its previous drawn sibling, or
  // its parent's, inside the card.
  const visibleBefore = (element) => {
    for (let node = element; node !== article; node = node.parentElement) {
      let sibling = node.previousElementSibling;
      while (sibling !== null && box(sibling) === null)
        sibling = sibling.previousElementSibling;
      if (sibling !== null) return box(sibling);
    }
    return null;
  };
  const actions = article.querySelector('.task-card__actions');
  const leadNotice = article.querySelector(':scope > .task-card__notice');
  const link = article.querySelector('.task-card__link');
  const tile = article.querySelector('.task-card__tile');
  return {
    main: box(document.querySelector('main')),
    footer: box(document.querySelector('body > footer')),
    container: box(article.closest('[data-design-container]')),
    card: box(article),
    padding: [style.paddingTop, style.paddingLeft],
    tile: box(tile),
    tileColour: getComputedStyle(tile).backgroundColor,
    tileTones: {
      accent: probe('var(--coral-tint)'),
      neutral: probe('var(--wash)'),
      success: probe('var(--success-tint)'),
      error: probe('var(--error-tint)'),
    },
    heading: box(article.querySelector('h1')),
    headingType: [
      getComputedStyle(article.querySelector('h1')).fontSize,
      getComputedStyle(article.querySelector('h1')).fontWeight,
      getComputedStyle(article.querySelector('h1')).paddingTop,
    ],
    head: box(article.querySelector('.task-card__head')),
    line: box(article.querySelector('.task-card__line')),
    notice: box(leadNotice),
    noticeShadow:
      leadNotice === null ? null : getComputedStyle(leadNotice).boxShadow,
    noticeBackground:
      leadNotice === null ? null : getComputedStyle(leadNotice).backgroundColor,
    surface: probe('var(--surface)'),
    wash: probe('var(--wash)'),
    form: box(article.querySelector('.task-card__form')),
    actions: box(actions),
    beforeActions: actions === null ? null : visibleBefore(actions),
    buttons: [...article.querySelectorAll('.task-card__actions .button')].map(
      box,
    ),
    link: box(link),
    beforeLink: link === null ? null : visibleBefore(link),
  };
}

function near(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) <= 1,
    `${message}: ${actual} is not ${expected} (±1px)`,
  );
}

// The canvas geometry (valstara.css: .task, .task-card, .task-card__head,
// __line, __notice, __form, __actions, __link and .page-main), at rest.
function assertCanvasGeometry(m, width, label) {
  const wide = width >= 1024;
  const pad = width >= 768 ? 40 : 24;
  near(m.card.left, m.container.left, `${label} card on the grid`);
  if (wide) {
    // Columns 1–7 of the 12-column grid with its 24px gaps.
    const column = (m.container.width - 11 * 24) / 12;
    near(m.card.width, column * 7 + 6 * 24, `${label} card spans cols 1–7`);
  } else {
    near(m.card.width, m.container.width, `${label} card is full width`);
  }
  near(m.card.top - m.main.top, wide ? 64 : 32, `${label} page-main top`);
  near(m.footer.top - m.card.bottom, wide ? 80 : 64, `${label} footer gap`);
  assert.deepEqual(m.padding, [pad + 'px', pad + 'px'], `${label} padding`);
  near(m.tile.left - m.card.left, pad, `${label} tile x`);
  near(m.tile.top - m.card.top, pad, `${label} tile y`);
  near(m.tile.width, 48, `${label} tile width`);
  near(m.tile.height, 48, `${label} tile height`);
  near(m.heading.left - m.tile.right, 16, `${label} tile to H1`);
  // The H1 box starts level with the tile and its text 4px down (padding).
  near(m.heading.top - m.tile.top, 0, `${label} H1 level with the tile`);
  assert.deepEqual(
    m.headingType,
    ['32px', '700', '4px'],
    `${label} H1 type and 4px offset`,
  );
  let previous = m.head;
  if (m.line !== null) {
    near(m.line.top - m.head.bottom, 16, `${label} line 16px below the head`);
    previous = m.line;
  }
  if (m.notice !== null) {
    near(m.notice.top - previous.bottom, 24, `${label} notice 24px below`);
    previous = m.notice;
  }
  if (m.form !== null) {
    near(m.form.top - previous.bottom, 24, `${label} form 24px below`);
  }
  if (m.actions !== null) {
    near(
      m.actions.top - m.beforeActions.bottom,
      32,
      `${label} actions 32px below`,
    );
    const inner = m.card.width - 2 * pad;
    if (width < 768) {
      // Stacked, each the full width of the card, 12px apart.
      m.buttons.forEach((button, index) => {
        near(button.width, inner, `${label} button ${index} full width`);
        if (index > 0)
          near(
            button.top - m.buttons[index - 1].bottom,
            12,
            `${label} stacked 12px apart`,
          );
      });
    } else if (m.buttons.length > 1 && m.buttons[1].top === m.buttons[0].top) {
      near(
        m.buttons[1].left - m.buttons[0].right,
        12,
        `${label} buttons 12px apart`,
      );
    }
    for (const button of m.buttons)
      assert.ok(button.height >= 48 - 1, `${label} button is 48px tall`);
  }
  if (m.link !== null) {
    near(m.link.top - m.beforeLink.bottom, 16, `${label} link 16px below`);
    assert.ok(m.link.height >= 44 - 1, `${label} link is a 44px target`);
  }
}

test('the task pages, 404 and 500 follow the final design: /dsr outcomes, the award field error, geometry at rest, motion and axe', async () => {
  await ensureAppBuild();
  const data = await fixture();
  const alerts = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.writeHead(200).end());
  });
  alerts.listen(0, '127.0.0.1');
  await once(alerts, 'listening');
  let app;
  let remote;
  try {
    app = await startAppServer({
      label: 'Final task pages',
      readyPath: '/privacy',
      nodeArguments: ['--import', siteverifyStub],
      env: appEnvironment(data.appUrl, alerts.address().port),
    });
    const local = 'http://127.0.0.1:' + app.port;
    const post = (path, fields) =>
      globalThis.fetch(local + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: local,
        },
        body: new globalThis.URLSearchParams(fields),
      });
    const get = (path) => globalThis.fetch(local + path);
    const states = [];
    const capture = async (state, path, response, status, method) => {
      assert.equal(response.status, status, `${state} status`);
      assert.equal(response.headers.get('set-cookie'), null, state);
      const html = await response.text();
      states.push({ state, path, status, html, method });
      return html;
    };

    // /dsr handles its own POST (founder decision 2026-11-12). The request
    // acknowledgement is identical for a known and an unknown address, and
    // the typed address is never rendered back.
    const exportPath = '/dsr?operation=export';
    const deletePath = '/dsr?operation=delete';
    const known = 'task-final-export@example.test';
    const unknown = 'nobody-here@example.test';
    const knownHtml = await capture(
      'export-accepted',
      exportPath + '&state=accepted',
      await post(exportPath, { email: known, turnstile_token: 'ok' }),
      200,
      'POST',
    );
    const unknownHtml = await (
      await post(exportPath, { email: unknown, turnstile_token: 'ok' })
    ).text();
    assert.equal(
      card(knownHtml, 'export-accepted'),
      card(unknownHtml, 'export-accepted'),
    );
    let body = card(knownHtml, 'export-accepted');
    assert.match(body, /data-tone="success"/u);
    assert.ok(body.includes(dsrCopy.accepted));
    assert.doesNotMatch(body, /<form\b/u);
    assert.doesNotMatch(knownHtml, /turnstile/u);
    assert.match(body, /href="\/privacy"/u);
    assert.ok(!knownHtml.includes(known) && !unknownHtml.includes(unknown));
    // The same logic ran: the known address got its emailed link queued.
    assert.equal(
      (
        await data.database.query(
          "SELECT count(*)::int AS n FROM email_send WHERE subscriber_id=$1 AND template='dsr_export'",
          [data.exporterId],
        )
      ).rows[0].n,
      1,
    );
    // The API route still answers with its unchanged JSON.
    const api = await post('/api/dsr/export', {
      email: unknown,
      turnstile_token: 'ok',
    });
    assert.equal(api.status, 200);
    assert.equal(
      await api.text(),
      JSON.stringify({ message: dsrCopy.accepted }),
    );

    for (const [state, fields, status, tone, message] of [
      ['check-failed', { email: known }, 400, 'error', dsrCopy.challengeFailed],
      [
        'check-failed',
        { email: known, turnstile_token: 'turnstile-reject' },
        400,
        'error',
        dsrCopy.challengeFailed,
      ],
      [
        'unavailable',
        { email: known, turnstile_token: 'turnstile-down' },
        503,
        'error',
        dsrCopy.unavailable,
      ],
    ]) {
      const html = await capture(
        'export-' + state,
        exportPath + '&state=' + state,
        await post(exportPath, fields),
        status,
        'POST',
      );
      body = card(html, 'export-' + state);
      assert.match(body, new RegExp(`data-tone="${tone}"`, 'u'));
      assert.ok(body.includes(message), state);
      // The request form comes back, empty: no address is echoed.
      assert.match(body, /action="\/dsr\?operation=export"/u);
      assert.match(body, /<input[^>]*name="email"/u);
      assert.doesNotMatch(body, /<input[^>]*name="email"[^>]*value=/u);
      assert.ok(!html.includes(known), `${state} echoes no address`);
      assert.match(body, /class="cf-turnstile"/u);
    }

    // The signed-link confirmations.
    let html = await capture(
      'export-invalid',
      exportPath + '&state=invalid',
      await post(exportPath, { token: 'not-a-real-link' }),
      400,
      'POST',
    );
    body = card(html, 'export-invalid');
    assert.match(body, /data-tone="info"/u);
    assert.ok(body.includes(dsrCopy.invalid));
    assert.match(body, /<input[^>]*name="email"/u);
    assert.doesNotMatch(body, /name="token"/u);

    const download = await post(exportPath, { token: data.exportToken });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/x-ndjson');
    assert.equal(
      download.headers.get('content-disposition'),
      'attachment; filename="valstara-data.ndjson"',
    );
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
    const lines = (await download.text()).trim().split('\n');
    assert.ok(lines.length > 0);
    for (const line of lines) JSON.parse(line);
    assert.ok(lines.some((line) => line.includes(data.exporterId)));

    html = await capture(
      'export-used',
      exportPath + '&state=used',
      await post(exportPath, { token: data.exportToken }),
      200,
      'POST',
    );
    body = card(html, 'export-used');
    assert.match(body, /data-tone="info"/u);
    assert.ok(body.includes(dsrCopy.exportUsed));
    assert.match(body, /<input[^>]*name="email"/u);

    html = await capture(
      'delete-pending',
      deletePath + '&state=pending',
      await post(deletePath, { token: data.deleteToken }),
      200,
      'POST',
    );
    body = card(html, 'delete-pending');
    assert.match(body, /data-tone="success"/u);
    assert.ok(body.includes(dsrCopy.pending));
    assert.doesNotMatch(body, /<form\b/u);
    assert.doesNotMatch(body, /task-card__line/u);

    let limited;
    for (let attempt = 0; attempt < 8 && limited === undefined; attempt += 1) {
      const response = await post(deletePath, {
        token: 'not-a-link-' + attempt,
      });
      if (response.status === 429) limited = response;
      else await response.arrayBuffer();
    }
    assert.ok(limited, 'the confirmation IP limit is reached');
    html = await capture(
      'delete-rate-limited',
      deletePath + '&state=rate-limited',
      limited,
      429,
      'POST',
    );
    body = card(html, 'delete-rate-limited');
    assert.match(body, /data-tone="wait"/u);
    assert.ok(body.includes(dsrCopy.rateLimited));
    assert.match(body, /action="\/dsr\?operation=delete"/u);

    // GET states, for the geometry and motion below.
    await capture(
      'export-request',
      exportPath,
      await get(exportPath),
      200,
      'GET',
    );
    await capture(
      'delete-confirm',
      deletePath + '&t=emailed-link',
      await get(deletePath + '&t=emailed-link'),
      200,
      'GET',
    );
    const unsubscribePath =
      '/unsubscribe?t=' + encodeURIComponent(data.unsubscribe);
    await capture(
      'confirm',
      unsubscribePath,
      await get(unsubscribePath),
      200,
      'GET',
    );
    html = await capture(
      'complete',
      '/unsubscribe?state=complete',
      await post('/unsubscribe', { t: data.unsubscribe, intent: 'message' }),
      200,
      'POST',
    );
    // The outcome line is what fades after a POST; the H1 and tile do not.
    assert.match(
      card(html, 'complete'),
      /class="task-card__line"[^>]*data-task-outcome/u,
    );

    // The award checks step: invalid_input is the country field's error, with
    // the bearer's answers kept (founder decision 2026-11-12).
    const awardPath =
      '/giveaway/award?award=' +
      data.awardId +
      '&t=' +
      encodeURIComponent(data.winnerStatus);
    await capture('checks', awardPath, await get(awardPath), 200, 'GET');
    html = await capture(
      'checks',
      awardPath + '&state=country-error',
      await post(awardPath, {
        step: 'checks',
        country: '1X',
        age_confirmed: 'yes',
        skill_answer: '50',
        publicity_permission: 'yes',
        turnstile_token: 'ok',
      }),
      200,
      'POST',
    );
    body = card(html, 'checks');
    assert.doesNotMatch(body, /data-tone="error"/u);
    const country = body.match(/<input[^>]*id="award-country"[^>]*>/u)[0];
    assert.match(country, /aria-invalid="true"/u);
    assert.match(country, /aria-describedby="award-country-error"/u);
    assert.match(country, /value="1X"/u);
    assert.match(country, /pattern="\[A-Za-z\]\{2\}"/u);
    assert.doesNotMatch(body, /<select\b/u);
    const error = body.match(/id="award-country-error"[^>]*>([^<]*)</u);
    assert.equal(error?.[1], giveawayAwardCopy.invalidInput);
    // The error sits under the country input, and nothing under the skill
    // field: it comes before the age confirmation in the markup.
    assert.ok(
      body.indexOf('award-country-error') <
        body.indexOf('name="age_confirmed"'),
    );
    assert.equal([...body.matchAll(/class="field__error"/gu)].length, 1);
    assert.match(body, /name="age_confirmed"[^>]*checked/u);
    assert.match(body, /name="publicity_permission"[^>]*checked/u);
    assert.match(body, /<input[^>]*name="skill_answer"[^>]*value="50"/u);
    // A first GET never shows an error or keeps an answer.
    const fresh = card(await (await get(awardPath)).text(), 'checks');
    assert.doesNotMatch(fresh, /aria-invalid|class="field__error"|checked/u);

    const award = (columns) =>
      data.database.query(`UPDATE giveaway_award SET ${columns} WHERE id=$1`, [
        data.awardId,
      ]);
    await award(
      "state='confirmed', country_of_residence='DE', age_confirmed=true, sanctions_passed=true",
    );
    await data.database.query(
      "UPDATE giveaway_award SET substitution_state='offered', substitution_offered_at='2026-10-03T00:00:00Z', substitution_deadline_at='2099-01-01T00:00:00Z', substitution_offer=$2::jsonb WHERE id=$1",
      [data.awardId, JSON.stringify(offer)],
    );
    await capture('substitution', awardPath, await get(awardPath), 200, 'GET');
    // The substitution step's invalid_input stays a card notice.
    html = await capture(
      'substitution',
      awardPath + '&state=substitution-invalid',
      await post(awardPath, {
        step: 'substitution',
        choice: 'replacement',
        turnstile_token: 'ok',
      }),
      200,
      'POST',
    );
    body = card(html, 'substitution');
    assert.match(
      body,
      /class="task-card__notice"[^>]*data-tone="error"[\s\S]*role="status"[^>]*>Please check your response and try again\./u,
    );
    assert.doesNotMatch(body, /field__error|aria-invalid/u);
    await award(
      'substitution_state=\'cash\', substitution=\'{"choice":"cash"}\'::jsonb',
    );
    await capture(
      'confirmed',
      awardPath + '&state=confirmed',
      await get(awardPath),
      200,
      'GET',
    );

    // 404 and 500, as served.
    await capture(
      'not-found',
      '/not-a-page',
      await get('/not-a-page'),
      404,
      'GET',
    );
    states.push({
      state: 'server-error',
      path: '/500',
      status: 500,
      html: await readFile(root + 'dist/client/500.html', 'utf8'),
      method: 'GET',
    });

    remote = await startBrowser();
    const origin = 'http://host.docker.internal:' + app.port;
    const open = async (context, entry) => {
      const page = await context.newPage();
      // Every transition that starts on the page, from its first style.
      await page.addInitScript(() => {
        globalThis.__taskTransitions = [];
        globalThis.document.addEventListener(
          'transitionrun',
          (event) =>
            globalThis.__taskTransitions.push({
              property: event.propertyName,
              outcome: event.target.hasAttribute('data-task-outcome'),
            }),
          true,
        );
      });
      const target = new URL(entry.path, origin).href;
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        // Turnstile stays out of the page, so its slot is deterministic.
        if (url.origin !== new URL(origin).origin) return route.abort();
        if (url.href === target)
          return route.fulfill({
            status: entry.status,
            contentType: 'text/html; charset=utf-8',
            body: entry.html,
          });
        const response = await globalThis.fetch(
          local + url.pathname + url.search,
        );
        return route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: globalThis.Buffer.from(await response.arrayBuffer()),
        });
      });
      await page.goto(target);
      assert.equal(
        await page.locator('[data-task-state]').getAttribute('data-task-state'),
        entry.state,
      );
      return page;
    };

    // Geometry, layout checks and axe, at rest, at the canvas widths.
    for (const entry of states) {
      for (const width of canvasWidths) {
        for (const theme of designThemes) {
          const label = `${entry.path} (${entry.state}) ${width}px ${theme}`;
          const context = await remote.browser.newContext({
            ...atRestContext,
            viewport: { width, height: 900 },
            colorScheme: theme,
          });
          try {
            const page = await open(context, entry);
            assert.deepEqual(await checkPageLayout(page), [], label);
            const m = await page.evaluate(measureCard);
            assertCanvasGeometry(m, width, label);
            const tone = await page.evaluate(
              () =>
                [
                  ...globalThis.document.querySelector('.task-card__tile')
                    .classList,
                ]
                  .find((name) => name.startsWith('task-card__tile--'))
                  .split('--')[1],
            );
            assert.equal(m.tileColour, m.tileTones[tone], `${label} tile`);
            if (m.notice !== null) {
              const noticeTone = await page.getAttribute(
                '[data-task-state] > .task-card__notice',
                'data-tone',
              );
              assert.equal(
                m.noticeBackground,
                noticeTone === 'info' ? m.wash : m.surface,
                `${label} notice fill`,
              );
              if (noticeTone === 'error')
                assert.match(m.noticeShadow, /1\.5px/u, `${label} error rule`);
            }
            assert.deepEqual(await axeViolations(page), [], `${label} axe`);
          } finally {
            await context.close();
          }
        }
      }
    }

    // Motion. The card enters at first paint, rising only: the tile and H1,
    // then the line, then the form or actions. Nothing in the card fades on
    // entrance, and only a POST outcome fades in, over --duration-base.
    const motionStates = [
      ['GET', 'confirm'],
      ['POST', 'complete'],
      ['GET', 'export-request'],
      ['POST', 'export-check-failed'],
      ['POST', 'delete-pending'],
      ['GET', 'not-found'],
      ['GET', 'server-error'],
    ].map(([method, state]) =>
      states.find((entry) => entry.method === method && entry.state === state),
    );
    for (const entry of motionStates) {
      const label = `${entry.state} (${entry.method})`;
      const context = await remote.browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'no-preference',
      });
      try {
        const page = await open(context, entry);
        const entrance = await page.evaluate(() =>
          [
            '.task-card__head',
            '.task-card__line',
            '[data-task-state] > .task-card__notice',
            '.task-card__body',
          ].map((selector) => {
            const element = globalThis.document.querySelector(selector);
            if (element === null) return null;
            const style = globalThis.getComputedStyle(element);
            return {
              enter: element.getAttribute('data-enter'),
              outcome: element.hasAttribute('data-task-outcome'),
              name: style.animationName,
              delay: style.animationDelay,
              transition: [style.transitionProperty, style.transitionDuration],
            };
          }),
        );
        const [head, line, notice, bodyPart] = entrance;
        assert.deepEqual(
          [head.enter, head.name, head.delay],
          ['shift', 'motion-enter-shift', '0s'],
          `${label} head`,
        );
        assert.deepEqual(
          [bodyPart.enter, bodyPart.name, bodyPart.delay],
          ['shift', 'motion-enter-shift', '0.12s'],
          `${label} form or actions`,
        );
        const outcomePart = [line, notice].find((part) => part?.outcome);
        if (entry.method === 'POST') {
          assert.ok(outcomePart, `${label} has an outcome`);
          // Opacity only, over --duration-base, with no entrance of its own.
          assert.equal(outcomePart.enter, null);
          assert.equal(outcomePart.name, 'none');
          assert.deepEqual(outcomePart.transition, ['opacity', '0.2s']);
        } else {
          assert.equal(outcomePart, undefined, `${label} has no outcome fade`);
        }
        for (const part of [line, notice]) {
          if (part === null || part.outcome) continue;
          assert.deepEqual(
            [part.enter, part.name, part.delay],
            ['shift', 'motion-enter-shift', '0.06s'],
            `${label} line or notice`,
          );
        }
        // No element in the card changes opacity on entrance.
        const fading = await page.evaluate(() =>
          globalThis.document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.target?.closest?.('[data-task-state]') &&
                animation.animationName !== 'motion-enter-shift',
            )
            .map((animation) => animation.animationName ?? 'transition'),
        );
        assert.ok(
          fading.every((name) => name === 'transition'),
          `${label}: ${fading}`,
        );
        // Focus moved into the card at once is never mid-motion.
        const controls = page.locator(
          '[data-task-state] :is(input:not([type="hidden"]), button, a[href])',
        );
        if ((await controls.count()) > 0) {
          await controls.first().focus();
          assert.deepEqual(await focusMotionIssues(page), [], `${label} focus`);
        }
        await entranceEnded(page);
        await page.waitForFunction(() =>
          globalThis.document
            .getAnimations()
            .every((animation) => animation.playState !== 'running'),
        );
        const transitions = await page.evaluate(
          () => globalThis.__taskTransitions,
        );
        const opacity = transitions.filter(
          (transition) => transition.property === 'opacity',
        );
        assert.deepEqual(
          opacity,
          entry.method === 'POST'
            ? [{ property: 'opacity', outcome: true }]
            : [],
          `${label} outcome fade`,
        );
        assert.equal(
          await page.evaluate(() =>
            [...globalThis.document.querySelectorAll('[data-task-state] *')]
              .map((element) => globalThis.getComputedStyle(element).opacity)
              .every((value) => value === '1'),
          ),
          true,
          `${label} at rest at full opacity`,
        );
        // A focus walk through the card at rest.
        for (let step = 0; step < 6; step += 1) {
          await page.keyboard.press('Tab');
          assert.deepEqual(
            await focusMotionIssues(page),
            [],
            `${label} tab ${step}`,
          );
        }
      } finally {
        await context.close();
      }

      // With reduced motion nothing enters, nothing fades, nothing moves.
      const reduced = await remote.browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'reduce',
      });
      try {
        const page = await open(reduced, entry);
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              globalThis.requestAnimationFrame(() =>
                globalThis.requestAnimationFrame(resolve),
              ),
            ),
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            animations: globalThis.document.getAnimations().length,
            transitions: globalThis.__taskTransitions.length,
            outcome: [
              ...globalThis.document.querySelectorAll('[data-task-outcome]'),
            ].map((element) => globalThis.getComputedStyle(element).opacity),
          })),
          {
            animations: 0,
            transitions: 0,
            outcome: entry.method === 'POST' ? ['1'] : [],
          },
          `${entry.state} reduced motion`,
        );
      } finally {
        await reduced.close();
      }
    }

    // The at-rest harness puts the page back to motion allowed afterwards;
    // the outcome does not fade again, so a later read sees it at rest.
    const replay = states.find(
      (entry) =>
        entry.method === 'POST' && entry.state === 'export-check-failed',
    );
    const context = await remote.browser.newContext({
      viewport: { width: 390, height: 900 },
      reducedMotion: 'no-preference',
    });
    try {
      const page = await open(context, replay);
      await entranceEnded(page);
      await page.waitForFunction(() => globalThis.__taskTransitions.length > 0);
      await atRest(page, async () => {});
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() =>
              globalThis.requestAnimationFrame(resolve),
            ),
          ),
      );
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.__taskTransitions.filter(
              (transition) => transition.property === 'opacity',
            ).length,
        ),
        1,
        'the outcome fades once, on first render',
      );
    } finally {
      await context.close();
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
    alerts.close();
    await once(alerts, 'close');
    await data.dispose();
  }
});
