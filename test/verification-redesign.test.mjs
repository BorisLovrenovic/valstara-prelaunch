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
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import {
  assertEnforcedPages,
  checkPageLayout,
  designThemes,
  designWidths,
  enforcedPages,
} from '../scripts/design/layout-checks.mjs';
import { captureContactSheet } from '../scripts/design/contact-sheet.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

const executeFile = promisify(execFile);
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const browserImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = 'valstara-verify-design-' + process.pid;

async function fixture() {
  const name = 'valstara_verify_design_' + randomUUID().replaceAll('-', '');
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
      ['tsx', 'src/server/db/run-migrations.ts', 'e11-5-07-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: fixtureUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    const subscriberId = randomUUID();
    const tokenId = randomUUID();
    const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET);
    await database.query(
      "INSERT INTO subscriber (id,email,email_normalised,email_domain,status) VALUES ($1,$2,$2,'example.test','pending')",
      [subscriberId, 'verify-design@example.test'],
    );
    await database.query(
      "INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'verify','2099-01-01T00:00:00Z')",
      [tokenId, subscriberId, createHash('sha256').update(token).digest()],
    );
    const otherSubscriberId = randomUUID();
    const otherTokenId = randomUUID();
    const otherToken = deriveEmailToken(
      otherTokenId,
      process.env.EMAIL_TOKEN_SECRET,
    );
    await database.query(
      "INSERT INTO subscriber (id,email,email_normalised,email_domain,status) VALUES ($1,$2,$2,'example.test','pending')",
      [otherSubscriberId, 'verify-design-flags@example.test'],
    );
    await database.query(
      "INSERT INTO verification_token (id,subscriber_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'verify','2099-01-01T00:00:00Z')",
      [
        otherTokenId,
        otherSubscriberId,
        createHash('sha256').update(otherToken).digest(),
      ],
    );
    return {
      appUrl: appUrl.toString(),
      database,
      token,
      otherToken,
      subscriberId,
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

test('verification states, exact figures, native actions and flags render accessibly', async () => {
  await ensureAppBuild();
  const data = await fixture();
  let app;
  let remote;
  try {
    const startVerificationApp = () =>
      startAppServer({
        label: 'Verification redesign',
        readyPath: '/verify',
        env: () => ({
          ADMIN_CREDENTIAL: 'verify-design-admin-credential-32-chars',
          ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
          DATABASE_URL: data.appUrl,
          HOST: '0.0.0.0',
          IP_PREFIX_PEPPER: 'verify-design-prefix-pepper',
          REFERRAL_SIGNING_SECRET: 'verify-design-referral-secret',
          RESEND_API_KEY: 'verify-design-resend-key',
          RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
          RESEND_KEY_MODE: 'test',
          RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
          RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
          RESEND_SENDING_DOMAIN: 'send.valstara.com',
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        }),
      });
    app = await startVerificationApp();
    remote = await startBrowser();
    const origin = 'http://host.docker.internal:' + app.port;
    assert.deepEqual(enforcedPages, [
      '/verify',
      '/me',
      '/leaderboard',
      '/legit',
      '/guarantee',
      '/about',
      '/terms',
      '/privacy',
      '/privacy/storage',
      '/giveaway/rules',
      '/giveaway/rules/VAL-GW-LAUNCH-20260925-r1',
      '/giveaway/rules/VAL-GW-LAUNCH-20261001-r1',
      '/giveaway/rules/VAL-GW-LAUNCH-20261009-r1',
    ]);
    await assertEnforcedPages(remote.browser, origin);

    const confirmPath = '/verify?token=' + encodeURIComponent(data.token);
    const confirmedBefore = await data.database.query(
      'SELECT status FROM subscriber WHERE email_normalised=$1',
      ['verify-design@example.test'],
    );
    assert.equal(confirmedBefore.rows[0].status, 'pending');

    const confirmation = await remote.browser.newPage();
    await confirmation.goto(origin + confirmPath);
    assert.equal(
      await confirmation.locator('.verification-confirm button').count(),
      1,
    );
    assert.equal(
      await confirmation.locator('.verification-confirm h1').count(),
      1,
    );
    assert.equal(
      await confirmation.locator('.verification-confirm p').count(),
      1,
    );
    await confirmation.locator('.verification-confirm button').click();
    await confirmation.getByText('Your email address is verified.').waitFor();
    const successHtml = await confirmation.content();
    assert.equal(await confirmation.locator('[data-referral-card]').count(), 1);
    assert.equal(
      await confirmation
        .locator('[data-referral-progress]')
        .getAttribute('value'),
      '0',
    );
    assert.equal(
      await confirmation
        .locator('[data-referral-progress]')
        .getAttribute('max'),
      '3',
    );
    assert.match(successHtml, /0 of 3 to Tier 1/u);
    assert.match(successHtml, /15% launch discount/u);
    assert.match(successHtml, /Access wave 1/u);
    assert.match(successHtml, /first order within 90 days/u);
    assert.equal(await confirmation.locator('input[value="ai"]').count(), 1);
    assert.equal(
      await confirmation.locator('input[value="apparel"]').count(),
      0,
    );
    const successUrl = confirmation.url();
    const surveyButtons = await confirmation
      .locator('[data-survey-form] button')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = globalThis.getComputedStyle(button);
          return [
            style.backgroundColor,
            style.borderColor,
            style.color,
            style.fontSize,
            style.fontWeight,
            style.boxShadow,
          ];
        }),
      );
    assert.deepEqual(surveyButtons[0], surveyButtons[1]);

    const replay = await globalThis.fetch(
      'http://127.0.0.1:' + app.port + '/verify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'http://127.0.0.1:' + app.port,
        },
        body: new globalThis.URLSearchParams({ token: data.token }),
      },
    );
    assert.match(await replay.text(), /0 of 3 to Tier 1/u);
    assert.equal(replay.headers.get('set-cookie'), null);
    await data.database.query(
      "UPDATE subscriber SET confirmed_referrals=2, access_window='wave-2' WHERE id=$1",
      [data.subscriberId],
    );
    const revised = await globalThis.fetch(
      'http://127.0.0.1:' + app.port + '/verify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'http://127.0.0.1:' + app.port,
        },
        body: new globalThis.URLSearchParams({ token: data.token }),
      },
    );
    const revisedHtml = await revised.text();
    assert.match(revisedHtml, /2 of 3 to Tier 1/u);
    assert.match(revisedHtml, /Access wave 2/u);
    for (const marker of ['data-copy-referral', 'data-survey-skip']) {
      const tag = revisedHtml.match(
        new RegExp('<button[^>]*' + marker + '[^>]*>', 'u'),
      )?.[0];
      assert.equal(tag?.match(/\stype=/gu)?.length, 1, marker);
    }
    for (const tag of revisedHtml.match(/<button[^>]*>/gu) ?? [])
      assert.equal(tag.match(/\stype=/gu)?.length, 1, tag);

    const invalid = await globalThis.fetch(
      'http://127.0.0.1:' + app.port + '/verify',
    );
    const invalidHtml = await invalid.text();
    assert.match(invalidHtml, /Request a new link/u);
    assert.match(invalidHtml, /action="\/api\/resend-verification"/u);

    const requests = [];
    confirmation.on('request', (request) =>
      requests.push(new URL(request.url()).host),
    );
    assert.equal(
      await confirmation.locator('.verification-native-share').count(),
      0,
    );
    await confirmation.locator('[data-copy-referral]').click();
    assert.match(
      await confirmation.locator('[data-copy-status]').textContent(),
      /Link copied|Select and copy/u,
    );

    const shareContext = await remote.browser.newContext();
    await shareContext.addInitScript(() => {
      globalThis.navigator.share = async (data) => {
        globalThis.window.sharedUrl = data.url;
      };
    });
    const sharePage = await shareContext.newPage();
    const shareRequests = [];
    sharePage.on('request', (request) =>
      shareRequests.push(new URL(request.url()).host),
    );
    await sharePage.route('**/verify', (route) =>
      route.fulfill({
        body: successHtml,
        contentType: 'text/html',
      }),
    );
    await sharePage.goto(origin + '/verify');
    await sharePage.locator('.verification-native-share').click();
    assert.match(
      await sharePage.evaluate(() => globalThis.window.sharedUrl),
      /\?ref=/u,
    );
    assert.ok(shareRequests.every((host) => host === new URL(origin).host));
    await shareContext.close();

    for (const width of designWidths) {
      for (const theme of designThemes) {
        for (const [label, path] of [
          ['confirmation', confirmPath],
          ['success', confirmPath],
          ['invalid', '/verify'],
        ]) {
          const context = await remote.browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: theme,
          });
          try {
            const page = await context.newPage();
            await page.goto(origin + path);
            if (label === 'success')
              await page.locator('.verification-confirm button').click();
            assert.deepEqual(
              await checkPageLayout(page),
              [],
              label + ' at ' + width + 'px in ' + theme,
            );
            if (width === 390) {
              assert.deepEqual(
                await axeViolations(page),
                [],
                label + ' axe in ' + theme,
              );
            }
          } finally {
            await context.close();
          }
        }
      }
    }
    const captures = await captureContactSheet({
      origin,
      browserEndpoint: remote.browserEndpoint,
      output: '.design-contact-sheets/e11-5-07',
      entries: [
        { route: confirmPath, state: 'verify-confirmation' },
        {
          route: confirmPath,
          state: 'verify-success',
          actions: [
            { action: 'click', selector: '.verification-confirm button' },
            { action: 'waitFor', selector: '.verification-success' },
          ],
        },
        { route: '/verify', state: 'verify-invalid' },
      ],
    });
    assert.equal(
      captures.length,
      designWidths.length * designThemes.length * 3,
    );
    assert.ok(captures.every((capture) => capture.layoutIssues.length === 0));
    await confirmation.locator('input[value="ai"]').check();
    await confirmation.locator('[data-survey-skip]').click();
    await confirmation.getByText("Skipped. We won't ask again.").waitFor();
    assert.equal(confirmation.url(), successUrl);
    await confirmation.locator('input[value="ai"]').check();
    await confirmation.locator('input[value="weekly"]').check();
    await confirmation
      .locator('[data-survey-form] button[type="submit"]')
      .click();
    await confirmation.getByText('Your preferences are saved.').waitFor();
    assert.equal(confirmation.url(), successUrl);
    assert.ok(requests.every((host) => host === new URL(origin).host));
    await confirmation.close();
    const saved = await data.database.query(
      "SELECT answers FROM survey_response WHERE subscriber_id=(SELECT id FROM subscriber WHERE email_normalised='verify-design@example.test')",
    );
    assert.deepEqual(saved.rows[0].answers, {
      category_preference: ['ai'],
      shopping_frequency: 'weekly',
    });

    async function renderOther() {
      const response = await globalThis.fetch(
        'http://127.0.0.1:' + app.port + '/verify',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'http://127.0.0.1:' + app.port,
          },
          body: new globalThis.URLSearchParams({ token: data.otherToken }),
        },
      );
      assert.equal(response.status, 200);
      return response.text();
    }
    await data.database.query(
      "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ('referral.enabled',false,'e11-5-07-test')",
    );
    await app.stop();
    app = await startVerificationApp();
    const referralOffHtml = await renderOther();
    assert.doesNotMatch(referralOffHtml, /data-referral-card/u);
    assert.doesNotMatch(referralOffHtml, /Share your link/u);
    assert.match(referralOffHtml, /data-access-wave/u);
    assert.match(referralOffHtml, /<form[^>]*data-survey-form/u);

    await data.database.query(
      "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ('survey.enabled',false,'e11-5-07-test')",
    );
    await data.database.query(
      "UPDATE campaign_flag SET enabled=true WHERE key='referral.enabled'",
    );
    await app.stop();
    app = await startVerificationApp();
    const surveyOffHtml = await renderOther();
    assert.match(surveyOffHtml, /data-referral-card/u);
    assert.doesNotMatch(surveyOffHtml, /<form[^>]*data-survey-form/u);

    await data.database.query(
      "UPDATE campaign_flag SET enabled=false WHERE key='referral.enabled'",
    );
    await app.stop();
    app = await startVerificationApp();
    const bothOffHtml = await renderOther();
    assert.doesNotMatch(bothOffHtml, /data-referral-card/u);
    assert.doesNotMatch(bothOffHtml, /data-referral-progress/u);
    assert.doesNotMatch(bothOffHtml, /<form[^>]*data-survey-form/u);
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
