import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { startAppServer } from './helpers/listen-port.mjs';

const executeFile = promisify(execFile);

async function withServer(run) {
  // A reserved port below the kernel's ephemeral range (see
  // test/helpers/listen-port.mjs).
  const app = await startAppServer({
    label: 'Trustpilot /legit',
    readyPath: '/legit',
    env: (port) => ({
      ADMIN_CREDENTIAL: 'trustpilot-test-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL:
        'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
      EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
      EMAIL_TOKEN_SECRET: 'trustpilot-test-email-token-secret-32-chars',
      IP_PREFIX_PEPPER: 'trustpilot-test-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'trustpilot-test-referral-secret',
      RESEND_API_KEY: 'trustpilot-test-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
      BREVO_WEBHOOK_TOKEN: 'trustpilot-test-brevo-webhook-token-32-chars',
      TURNSTILE_SECRET_KEY: 'trustpilot-test-turnstile-secret',
      HOST: '127.0.0.1',
    }),
  });
  const origin = `http://127.0.0.1:${app.port}`;
  try {
    const response = await globalThis.fetch(`${origin}/legit`);
    assert.ok(response.ok, '/legit server starts');
    await run(await response.text());
  } finally {
    await app.stop();
  }
}

test('E9-08 keeps the profile link and not-yet Reviews copy without a widget', async () => {
  await executeFile('npm', ['run', 'build']);
  await withServer((html) => {
    assert.match(
      html,
      /<a href="https:\/\/www\.trustpilot\.com\/review\/valstara\.com" rel="noopener">our Trustpilot page<\/a>/u,
    );
    assert.match(
      html,
      /We do not show a Trustpilot star rating on this site yet\./u,
    );
    assert.match(html, /We will never buy reviews\./u);
    assert.match(html, /<title>Who runs Valstara<\/title>/u);
    assert.match(
      html,
      /<meta name="description" content="Valstara is a trading brand/u,
    );
    assert.match(
      html,
      /<link rel="canonical" href="https:\/\/valstara\.com\/legit"/u,
    );
    const jsonLd =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html);
    assert.ok(jsonLd);
    assert.equal(JSON.parse(jsonLd[1])['@type'], 'Organization');
    assert.match(html, /<h1[^>]*>Who runs Valstara<\/h1>/u);
    assert.doesNotMatch(
      html,
      /Source notes|\b(?:TODO|TBD|lorem ipsum|placeholder|dummy copy)\b/iu,
    );
    const emitter = html.match(
      /<script defer src="\/page-view\.js" data-website-id="[a-f0-9-]{36}"><\/script>/u,
    );
    assert.ok(emitter, '/legit needs the approved page-view emitter');
    assert.doesNotMatch(
      html
        .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/u, '')
        .replace(emitter[0], ''),
      /<script\b|\.js(?:["?]|$)/iu,
    );
    assert.doesNotMatch(
      html,
      /widget\.trustpilot\.com|images-static\.trustpilot\.com|data-template-id=/u,
    );
    assert.doesNotMatch(
      html,
      /<link[^>]+(?:prefetch|preconnect)[^>]+trustpilot\.com/iu,
    );
  });
});
