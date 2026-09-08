import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';

import { Pool } from 'pg';

const executeFile = promisify(execFile);
const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

function startServer(databaseUrl) {
  const port = 43_220;
  const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'rendered-page-test-prefix-pepper',
      RESEND_API_KEY: 'rendered-page-test-resend-key',
      RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
      TURNSTILE_SECRET_KEY: 'rendered-page-test-turnstile-secret',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: 'ignore',
  });

  return { port, server };
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

async function waitForPage(port, pathname) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${port}${pathname}`,
      );
      if (response.ok) {
        return response;
      }
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }

  throw new Error('Rendered-page test server did not start.');
}

test('the rendered E3-07 verification success page replays safely and sets no cookie', async () => {
  await executeFile('npm', ['run', 'build']);
  const fixture = await createDatabaseFixture();
  const subscriberId = randomUUID();
  const tokenId = randomUUID();
  const token = 'valid-thin-verification-token';
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
  const { port, server } = startServer(fixture.databaseUrl);

  try {
    const signup = await waitForPage(port, '/');
    const verification = await waitForPage(
      port,
      `/verify?token=${encodeURIComponent(token)}`,
    );
    const replay = await waitForPage(
      port,
      `/verify?token=${encodeURIComponent(token)}`,
    );
    assert.equal(signup.headers.get('set-cookie'), null);
    assert.equal(verification.headers.get('set-cookie'), null);
    assert.equal(replay.headers.get('set-cookie'), null);
    assert.match(
      await signup.text(),
      /<form action="\/api\/signup" method="post">/u,
    );
    const verificationBody = await verification.text();
    const replayBody = await replay.text();
    for (const body of [verificationBody, replayBody]) {
      assert.match(body, /Your email address is verified\./u);
      assert.match(body, /Share your referral link/u);
      assert.match(body, /Help us prepare for launch/u);
      assert.match(body, /View your status/u);
    }
    const subscriber = await fixture.database.query(
      'SELECT status, verified_at FROM subscriber WHERE id = $1',
      [subscriberId],
    );
    assert.equal(subscriber.rows[0]?.status, 'verified');
    assert.notEqual(subscriber.rows[0]?.verified_at, null);
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
    await fixture.dispose();
  }
});

test('with survey.enabled off, the rendered verification success page omits the survey form and questions', async () => {
  await executeFile('npm', ['run', 'build']);
  const fixture = await createDatabaseFixture();
  const subscriberId = randomUUID();
  const tokenId = randomUUID();
  const token = 'survey-disabled-verification-token';
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
  const { port, server } = startServer(fixture.databaseUrl);

  try {
    const verification = await waitForPage(
      port,
      `/verify?token=${encodeURIComponent(token)}`,
    );
    const body = await verification.text();
    assert.match(body, /Your email address is verified\./u);
    assert.ok(!/<form[^>]+action="\/api\/survey"/u.test(body));
    assert.ok(!body.includes('name="category_preference"'));
    assert.ok(!body.includes('name="shopping_frequency"'));
    assert.ok(!body.includes('Help us prepare for launch'));
    assert.equal(verification.headers.get('set-cookie'), null);
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
    await fixture.dispose();
  }
});
