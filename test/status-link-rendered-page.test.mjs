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

async function createDatabaseFixture() {
  const databaseName = `valstara_e604render_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const database = new Pool({ connectionString: databaseUrl.toString() });

  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await executeFile(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'e6-04-rendered-page-test'],
    {
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: databaseUrl.toString(),
        VALSTARA_APP_DB_PASSWORD: applicationRolePassword,
      },
    },
  );
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

function startServer(databaseUrl) {
  const port = 43_290;
  const providerStub = `data:text/javascript,${encodeURIComponent(`
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
        return Response.json({ success: true });
      }
      return realFetch(input, init);
    };
  `)}`;
  const server = spawn(
    process.execPath,
    ['--import', providerStub, 'dist/server/entry.mjs'],
    {
      env: {
        ...process.env,
        ADMIN_CREDENTIAL: 'status-link-admin-credential-32-chars',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL: databaseUrl,
        HOST: '127.0.0.1',
        IP_PREFIX_PEPPER: 'status-link-prefix-pepper',
        PORT: String(port),
        REFERRAL_SIGNING_SECRET: 'status-link-referral-secret',
        RESEND_API_KEY: 'status-link-resend-key',
        RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
        TURNSTILE_SECRET_KEY: 'status-link-turnstile-secret',
      },
      stdio: 'ignore',
    },
  );
  return { port, server };
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/me`);
      if (response.ok) return;
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error('Status-link rendered-page server did not start.');
}

test('the status page makes expiry and tampering identical, sets no cookie, and offers one-click recovery', async () => {
  await executeFile('npm', ['run', 'build']);
  const fixture = await createDatabaseFixture();
  const subscriberId = randomUUID();
  const otherSubscriberId = randomUUID();
  const expiredToken = 'rendered-expired-status-token';
  const validToken = 'rendered-valid-status-token';
  await fixture.database.query(
    `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at
      )
      VALUES ($1, $2, $2, 'example.test', 'verified', CURRENT_TIMESTAMP)
    `,
    [subscriberId, 'status-owner@example.test'],
  );
  await fixture.database.query(
    `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at
      )
      VALUES ($1, $2, $2, 'example.test', 'verified', CURRENT_TIMESTAMP)
    `,
    [otherSubscriberId, 'other-status-owner@example.test'],
  );
  await fixture.database.query(
    `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      )
      VALUES ($1, $2, $3, 'status', $4)
    `,
    [
      randomUUID(),
      subscriberId,
      createHash('sha256').update(expiredToken).digest(),
      new Date('2000-01-01T00:00:00.000Z'),
    ],
  );
  await fixture.database.query(
    `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      )
      VALUES ($1, $2, $3, 'status', $4)
    `,
    [
      randomUUID(),
      subscriberId,
      createHash('sha256').update(validToken).digest(),
      new Date('2099-01-01T00:00:00.000Z'),
    ],
  );
  const { port, server } = startServer(fixture.databaseUrl);

  try {
    await waitForServer(port);
    const expired = await globalThis.fetch(
      `http://127.0.0.1:${port}/me?t=${encodeURIComponent(expiredToken)}`,
    );
    const tampered = await globalThis.fetch(
      `http://127.0.0.1:${port}/me?t=tampered-rendered-status-token`,
    );
    const expiredBody = await expired.text();
    const tamperedBody = await tampered.text();

    assert.equal(expired.status, 200);
    assert.equal(tampered.status, 200);
    assert.equal(expired.headers.get('set-cookie'), null);
    assert.equal(tampered.headers.get('set-cookie'), null);
    assert.equal(expiredBody, tamperedBody);
    assert.match(expiredBody, /<form method="post"[^>]*>/u);
    assert.match(expiredBody, /data-response-field-name="turnstile_token"/u);
    assert.match(
      expiredBody,
      /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/u,
    );
    assert.match(expiredBody, /Email me a new link/u);

    const authenticated = await globalThis.fetch(
      `http://127.0.0.1:${port}/me?t=${encodeURIComponent(validToken)}`,
    );
    const authenticatedBody = await authenticated.text();
    assert.equal(authenticated.headers.get('set-cookie'), null);
    assert.match(authenticatedBody, /Your waitlist status/u);
    for (const forbidden of [
      subscriberId,
      otherSubscriberId,
      'status-owner@example.test',
      'other-status-owner@example.test',
    ]) {
      assert.ok(!authenticatedBody.includes(forbidden));
    }

    const recovery = await globalThis.fetch(
      `http://127.0.0.1:${port}/me?t=${encodeURIComponent(expiredToken)}`,
      {
        body: new globalThis.URLSearchParams(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: `http://127.0.0.1:${port}`,
        },
        method: 'POST',
      },
    );
    assert.equal(recovery.status, 400);
    const rejectedWrites = await fixture.database.query(`
      SELECT
        (SELECT COUNT(*)::integer FROM rate_limit_bucket) AS rate_limits,
        (SELECT COUNT(*)::integer FROM email_send) AS sends
    `);
    assert.deepEqual(rejectedWrites.rows, [{ rate_limits: 0, sends: 0 }]);
    assert.equal(recovery.headers.get('set-cookie'), null);
    assert.match(await recovery.text(), /security check did not go through/u);

    const acceptedRecovery = await globalThis.fetch(
      `http://127.0.0.1:${port}/me?t=${encodeURIComponent(expiredToken)}`,
      {
        body: new globalThis.URLSearchParams({
          turnstile_token: 'rendered-page-turnstile-token',
        }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: `http://127.0.0.1:${port}`,
        },
        method: 'POST',
      },
    );
    assert.equal(acceptedRecovery.headers.get('set-cookie'), null);
    const recoveryBody = await acceptedRecovery.text();
    assert.match(
      recoveryBody,
      /If this link can be renewed, a new one will arrive by email\./u,
    );
    const tamperedRecovery = await globalThis.fetch(
      `http://127.0.0.1:${port}/me?t=tampered-rendered-status-token`,
      {
        body: new globalThis.URLSearchParams({
          turnstile_token: 'another-rendered-page-turnstile-token',
        }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: `http://127.0.0.1:${port}`,
        },
        method: 'POST',
      },
    );
    assert.equal(await tamperedRecovery.text(), recoveryBody);
    const sends = await fixture.database.query(
      'SELECT subscriber_id, template FROM email_send',
    );
    assert.deepEqual(sends.rows, [
      { subscriber_id: subscriberId, template: 'status_link' },
    ]);
  } finally {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
    await fixture.dispose();
  }
});
