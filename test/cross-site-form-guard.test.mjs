import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { request } from 'node:http';
import test, { after, before } from 'node:test';

import { securityCopy } from '../src/copy/security.ts';
import { startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

// The middleware's cross-site form guard compares Origin with the request's
// scheme plus its own Host header (founder decision D-010, 2026-11-17). Each
// case posts a form to /api/signup with no Turnstile token: a request the guard
// lets through reaches the route and is rejected there with 400
// challenge_failed before any database or provider work; a request the guard
// stops never reaches the route and gets 403 with the cross-site copy.
let app;

before(async () => {
  await ensureAppBuild();
  app = await startAppServer({
    label: 'Cross-site form guard test',
    env: () => ({
      ADMIN_CREDENTIAL: 'cross-site-guard-admin-credential-32',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL:
        'postgresql://unused:unused@127.0.0.1:5434/unused-cross-site-guard',
      EMAIL_BASE_URL: 'http://localhost:4321',
      EMAIL_TOKEN_SECRET: 'cross-site-guard-email-token-secret-32-chars',
      HOST: '127.0.0.1',
      IP_PREFIX_PEPPER: 'cross-site-guard-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'cross-site-guard-referral-secret',
      RESEND_API_KEY: 'cross-site-guard-resend-key',
      RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
      BREVO_WEBHOOK_TOKEN: 'cross-site-guard-brevo-webhook-token',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'cross-site-guard-turnstile-secret',
    }),
  });
});

after(async () => {
  await app?.stop();
});

function postForm(headers) {
  const body = new globalThis.URLSearchParams({
    email: 'guard@example.test',
  }).toString();
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port: app.port,
        path: '/api/signup',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode, text }),
        );
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function assertPassedGuard(response) {
  assert.equal(response.status, 400, response.text);
  assert.equal(JSON.parse(response.text).error.code, 'challenge_failed');
}

function assertBlocked(response) {
  assert.equal(response.status, 403, response.text);
  assert.equal(response.text, securityCopy.crossSiteForm);
}

test('a same-origin form post on 127.0.0.1:<port> passes the guard', async () => {
  assertPassedGuard(await postForm({ Origin: `http://127.0.0.1:${app.port}` }));
});

test('a form post from a foreign Origin gets 403', async () => {
  assertBlocked(await postForm({ Origin: 'https://attacker.example' }));
});

test('a same-host Origin with a different scheme gets 403', async () => {
  assertBlocked(await postForm({ Origin: `https://127.0.0.1:${app.port}` }));
});

test('behind Caddy, Origin https://valstara.com passes for Host valstara.com over X-Forwarded-Proto https', async () => {
  assertPassedGuard(
    await postForm({
      Host: 'valstara.com',
      'X-Forwarded-Proto': 'https',
      Origin: 'https://valstara.com',
    }),
  );
});

test('behind Caddy, a foreign Origin gets 403 for Host valstara.com', async () => {
  assertBlocked(
    await postForm({
      Host: 'valstara.com',
      'X-Forwarded-Proto': 'https',
      Origin: 'https://attacker.example',
    }),
  );
});
