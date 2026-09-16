import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import test, { before } from 'node:test';

import { Pool } from 'pg';

import { landingCopy } from '../src/copy/landing.ts';

const executeFile = promisify(execFile);

// Astro escapes text content the way the HTML spec requires, so copy strings
// carrying an apostrophe or quote reach the page as entities. Assert against
// the escaped form rather than the raw source string.
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function rendersCopy(body, value) {
  return body.includes(escapeHtml(value));
}
const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

let nextPort = 43_240;

function startServer(databaseUrl) {
  const port = (nextPort += 1);
  const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      ADMIN_CREDENTIAL: 'landing-rendered-admin-credential-32',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'landing-rendered-page-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'landing-rendered-page-referral-secret',
      RESEND_API_KEY: 'landing-rendered-page-resend-key',
      RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
      TURNSTILE_SECRET_KEY: 'landing-rendered-page-turnstile-secret',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: 'ignore',
  });
  return { port, server };
}

async function createDatabaseFixture() {
  const databaseName = `valstara_landing_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const database = new Pool({ connectionString: databaseUrl.toString() });

  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'landing-rendered-page-test'],
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

async function fetchLanding(port, path = '/') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${port}${path}`,
      );
      if (response.ok) {
        const body = await response.text();
        return {
          body,
          cacheControl: response.headers.get('cache-control'),
          flagGeneration: response.headers.get('x-valstara-flag-generation'),
          setCookie: response.headers.get('set-cookie'),
          vary: response.headers.get('vary'),
        };
      }
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error('Landing rendered-page test server did not start.');
}

// `flags` seeds `campaign_flag` rows before the server boots, so the server's
// first flag read already reflects them (its in-process cache starts empty).
// `paths` fetches one or more paths from the same running server. The single
// path is returned unwrapped so the common case reads as before.
async function renderLanding({ flags = [], paths = ['/'] } = {}) {
  const fixture = await createDatabaseFixture();
  for (const { key, enabled } of flags) {
    await fixture.database.query(
      `INSERT INTO campaign_flag (key, enabled, updated_by) VALUES ($1, $2, $3)`,
      [key, enabled, 'landing-rendered-page-test'],
    );
  }
  const { port, server } = startServer(fixture.databaseUrl);
  try {
    const responses = [];
    for (const path of paths) {
      responses.push(await fetchLanding(port, path));
    }
    return paths.length === 1 ? responses[0] : responses;
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
    await fixture.dispose();
  }
}

const signupOn = { enabled: true, key: 'signup.enabled' };
const signupOff = { enabled: false, key: 'signup.enabled' };

before(async () => {
  await executeFile('npm', ['run', 'build']);
});

test('with signup.enabled on, the landing page renders the signup form and every section', async () => {
  const { body, setCookie } = await renderLanding({ flags: [signupOn] });

  // The form posts to the signup route with no extra attributes, so the E1-11
  // slice's contract holds and E3-05 can later hydrate exactly this element.
  assert.match(body, /<form action="\/api\/signup" method="post">/u);
  assert.match(body, /name="email"/u);

  // Every visible string comes from the copy layer, not from inline prose.
  assert.ok(rendersCopy(body, landingCopy.hero.heading));
  assert.ok(rendersCopy(body, landingCopy.hero.eyebrow));
  assert.ok(rendersCopy(body, landingCopy.hero.body));
  assert.ok(rendersCopy(body, landingCopy.form.submit));
  assert.ok(rendersCopy(body, landingCopy.whatIs.heading));
  assert.ok(rendersCopy(body, landingCopy.whatIs.body));
  assert.ok(rendersCopy(body, landingCopy.whatIs.tagline));
  assert.ok(rendersCopy(body, landingCopy.trust.heading));
  assert.ok(rendersCopy(body, landingCopy.trust.note));
  for (const promise of landingCopy.trust.promises) {
    assert.ok(rendersCopy(body, promise.title));
  }
  for (const item of landingCopy.faq.items) {
    assert.ok(rendersCopy(body, item.question));
    assert.ok(rendersCopy(body, item.answer));
  }

  // The paused message is absent while signups are open.
  assert.ok(!rendersCopy(body, landingCopy.paused.heading));

  // A rendered page sets no cookie.
  assert.equal(setCookie, null);
});

