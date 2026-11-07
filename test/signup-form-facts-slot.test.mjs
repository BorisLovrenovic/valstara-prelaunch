import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';
import { experimental_AstroContainer } from 'astro/container';
import { createServer } from 'vite';

// E11.5-11l: the signup island renders its trust-facts wrapper, and the
// divider drawn on it, only when the facts slot is filled. The landing page
// always fills it, so the island is rendered here on its own, through Vite's
// SSR loader and Astro's container, with the slot filled and empty.
const islandPath = fileURLToPath(
  new URL('../src/islands/SignupForm.astro', import.meta.url),
);

// The island reads the public Turnstile site key from the validated server
// config at render time, so the render needs a complete local config.
const localConfig = {
  ADMIN_CREDENTIAL: 'facts-slot-admin-credential-32-chars',
  ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-facts',
  IP_PREFIX_PEPPER: 'facts-slot-prefix-pepper',
  REFERRAL_SIGNING_SECRET: 'facts-slot-referral-secret',
  RESEND_API_KEY: 'facts-slot-resend-key',
  RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
  RESEND_KEY_MODE: 'test',
  RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
  RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
  RESEND_SENDING_DOMAIN: 'send.valstara.com',
  TURNSTILE_SECRET_KEY: 'facts-slot-turnstile-secret',
};

let server;
let container;
let SignupForm;

before(async () => {
  Object.assign(process.env, localConfig);
  const config = await getViteConfig(
    { server: { middlewareMode: true }, logLevel: 'silent' },
    { logLevel: 'silent' },
  )({ mode: 'test', command: 'serve' });
  server = await createServer(config);
  SignupForm = (await server.ssrLoadModule(islandPath)).default;
  container = await experimental_AstroContainer.create();
});

after(async () => {
  await server?.close();
});

const props = { signedReferralCapture: null, giveawayEnabled: false };
const wrappers = (html) => html.match(/class="signup-facts"/gu)?.length ?? 0;

test('the trust-facts wrapper renders only when its slot is filled', async () => {
  const filled = await container.renderToString(SignupForm, {
    props,
    slots: { facts: '<ul class="facts-probe"><li>A fact</li></ul>' },
  });
  assert.equal(wrappers(filled), 1, 'one wrapper with the slot filled');
  assert.match(
    filled,
    /<div class="signup-facts"[^>]*>\s*<ul class="facts-probe">/u,
    'the wrapper holds the slotted facts',
  );

  const empty = await container.renderToString(SignupForm, { props });
  assert.equal(wrappers(empty), 0, 'no wrapper with the slot empty');
  // The rest of the card still renders without the facts.
  assert.match(empty, /<form action="\/api\/signup" method="post">/u);
  assert.match(empty, /class="signup-consent"/u);
});
