import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';

import { Pool } from 'pg';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import { startAppServer } from './helpers/listen-port.mjs';

const executeFile = promisify(execFile);
const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const serverStartupTimeoutMilliseconds = 30_000;

async function stopServer(server) {
  if (
    server?.pid === undefined ||
    server.exitCode !== null ||
    server.signalCode !== null
  )
    return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  await exited;
}

// The server gets a reserved port below the kernel's ephemeral range and
// retries only a lost bind race (test/helpers/listen-port.mjs).
async function startServer(databaseUrl) {
  const app = await startAppServer({
    label: 'Rendered-page test',
    startupTimeoutMilliseconds: serverStartupTimeoutMilliseconds,
    env: () => ({
      ADMIN_CREDENTIAL: 'rendered-page-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'rendered-page-test-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'rendered-page-test-referral-secret',
      RESEND_API_KEY: 'rendered-page-test-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'rendered-page-test-turnstile-secret',
      HOST: '127.0.0.1',
    }),
  });
  const started = {
    port: app.port,
    server: app.server,
    output: app.output,
  };
  try {
    return { ...started, signup: await waitForPage(started, '/') };
  } catch (error) {
    await app.stop();
    throw error;
  }
}

async function createDatabaseFixture() {
  const databaseName = `valstara_e111render_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const database = new Pool({ connectionString: databaseUrl.toString() });

  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'e1-11-rendered-page-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: databaseUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: applicationRolePassword,
        },
      },
    );
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

async function waitForPage(started, pathname) {
  const deadline =
    globalThis.performance.now() + serverStartupTimeoutMilliseconds;
  while (globalThis.performance.now() < deadline) {
    if (
      started.server.exitCode !== null ||
      started.server.signalCode !== null
    ) {
      throw new Error(
        `Rendered-page test server exited before startup.\n${started.output() || '(no server output)'}`,
      );
    }
    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${started.port}${pathname}`,
        { signal: globalThis.AbortSignal.timeout(1_000) },
      );
      if (response.ok) {
        return response;
      }
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }

  throw new Error(
    `Rendered-page test server did not start within 30 seconds.\n${started.output() || '(no server output)'}`,
  );
}

function postVerification(port, token) {
  return globalThis.fetch(`http://127.0.0.1:${port}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: `http://127.0.0.1:${port}`,
    },
    body: new globalThis.URLSearchParams({ token }),
  });
}

