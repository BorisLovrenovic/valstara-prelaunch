import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';
import {
  startAppServer,
  type StartedAppServer,
} from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

const adminDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

test('E6-06 confirmation page keeps GET inert and offers an honest retry after an atomic failure', async () => {
  const name = `valstara_e606page_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(adminDatabaseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  const tokenId = randomUUID();
  const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET!);
  const subscriberId = randomUUID();
  const alertBodies: Record<string, unknown>[] = [];
  const alertServer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    alertBodies.push(JSON.parse(body));
    response.writeHead(200).end();
  });
  let app: StartedAppServer | undefined;
  try {
    await runMigrations(owner, {
      applicationRolePassword: appPassword,
      release: 'e6-06-page-test',
    });
    await owner.execute({
      text: "INSERT INTO subscriber (id, email, email_normalised, email_domain, status, verified_at) VALUES ($1, $2, $2, 'example.test', 'verified', CURRENT_TIMESTAMP)",
      values: [subscriberId, `${subscriberId}@example.test`],
    });
    await owner.execute({
      text: "INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, 'unsubscribe', '2099-01-01T00:00:00.000Z')",
      values: [
        tokenId,
        subscriberId,
        createHash('sha256').update(token).digest(),
      ],
    });
    await owner.execute({
      text: "INSERT INTO email_send (id, subscriber_id, template, provider, business_key, state, unsubscribe_token_id) VALUES ($1, $2, 'status_link', 'resend', $3, 'sent', $4)",
      values: [randomUUID(), subscriberId, randomUUID(), tokenId],
    });
    const oneClickTokenId = randomUUID();
    const oneClickToken = deriveEmailToken(
      oneClickTokenId,
      process.env.EMAIL_TOKEN_SECRET!,
    );
    await owner.execute({
      text: "INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, 'unsubscribe', '2099-01-01T00:00:00.000Z')",
      values: [
        oneClickTokenId,
        subscriberId,
        createHash('sha256').update(oneClickToken).digest(),
      ],
    });
    await owner.execute({
      text: "INSERT INTO email_send (id, subscriber_id, template, provider, business_key, state, unsubscribe_token_id) VALUES ($1, $2, 'status_link', 'resend', $3, 'sent', $4)",
      values: [randomUUID(), subscriberId, randomUUID(), oneClickTokenId],
    });
    await owner.execute({
      text: "CREATE FUNCTION reject_suppression() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$",
    });
    await owner.execute({
      text: 'CREATE TRIGGER reject_suppression BEFORE INSERT ON suppression FOR EACH ROW EXECUTE FUNCTION reject_suppression()',
    });
    await ensureAppBuild();
    alertServer.listen(0, '127.0.0.1');
    await once(alertServer, 'listening');
    const alertAddress = alertServer.address();
    assert.ok(alertAddress && typeof alertAddress !== 'string');
    // A reserved port below the kernel's ephemeral range (see
    // test/helpers/listen-port.mjs). Readiness is probed on the bare route, so
    // the first request carrying the token is the one asserted below.
    app = await startAppServer({
      label: 'Unsubscribe page',
      entry: 'scripts/fixtures/run-unsubscribe-server.mjs',
      readyPath: '/unsubscribe',
      env: (port) => ({
        ADMIN_CREDENTIAL: 'unsubscribe-admin-credential-32-characters',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL: appUrl.toString(),
        EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
        EMAIL_TOKEN_SECRET: process.env.EMAIL_TOKEN_SECRET,
        HOST: '127.0.0.1',
        IP_PREFIX_PEPPER: 'unsubscribe-page-test-pepper',
        P1_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertAddress.port}/alert`,
        P1_ALERT_WEBHOOK_TOKEN: 'unsubscribe-alert-test-token',
        REFERRAL_SIGNING_SECRET: 'unsubscribe-page-referral-secret',
        RESEND_API_KEY: 'unsubscribe-page-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: 'unsubscribe-turnstile-secret',
      }),
    });
    const { port } = app;
    const target = `http://127.0.0.1:${port}/unsubscribe?t=${encodeURIComponent(token)}`;
    const get = await fetch(target);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('set-cookie'), null);
    const confirmation = await get.text();
    assert.match(confirmation, /Choose what to stop/u);
    assert.match(confirmation, /Leave the waitlist and stop all email/u);
    assert.doesNotMatch(
      confirmation,
      /turnstile_token|challenges\.cloudflare\.com/u,
    );
    const unconsumed = await owner.readOne<{ consumed_at: Date | null }>({
      text: 'SELECT consumed_at FROM verification_token WHERE id = $1',
      values: [tokenId],
    });
    assert.equal(unconsumed?.consumed_at, null);

    const post = () =>
      fetch(`http://127.0.0.1:${port}/unsubscribe`, {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${port}` },
        body: new URLSearchParams({ t: token, intent: 'message' }),
      });
    const failed = await post();
    assert.equal(failed.status, 503);
    const failedBody = await failed.text();
    assert.match(failedBody, /Your choice was not saved\. Please try again\./u);
    assert.match(failedBody, /Try again/u);
    assert.match(failedBody, /name="t"/u);
    assert.equal(alertBodies.length, 1);
    await owner.execute({
      text: 'DROP TRIGGER reject_suppression ON suppression',
    });
    const retried = await post();
    assert.equal(retried.status, 200);
    assert.match(await retried.text(), /Your choice is saved/u);
    const suppression = await owner.readOne({
      text: 'SELECT 1 FROM suppression WHERE email_normalised = (SELECT email_normalised FROM subscriber WHERE id = $1)',
      values: [subscriberId],
    });
    assert.ok(suppression);
    const oneClick = await fetch(
      `http://127.0.0.1:${port}/api/unsubscribe?token=${encodeURIComponent(oneClickToken)}`,
      {
        method: 'POST',
        body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
      },
    );
    assert.equal(oneClick.status, 200);
    assert.equal(oneClick.headers.get('set-cookie'), null);
    const otherWrite = await fetch(`http://127.0.0.1:${port}/api/signup`, {
      method: 'POST',
      body: new URLSearchParams({ email: 'else@example.test' }),
    });
    assert.equal(otherWrite.status, 403);
  } finally {
    await app?.stop();
    if (alertServer.listening) {
      alertServer.close();
      await once(alertServer, 'close');
    }
    await owner.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [name],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${name}"` });
    await admin.close();
  }
});