test('with signup.enabled off, an honest paused message replaces the form', async () => {
  const { body, setCookie } = await renderLanding({ flags: [signupOff] });

  // The form is gone — not present-but-broken — so nothing can fail on submit.
  assert.ok(!/<form action="\/api\/signup"/u.test(body));
  assert.ok(!body.includes('name="email"'));

  // The paused copy comes from the copy layer and names no machinery.
  assert.ok(rendersCopy(body, landingCopy.paused.heading));
  assert.ok(rendersCopy(body, landingCopy.paused.body));

  assert.equal(setCookie, null);
});

test('the landing page ships only the theme toggle and signup form islands', async () => {
  // Measured from the built-and-served output. The landing page carries two
  // islands — the theme toggle (its inline bootstrap plus its island script) and
  // the signup form (E3-05) — plus Cloudflare's Turnstile loader, the one
  // always-on off-origin request (ADR-006, Option A). Every script must fall
  // into one of these three buckets; a third island or a stray script fails.
  const { body } = await renderLanding({ flags: [signupOn] });

  const scripts = [
    ...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu),
  ].map(([, attributes, content]) => ({ attributes, content }));
  const theme = scripts.filter((script) =>
    script.content.includes('valstara-theme'),
  );
  const signupIsland = scripts.filter((script) =>
    /SignupForm\.astro[^"']*\.js/u.test(script.attributes),
  );
  const turnstileLoader = scripts.filter((script) =>
    script.attributes.includes('challenges.cloudflare.com/turnstile'),
  );

  assert.equal(theme.length, 2, 'the two theme-toggle scripts ship');
  assert.equal(signupIsland.length, 1, 'exactly one signup form island ships');
  assert.equal(turnstileLoader.length, 1, 'the Turnstile loader ships once');
  assert.equal(
    scripts.length,
    theme.length + signupIsland.length + turnstileLoader.length,
    'no other script ships (no third island)',
  );

  // No hydrated framework island is introduced, and no client directive leaks.
  assert.ok(!/client:(?:load|idle|visible|media|only)/u.test(body));
});

test('the landing cache header follows flag state and a ref, from the rendered page', async () => {
  // Default flag state, no ref: the page is edge-cacheable, keyed on country and
  // the flag generation. This is the fast path E12 relies on for the spike.
  const [cacheable, referred] = await renderLanding({
    paths: ['/', '/?ref=signed-ref'],
  });
  assert.equal(cacheable.cacheControl, 'public, max-age=0, s-maxage=300');
  assert.equal(cacheable.vary, 'CF-IPCountry, X-Valstara-Flag-Generation');
  assert.match(cacheable.flagGeneration ?? '', /^[a-f0-9]{16}$/u);

  // A signed referral is per-request and must never be served from cache.
  assert.equal(referred.cacheControl, 'private, no-store');

  // A non-default flag state must bypass the cache too — otherwise a stale edge
  // copy outlives a flag flip. `giveaway.open` defaults off, so turning it on is
  // a non-default state that does not change the rendered form: this proves the
  // bypass is driven by the flag generation itself, and it fails if the page
  // stops consulting `hasNonDefaultFlagState`.
  const flagged = await renderLanding({
    flags: [{ enabled: true, key: 'giveaway.open' }],
  });
  assert.equal(flagged.cacheControl, 'private, no-store');
  assert.match(flagged.body, /<form action="\/api\/signup" method="post">/u);
});

test('referral.enabled off omits the signed attribution field without pausing signup', async () => {
  const { body } = await renderLanding({
    flags: [signupOn, { enabled: false, key: 'referral.enabled' }],
    paths: ['/?ref=ABCDEF123456&utm_source=newsletter'],
  });
  assert.match(body, /<form action="\/api\/signup" method="post">/u);
  assert.doesNotMatch(body, /name="referral_capture"/u);
});
