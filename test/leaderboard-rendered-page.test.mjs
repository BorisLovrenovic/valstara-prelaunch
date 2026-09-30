import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import { Pool } from 'pg';

import { leaderboardCopy } from '../src/copy/leaderboard.ts';
import { flagCacheTtlMilliseconds } from '../src/server/flags/service.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createRankingIntegrityService } from '../src/server/referral/ranking.ts';
import { createSharedLeaderboardSnapshotStore } from '../src/server/leaderboard/persisted.ts';

const execFileAsync = promisify(execFile);
const appPort = 43_280;
const browserPort = 43_281;
const hostOrigin = `http://127.0.0.1:${appPort}`;
const browserOrigin = `http://host.docker.internal:${appPort}`;
const browserServerEndpoint = `ws://127.0.0.1:${browserPort}/`;
const browserContainer = `valstara-leaderboard-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

let browser;
let browserServer;
let browserServerError;
let databaseFixture;
let server;

async function createDatabaseFixture() {
  const databaseName = `valstara_leaderboard_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const database = new Pool({ connectionString: databaseUrl.toString() });

  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    await execFileAsync(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'leaderboard-rendered-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: databaseUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: applicationRolePassword,
        },
      },
    );
    await database.query(
      `
        INSERT INTO subscriber (
          id, email, email_normalised, email_domain, status,
          confirmed_referrals, verified_at
        )
        VALUES
          ($1, $2, $2, 'example.com', 'verified', 7, $3),
          ($4, $5, $5, 'example.com', 'verified', 3, $6)
      `,
      [
        randomUUID(),
        'leader-one@example.com',
        new Date('2026-09-21T10:00:00.000Z'),
        randomUUID(),
        'leader-two@example.com',
        new Date('2026-09-21T10:01:00.000Z'),
      ],
    );
    const snapshotDatabase = createPool(databaseUrl.toString());
    try {
      await createSharedLeaderboardSnapshotStore(
        snapshotDatabase,
        createRankingIntegrityService(snapshotDatabase),
        () => new Date('2026-09-21T10:02:00.000Z'),
      ).refresh();
    } finally {
      await snapshotDatabase.close();
    }
  } catch (error) {
    await database.end();
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
    throw error;
  }

  return {
    database,
    databaseUrl: databaseUrl.toString(),
    async dispose() {
      await database.end();
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [databaseName],
      );
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    },
  };
}

async function waitForAppServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(`${hostOrigin}/leaderboard`);
      if (response.ok) return;
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error('Leaderboard rendered-page test server did not start.');
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
      `127.0.0.1:${browserPort}:3000`,
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
    if (output.includes('Listening on')) return;
    if (browserServerError !== undefined) {
      throw new Error(
        `Could not start Playwright: ${browserServerError.message}`,
      );
    }
    if (browserServer.exitCode !== null) {
      throw new Error(`Playwright exited before startup.\n${output}`);
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error(`Playwright did not start within three minutes.\n${output}`);
}

before(async () => {
  await execFileAsync('npm', ['run', 'build']);
  databaseFixture = await createDatabaseFixture();
  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      ADMIN_CREDENTIAL: 'leaderboard-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseFixture.databaseUrl,
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'leaderboard-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'leaderboard-referral-secret',
      PORT: String(appPort),
      RESEND_API_KEY: 'leaderboard-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'leaderboard-turnstile-secret',
    },
    stdio: 'ignore',
  });
  await waitForAppServer();
  await startBrowserServer();
  browser = await chromium.connect(browserServerEndpoint);
});

after(async () => {
  await browser?.close();
  if (browserServerError === undefined) {
    await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
      (error) => {
        if (!String(error.stderr).includes('No such container')) throw error;
      },
    );
  }
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
  if (server !== undefined) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  await databaseFixture?.dispose();
});

test('the short anonymised board renders exact counts and the snapshot age', async () => {
  const context = await browser.newContext();
  const requests = [];
  const page = await context.newPage();
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${browserOrigin}/leaderboard`);

  const entries = page.locator('.leaderboard-entry');
  await assert.doesNotReject(() =>
    entries.first().waitFor({ timeout: 12_000 }),
  );
  assert.equal(await entries.count(), 2, 'a two-row snapshot is not padded');
  assert.deepEqual(await page.locator('.leaderboard-count').allTextContents(), [
    leaderboardCopy.confirmedReferrals(7),
    leaderboardCopy.confirmedReferrals(3),
  ]);
  const meta = await page.locator('[data-leaderboard-meta]').textContent();
  assert.match(meta ?? '', /Snapshot taken at/u);
  assert.match(meta ?? '', /Snapshot age:/u);

  assert.deepEqual(await context.cookies(), []);
  assert.deepEqual(
    await page.evaluate(() => Object.keys(globalThis.localStorage)),
    [],
  );
  assert.ok(
    requests.every(
      (requestUrl) => new URL(requestUrl).origin === browserOrigin,
    ),
    'the leaderboard loads only same-origin resources',
  );
  await context.close();
});

test('flipping leaderboard.public off removes the section within the flag TTL', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${browserOrigin}/leaderboard`);
  await page.locator('.leaderboard-entry').first().waitFor({ timeout: 12_000 });

  const startedAt = globalThis.performance.now();
  await databaseFixture.database.query(
    `
      INSERT INTO campaign_flag (key, enabled, updated_by)
      VALUES ('leaderboard.public', false, 'leaderboard-kill-switch-drill')
      ON CONFLICT (key) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = EXCLUDED.updated_by
    `,
  );
  await page.locator('[data-leaderboard-section]').waitFor({
    state: 'detached',
    timeout: flagCacheTtlMilliseconds + 1_500,
  });
  const elapsed = globalThis.performance.now() - startedAt;
  assert.ok(
    elapsed <= flagCacheTtlMilliseconds + 1_000,
    `section removal took ${elapsed}ms`,
  );

  const routeResponse = await globalThis.fetch(`${hostOrigin}/api/leaderboard`);
  assert.equal(routeResponse.status, 503);
  assert.deepEqual(await routeResponse.json(), {
    error: { code: 'unavailable', message: leaderboardCopy.paused },
  });

  const pageResponse = await globalThis.fetch(`${hostOrigin}/leaderboard`);
  const pageBody = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.doesNotMatch(pageBody, /<valstara-leaderboard\b/u);
  assert.doesNotMatch(pageBody, /data-leaderboard-section/u);
  await context.close();
});

test('the built route contains the third island and no fourth', async () => {
  await databaseFixture.database.query(
    `UPDATE campaign_flag SET enabled = true WHERE key = 'leaderboard.public'`,
  );
  let body = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await globalThis.fetch(`${hostOrigin}/leaderboard`);
    body = await response.text();
    if (body.includes('<valstara-leaderboard')) break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  assert.match(body, /<valstara-leaderboard\b/u);
  const scripts = [
    ...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu),
  ].map(([, attributes, content]) => ({ attributes, content }));
  const theme = scripts.filter((script) =>
    script.content.includes('valstara-theme'),
  );
  const leaderboard = scripts.filter((script) =>
    script.content.includes('valstara-leaderboard'),
  );
  assert.equal(theme.length, 2);
  assert.equal(leaderboard.length, 1);
  assert.equal(scripts.length, theme.length + leaderboard.length);
});