test('scanner GETs are inert, then token-authenticated POST verifies and replays safely', async () => {
  await executeFile('npm', ['run', 'build']);
  const fixture = await createDatabaseFixture();
  const subscriberId = randomUUID();
  const tokenId = randomUUID();
  const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET);
  await fixture.database.query(
    `
      INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `,
    [
      subscriberId,
      'verify@example.test',
      'verify@example.test',
      'example.test',
    ],
  );
  const expiredTokenId = randomUUID();
  const expiredToken = deriveEmailToken(
    expiredTokenId,
    process.env.EMAIL_TOKEN_SECRET,
  );
  await fixture.database.query(
    `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      )
      VALUES ($1, $2, $3, 'verify', $4)
    `,
    [
      expiredTokenId,
      subscriberId,
      createHash('sha256').update(expiredToken).digest(),
      new Date('2000-01-01T00:00:00.000Z'),
    ],
  );
  await fixture.database.query(
    `
      INSERT INTO verification_token (
        id,
        subscriber_id,
        token_hash,
        purpose,
        expires_at
      )
      VALUES ($1, $2, $3, 'verify', $4)
    `,
    [
      tokenId,
      subscriberId,
      createHash('sha256').update(token).digest(),
      new Date('2099-01-01T00:00:00.000Z'),
    ],
  );
  let started;
  try {
    started = await startServer(fixture.databaseUrl);
    const { port, signup } = started;
    const scannerGet = await waitForPage(
      started,
      `/verify?token=${encodeURIComponent(token)}`,
    );
    const prefetchGet = await waitForPage(
      started,
      `/verify?token=${encodeURIComponent(token)}`,
    );
    for (const response of [scannerGet, prefetchGet]) {
      assert.match(await response.text(), /Confirm email address/u);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
    const beforePost = await fixture.database.query(
      `SELECT s.status, t.consumed_at
       FROM subscriber s JOIN verification_token t ON t.subscriber_id = s.id
       WHERE s.id = $1`,
      [subscriberId],
    );
    assert.equal(beforePost.rows[0]?.status, 'pending');
    assert.equal(beforePost.rows[0]?.consumed_at, null);

    const verification = await postVerification(port, token);
    const replay = await postVerification(port, token);
    const expired = await postVerification(port, expiredToken);
    const invalid = await postVerification(port, 'unknown-verification-token');
    assert.equal(signup.headers.get('set-cookie'), null);
    assert.equal(verification.headers.get('set-cookie'), null);
    assert.equal(replay.headers.get('set-cookie'), null);
    assert.match(
      await signup.text(),
      /<form action="\/api\/signup" method="post">/u,
    );
    const verificationBody = await verification.text();
    const replayBody = await replay.text();
    const surveyForm = verificationBody.match(
      /<form[^>]+action="\/api\/survey"[\s\S]*?<\/form>/u,
    )?.[0];
    assert.ok(surveyForm);
    assert.match(
      surveyForm,
      /name="version" type="hidden" value="2026-10-19"/u,
    );
    for (const label of [
      'AI tools',
      'Streaming and subscriptions',
      'Software',
      'Gift cards',
      'Game keys',
      'Game top-ups',
      'In-game currency',
      'How often do you buy digital goods?',
    ])
      assert.ok(surveyForm.includes(label), label);
    assert.doesNotMatch(
      surveyForm,
      />Apparel<|>Footwear<|>Accessories<|>Home<|>Beauty</u,
    );
    const surveyToken = surveyForm.match(
      /name="token" type="hidden" value="([^"]+)"/u,
    )?.[1];
    assert.ok(surveyToken);
    const surveyResponse = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/survey`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: new globalThis.URLSearchParams([
          ['token', surveyToken],
          ['version', '2026-10-19'],
          ['category_preference', 'ai'],
          ['category_preference', 'game_keys'],
          ['shopping_frequency', 'weekly'],
        ]),
      },
    );
    assert.equal(surveyResponse.status, 200);
    assert.deepEqual(await surveyResponse.json(), {
      message: 'Your preferences are saved.',
      status: 'saved',
    });
    const storedSurvey = await fixture.database.query(
      `SELECT r.version,r.answers,s.category_preference
        FROM survey_response r JOIN subscriber s ON s.id=r.subscriber_id
        WHERE r.subscriber_id=$1`,
      [subscriberId],
    );
    assert.deepEqual(storedSurvey.rows[0], {
      version: '2026-10-19',
      answers: {
        category_preference: ['ai', 'game_keys'],
        shopping_frequency: 'weekly',
      },
      category_preference: ['ai', 'game_keys'],
    });
    for (const body of [verificationBody, replayBody]) {
      assert.match(body, /Your email address is verified\./u);
      assert.match(body, /Share your referral link/u);
      assert.match(body, /Help us prepare for launch/u);
      assert.match(body, /View your status/u);
    }
    const expiredBody = await expired.text();
    const invalidBody = await invalid.text();
    assert.equal(expiredBody, invalidBody);
    assert.match(expiredBody, /Request a new link/u);
    assert.match(expiredBody, /action="\/api\/resend-verification"/u);
    const subscriber = await fixture.database.query(
      'SELECT status, verified_at FROM subscriber WHERE id = $1',
      [subscriberId],
    );
    assert.equal(subscriber.rows[0]?.status, 'verified');
    assert.notEqual(subscriber.rows[0]?.verified_at, null);
  } finally {
    await stopServer(started?.server);
    await fixture.dispose();
  }
});

test('with survey.enabled off, the rendered verification success page omits the survey form and questions', async () => {
  await executeFile('npm', ['run', 'build']);
  const fixture = await createDatabaseFixture();
  const subscriberId = randomUUID();
  const tokenId = randomUUID();
  const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET);
  await fixture.database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by) VALUES ($1, $2, $3)`,
    ['survey.enabled', false, 'e3-07-rendered-page-test'],
  );
  await fixture.database.query(
    `
      INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `,
    [
      subscriberId,
      'survey-disabled@example.test',
      'survey-disabled@example.test',
      'example.test',
    ],
  );
  await fixture.database.query(
    `
      INSERT INTO verification_token (
        id,
        subscriber_id,
        token_hash,
        purpose,
        expires_at
      )
      VALUES ($1, $2, $3, 'verify', $4)
    `,
    [
      tokenId,
      subscriberId,
      createHash('sha256').update(token).digest(),
      new Date('2099-01-01T00:00:00.000Z'),
    ],
  );
  let started;
  try {
    started = await startServer(fixture.databaseUrl);
    const { port } = started;
    const confirmation = await waitForPage(
      started,
      `/verify?token=${encodeURIComponent(token)}`,
    );
    assert.match(await confirmation.text(), /Confirm email address/u);
    const verification = await postVerification(port, token);
    const body = await verification.text();
    assert.match(body, /Your email address is verified\./u);
    assert.ok(!/<form[^>]+action="\/api\/survey"/u.test(body));
    assert.ok(!body.includes('name="category_preference"'));
    assert.ok(!body.includes('name="shopping_frequency"'));
    assert.ok(!body.includes('Help us prepare for launch'));
    assert.equal(verification.headers.get('set-cookie'), null);
  } finally {
    await stopServer(started?.server);
    await fixture.dispose();
  }
});
