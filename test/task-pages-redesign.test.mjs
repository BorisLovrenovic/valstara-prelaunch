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
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import {
  checkPageLayout,
  designThemes,
  designWidths,
  enforcedPages,
} from '../scripts/design/layout-checks.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const unreachableDatabaseUrl =
  'postgresql://valstara_app:unreachable@127.0.0.1:1/valstara_unreachable';
const browserImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = 'valstara-task-pages-' + process.pid;
const rulesVersion = 'VAL-GW-LAUNCH-20261009-r1';
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
  return { id, value };
}

async function fixture() {
  const name = 'valstara_task_pages_' + randomUUID().replaceAll('-', '');
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
      ['tsx', 'src/server/db/run-migrations.ts', 'e11-5-10-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: fixtureUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    const winnerId = randomUUID();
    const replacedId = randomUUID();
    await database.query(
      "INSERT INTO subscriber (id,email,email_normalised,email_domain,status,verified_at,referral_code,access_window) VALUES ($1,'task-winner@example.test','task-winner@example.test','example.test','verified','2026-10-01T00:00:00Z','TASKWIN23456','wave-1'),($2,'task-replaced@example.test','task-replaced@example.test','example.test','verified','2026-10-01T00:00:00Z','TASKREP23456','wave-1')",
      [winnerId, replacedId],
    );
    // A transactional source: its unsubscribe writes the global suppression.
    const unsubscribe = await insertToken(database, winnerId, 'unsubscribe');
    await database.query(
      "INSERT INTO email_send (id,subscriber_id,template,provider,business_key,state,unsubscribe_token_id) VALUES ($1,$2,'status_link','resend',$3,'sent',$4)",
      [randomUUID(), winnerId, randomUUID(), unsubscribe.id],
    );
    const winnerStatus = await insertToken(database, winnerId, 'status');
    const replacedStatus = await insertToken(database, replacedId, 'status');

    await database.query(
      "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ('giveaway.open',true,'task-pages-test') ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled",
    );
    const drawId = randomUUID();
    const winnerEntry = randomUUID();
    const replacedEntry = randomUUID();
    await database.query(
      "INSERT INTO giveaway_draw (id,executed_by) VALUES ($1,'task-pages-test')",
      [drawId],
    );
    for (const [entryId, subscriberId] of [
      [winnerEntry, winnerId],
      [replacedEntry, replacedId],
    ]) {
      await database.query(
        "INSERT INTO giveaway_entry (id,subscriber_id,method,entries,rules_version,rules_sha256) VALUES ($1,$2,'base',1,$3,decode($4,'hex'))",
        [entryId, subscriberId, rulesVersion, 'ab'.repeat(32)],
      );
      await database.query(
        "INSERT INTO giveaway_draw_snapshot_row (draw_id,entry_id,subscriber_id,method,rules_version,rules_sha256) VALUES ($1,$2,$3,'base',$4,decode($5,'hex'))",
        [drawId, entryId, subscriberId, rulesVersion, 'ab'.repeat(32)],
      );
    }
    await database.query(
      'INSERT INTO giveaway_draw_selection (draw_id,position,subscriber_id,entry_id,is_winner) VALUES ($1,1,$2,$3,true),($1,2,$4,$5,false)',
      [drawId, winnerId, winnerEntry, replacedId, replacedEntry],
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
        JSON.stringify([winnerId]),
      ],
    );
    const awardId = randomUUID();
    await database.query(
      "INSERT INTO giveaway_award (id,draw_id,prize_slot,entry_snapshot_hash,selection_position,entry_id,subscriber_id,notified_at,response_deadline_at) VALUES ($1,$2,1,decode($3,'hex'),1,$4,$5,'2026-10-01T00:03:00Z','2099-01-01T00:00:00Z')",
      [awardId, drawId, 'cd'.repeat(32), winnerEntry, winnerId],
    );
    // The earlier provisional winner the award passed over.
    await database.query(
      "INSERT INTO giveaway_award_candidate (draw_id,selection_position,award_id,subscriber_id,outcome,reason,checked_at) VALUES ($1,2,$2,$3,'replaced','deadline','2026-10-02T00:00:00Z')",
      [drawId, awardId, replacedId],
    );
    return {
      appUrl: appUrl.toString(),
      awardId,
      database,
      dispose,
      replacedStatus: replacedStatus.value,
      unsubscribe: unsubscribe.value,
      winnerStatus: winnerStatus.value,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
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
    // A browser that fails to start must not outlive the test: its running
    // `docker run` client would keep this file's process, and the run, alive.
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

function appEnvironment(databaseUrlForApp, alertPort) {
  return () => ({
    P1_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertPort}/alert`,
    P1_ALERT_WEBHOOK_TOKEN: 'task-pages-alert-token',
    ADMIN_CREDENTIAL: 'task-pages-admin-credential-32-chars',
    ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    DATABASE_URL: databaseUrlForApp,
    HOST: '0.0.0.0',
    IP_PREFIX_PEPPER: 'task-pages-prefix-pepper',
    REFERRAL_SIGNING_SECRET: 'task-pages-referral-secret',
    RESEND_API_KEY: 'task-pages-resend-key',
    RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
    RESEND_KEY_MODE: 'test',
    RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
    RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
    RESEND_SENDING_DOMAIN: 'send.valstara.com',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  });
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

// The task card (the `data-task-state` article), so assertions about its
// actions are not confused with the header's own Join button.
function card(html, state) {
  const start = html.indexOf(`data-task-state="${state}"`);
  assert.notEqual(start, -1, `task card ${state} renders`);
  const open = html.lastIndexOf('<article', start);
  return html.slice(open, html.indexOf('</article>', start));
}

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

test('task pages, 404 and 500 render every state on the task card, with honest statuses, layout checks and axe', async () => {
  await ensureAppBuild();
  const data = await fixture();
  // The unsubscribe page alerts P1 on a failed apply; this sink accepts it.
  const alerts = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.writeHead(200).end());
  });
  alerts.listen(0, '127.0.0.1');
  await once(alerts, 'listening');
  const alertPort = alerts.address().port;
  let app;
  let broken;
  let remote;
  try {
    app = await startAppServer({
      label: 'Task pages',
      readyPath: '/privacy',
      env: appEnvironment(data.appUrl, alertPort),
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

    // Every state is captured as the exact response the server sent, then
    // opened in the browser at its own URL for the layout checks and axe.
    const states = [];
    const capture = async (state, path, response, expectedStatus) => {
      assert.equal(response.status, expectedStatus, `${state} status`);
      assert.equal(response.headers.get('set-cookie'), null, state);
      const html = await response.text();
      assert.equal(count(html, /<h1\b/gu), 1, `${state} has one h1`);
      assert.equal(count(html, /<main\b/gu), 1, `${state} has one main`);
      states.push({ state, path, status: expectedStatus, html });
      return html;
    };

    // /unsubscribe
    const unsubscribePath =
      '/unsubscribe?t=' + encodeURIComponent(data.unsubscribe);
    let html = await capture(
      'confirm',
      unsubscribePath,
      await get(unsubscribePath),
      200,
    );
    let body = card(html, 'confirm');
    assert.match(body, /name="t" value="[^"]+"/u);
    assert.equal(count(body, /button--primary/gu), 1);
    assert.match(
      body,
      /class="button button--primary"[^>]*name="intent" value="message"|name="intent" value="message"[^>]*class="button button--primary"/u,
    );
    assert.match(body, /value="leave_waitlist"/u);
    assert.doesNotMatch(html, /turnstile/u);
    await capture('invalid', '/unsubscribe', await get('/unsubscribe'), 200);
    html = await capture(
      'invalid',
      '/unsubscribe?state=invalid-post',
      await post('/unsubscribe', { t: 'not-a-token', intent: 'message' }),
      400,
    );
    assert.equal(count(card(html, 'invalid'), /button--primary/gu), 0);
    await data.database.query(
      "CREATE FUNCTION reject_suppression() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$",
    );
    await data.database.query(
      'CREATE TRIGGER reject_suppression BEFORE INSERT ON suppression FOR EACH ROW EXECUTE FUNCTION reject_suppression()',
    );
    html = await capture(
      'unavailable',
      '/unsubscribe?state=unavailable',
      await post('/unsubscribe', { t: data.unsubscribe, intent: 'message' }),
      503,
    );
    body = card(html, 'unavailable');
    assert.equal(count(body, /button--primary/gu), 1);
    assert.match(body, /name="intent" value="message"/u);
    await data.database.query('DROP TRIGGER reject_suppression ON suppression');
    html = await capture(
      'complete',
      '/unsubscribe?state=complete',
      await post('/unsubscribe', { t: data.unsubscribe, intent: 'message' }),
      200,
    );
    assert.equal(count(card(html, 'complete'), /<form\b/gu), 0);
    let limited;
    for (let attempt = 0; attempt < 12 && limited === undefined; attempt += 1) {
      const response = await post('/unsubscribe', {
        t: 'not-a-token-' + attempt,
        intent: 'message',
      });
      if (response.status === 429) limited = response;
      else await response.arrayBuffer();
    }
    assert.ok(limited, 'the unsubscribe IP limit is reached');
    html = await capture(
      'rate-limited',
      '/unsubscribe?state=rate-limited',
      limited,
      429,
    );
    assert.match(card(html, 'rate-limited'), /Please wait a moment/u);

    // /dsr: the request and the confirmation of each operation
    for (const operation of ['export', 'delete']) {
      const requestPath = '/dsr?operation=' + operation;
      html = await capture(
        operation + '-request',
        requestPath,
        await get(requestPath),
        200,
      );
      body = card(html, operation + '-request');
      assert.match(body, new RegExp(`action="/api/dsr/${operation}"`, 'u'));
      assert.match(body, /name="email"/u);
      assert.match(body, /class="cf-turnstile"/u);
      assert.match(body, /data-response-field-name="turnstile_token"/u);
      assert.match(
        body,
        /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/u,
      );
      assert.equal(count(body, /button--primary/gu), 1);
      assert.match(body, /href="\/privacy"/u);
      const confirmPath = requestPath + '&t=emailed-link-token';
      html = await capture(
        operation + '-confirm',
        confirmPath,
        await get(confirmPath),
        200,
      );
      body = card(html, operation + '-confirm');
      assert.match(body, /name="token" value="emailed-link-token"/u);
      assert.doesNotMatch(html, /turnstile/u);
      assert.equal(count(body, /button--primary/gu), 1);
    }

    // /giveaway/award, every state of the bearer's own award
    const awardPath = (status) =>
      '/giveaway/award?award=' +
      data.awardId +
      '&t=' +
      encodeURIComponent(status);
    const winnerPath = awardPath(data.winnerStatus);
    await capture(
      'unavailable',
      '/giveaway/award',
      await get('/giveaway/award'),
      200,
    );
    html = await capture('checks', winnerPath, await get(winnerPath), 200);
    body = card(html, 'checks');
    assert.match(body, /name="step" type="hidden" value="checks"/u);
    for (const field of [
      'country',
      'age_confirmed',
      'skill_answer',
      'publicity_permission',
    ])
      assert.match(body, new RegExp(`name="${field}"`, 'u'));
    assert.match(body, /class="cf-turnstile"/u);
    assert.equal(count(body, /button--primary/gu), 1);
    assert.doesNotMatch(body, /role="status"/u);
    html = await capture(
      'checks',
      winnerPath + '&state=challenge-failed',
      await post(winnerPath, { step: 'checks', country: 'DE' }),
      200,
    );
    body = card(html, 'checks');
    assert.match(
      body,
      /data-tone="error"[\s\S]*role="status"[^>]*>That security check did not go through/u,
    );
    const award = (columns) =>
      data.database.query(`UPDATE giveaway_award SET ${columns} WHERE id=$1`, [
        data.awardId,
      ]);
    await award("state='exhausted'");
    html = await capture(
      'exhausted',
      winnerPath + '&state=exhausted',
      await get(winnerPath),
      200,
    );
    assert.match(card(html, 'exhausted'), /No reserve remains/u);
    await award(
      "state='confirmed', country_of_residence='DE', age_confirmed=true, sanctions_passed=true",
    );
    html = await capture(
      'confirmed',
      winnerPath + '&state=confirmed',
      await get(winnerPath),
      200,
    );
    assert.match(card(html, 'confirmed'), /Your award is confirmed\./u);
    await data.database.query(
      "UPDATE giveaway_award SET substitution_state='offered', substitution_offered_at='2026-10-03T00:00:00Z', substitution_deadline_at='2099-01-01T00:00:00Z', substitution_offer=$2::jsonb WHERE id=$1",
      [data.awardId, JSON.stringify(offer)],
    );
    html = await capture(
      'substitution',
      winnerPath + '&state=substitution',
      await get(winnerPath),
      200,
    );
    body = card(html, 'substitution');
    assert.match(body, /name="step" type="hidden" value="substitution"/u);
    assert.match(
      body,
      /name="product" type="checkbox" value="replacement-one"/u,
    );
    assert.equal(count(body, /button--primary/gu), 1);
    assert.equal(count(body, /button--secondary/gu), 1);
    assert.match(body, /value="replacement"/u);
    assert.match(body, /value="decline"/u);
    await award(
      'substitution_state=\'cash\', substitution=\'{"choice":"cash"}\'::jsonb',
    );
    html = await capture(
      'confirmed',
      winnerPath + '&state=cash',
      await get(winnerPath),
      200,
    );
    assert.match(
      card(html, 'confirmed'),
      /cash substitution has been recorded/u,
    );
    await award("substitution_state='replacement'");
    html = await capture(
      'confirmed',
      winnerPath + '&state=replacement',
      await get(winnerPath),
      200,
    );
    assert.match(
      card(html, 'confirmed'),
      /Your replacement choice has been recorded\./u,
    );
    const replacedPath = awardPath(data.replacedStatus);
    html = await capture(
      'replaced',
      replacedPath,
      await get(replacedPath),
      200,
    );
    assert.match(card(html, 'replaced'), /not eligible for this prize/u);

    // The branded 404, for any unknown route
    for (const path of ['/not-a-page', '/giveaway/rules/not-a-version']) {
      const response = await get(path);
      html = await capture('not-found', path, response, 404);
      assert.equal(
        html,
        await readFile(root + 'dist/client/404.html', 'utf8'),
        `${path} serves the built 404 page`,
      );
    }
    body = card(html, 'not-found');
    assert.match(html, /<meta name="robots" content="noindex">/u);
    assert.match(body, /href="\/"[^>]*>Go to the home page/u);
    assert.match(body, /href="\/legit"[^>]*>Is Valstara legit\?/u);
    assert.equal(count(body, /button--primary/gu), 1);

    // The branded 500, for a render that fails: /me needs the database, which
    // this second server cannot reach. The same route renders on the first.
    assert.equal(
      (await get('/me?t=induced-render-error')).status,
      200,
      'the route renders while its database is reachable',
    );
    broken = await startAppServer({
      label: 'Task pages without a database',
      readyPath: '/privacy',
      env: appEnvironment(unreachableDatabaseUrl, alertPort),
    });
    const induced = await globalThis.fetch(
      'http://127.0.0.1:' + broken.port + '/me?t=induced-render-error',
    );
    assert.equal(
      induced.headers.get('content-type'),
      'text/html; charset=utf-8',
    );
    html = await capture('server-error', '/500', induced, 500);
    // No stack trace or internal detail: the body is the prerendered page, byte
    // for byte, and nothing from the failure reaches it.
    assert.equal(html, await readFile(root + 'dist/client/500.html', 'utf8'));
    assert.doesNotMatch(
      html,
      /ECONNREFUSED|valstara_unreachable|127\.0\.0\.1:1\b|node_modules|dist\/server|Error:|\bat \S+:\d+:\d+/u,
    );
    body = card(html, 'server-error');
    assert.match(html, /<meta name="robots" content="noindex">/u);
    assert.match(body, /Something went wrong on our side/u);
    assert.match(body, /href="\/"/u);
    assert.match(body, /href="\/legit"/u);
    assert.doesNotMatch(html, /page-view\.js/u);

    for (const route of [
      '/unsubscribe',
      '/dsr',
      '/giveaway/award',
      '/404',
      '/500',
    ])
      assert.ok(enforcedPages.includes(route), route);

    remote = await startBrowser();
    const origin = 'http://host.docker.internal:' + app.port;
    for (const entry of states) {
      for (const width of designWidths) {
        for (const theme of designThemes) {
          const context = await remote.browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: theme,
          });
          try {
            const page = await context.newPage();
            const target = new URL(entry.path, origin).href;
            // A document fulfilled here cannot load unrouted subresources in
            // the connected browser, so same-origin requests go through the
            // server as they would have.
            await page.route('**/*', async (route) => {
              const url = new URL(route.request().url());
              if (url.origin !== new URL(origin).origin)
                return route.continue();
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
              await page
                .locator('[data-task-state]')
                .getAttribute('data-task-state'),
              entry.state,
            );
            const issues = await checkPageLayout(page);
            assert.deepEqual(
              issues,
              [],
              `${entry.path} (${entry.state}) ${width}px ${theme}`,
            );
            // The card stays left-aligned on the container grid.
            const offset = await page.evaluate(() => {
              const article =
                globalThis.document.querySelector('[data-task-state]');
              const container = article.closest('[data-design-container]');
              return (
                article.getBoundingClientRect().left -
                container.getBoundingClientRect().left
              );
            });
            assert.ok(Math.abs(offset) <= 1, `${entry.state} is left-aligned`);
            if (width === 390) {
              assert.deepEqual(
                await axeViolations(page),
                [],
                `${entry.path} (${entry.state}) axe ${theme}`,
              );
            }
          } finally {
            await context.close();
          }
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
    await broken?.stop();
    await app?.stop();
    alerts.close();
    await once(alerts, 'close');
    await data.dispose();
  }
});
