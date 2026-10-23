import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import test, { before } from 'node:test';

import { Pool } from 'pg';

import { landingCopy } from '../src/copy/landing.ts';
import { signupFormCopy } from '../src/copy/signup.ts';
import { createReferralCaptureService } from '../src/server/referral/capture.ts';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

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

// Stay outside Linux's usual ephemeral client-port range during the full suite.
let nextPort = 62_000;

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
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'landing-rendered-page-turnstile-secret',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let standardError = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => {
    standardError = (standardError + chunk).slice(-8_192);
  });
  return { port, server, standardError: () => standardError };
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
      try {
        // Every client belongs to this fixture or its stopped child server.
        // Let DROP DATABASE expose a leaked connection instead of terminating
        // it and surfacing an unrelated asynchronous pool error.
        await admin.query(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin.end();
      }
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
  const { port, server, standardError } = startServer(fixture.databaseUrl);
  try {
    const responses = [];
    for (const path of paths) {
      responses.push(await fetchLanding(port, path));
    }
    return paths.length === 1 ? responses[0] : responses;
  } catch (error) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `Landing test server exited (code ${server.exitCode}, signal ${server.signalCode}): ${standardError()}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    try {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        server.kill('SIGTERM');
        await exited;
      }
    } finally {
      await fixture.dispose();
    }
  }
}

const signupOn = { enabled: true, key: 'signup.enabled' };
const signupOff = { enabled: false, key: 'signup.enabled' };

before(async () => {
  await ensureAppBuild();
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
  assert.ok(
    !body.includes('data-dock'),
    'flag-off renders no sticky signup bar',
  );

  // The paused copy comes from the copy layer and names no machinery.
  assert.ok(rendersCopy(body, landingCopy.paused.heading));
  assert.ok(rendersCopy(body, landingCopy.paused.body));

  assert.equal(setCookie, null);
});

test('free-entry disclosure appears beside the signup action when the giveaway is open', async () => {
  const open = await renderLanding({
    flags: [signupOn, { enabled: true, key: 'giveaway.open' }],
  });
  const disclosure = open.body.indexOf(signupFormCopy.freeEntryDisclosure);
  const button = open.body.lastIndexOf(landingCopy.form.submit, disclosure);
  const rulesLink = open.body.indexOf('href="/giveaway/rules"', disclosure);
  assert.ok(button >= 0);
  assert.ok(disclosure > button);
  assert.ok(rulesLink > disclosure);
  assert.ok(rulesLink - button < 600);
  assert.equal(
    open.body.split(signupFormCopy.freeEntryDisclosure).length - 1,
    2,
  );
  assert.ok(rendersCopy(open.body, signupFormCopy.giveawayRulesLink));
  assert.equal(open.setCookie, null);

  const closed = await renderLanding({ flags: [signupOn] });
  assert.ok(!closed.body.includes(signupFormCopy.freeEntryDisclosure));
});

test('there is no separate AMOE POST route', async () => {
  const routes = await readdir(new URL('../src/pages/api/', import.meta.url));
  assert.ok(!routes.some((route) => /^amoe\./u.test(route)));
  await assert.rejects(
    readdir(new URL('../src/pages/api/amoe/', import.meta.url)),
    { code: 'ENOENT' },
  );
});

test('the landing page ships only the theme toggle and signup form islands', async () => {
  // Measured from the built-and-served output. The landing page carries two
  // islands — the theme toggle (its inline bootstrap plus its island script) and
  // the signup form (E3-05) — plus the first-party page-view emitter (E10-01)
  // and Cloudflare's Turnstile loader. Every script must fit an approved
  // source; a third island or a stray script fails.
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
  const pageView = scripts.filter((script) =>
    script.attributes.includes('src="/page-view.js"'),
  );
  const structuredData = scripts.filter((script) =>
    script.attributes.includes('type="application/ld+json"'),
  );

  assert.equal(theme.length, 2, 'the two theme-toggle scripts ship');
  assert.equal(signupIsland.length, 1, 'exactly one signup form island ships');
  assert.equal(turnstileLoader.length, 1, 'the Turnstile loader ships once');
  assert.equal(
    pageView.length,
    1,
    'the first-party page-view emitter ships once',
  );
  assert.equal(
    structuredData.length,
    1,
    'one inert Organisation JSON-LD block ships',
  );
  assert.equal(JSON.parse(structuredData[0].content)['@type'], 'Organization');
  assert.equal(
    scripts.length,
    theme.length +
      signupIsland.length +
      turnstileLoader.length +
      pageView.length +
      structuredData.length,
    'no other script ships (no third island)',
  );

  // No hydrated framework island is introduced, and no client directive leaks.
  assert.ok(!/client:(?:load|idle|visible|media|only)/u.test(body));
});

test('the landing cache header follows flag state and a ref, from the rendered page', async () => {
  // Default flag state, no ref: the page is edge-cacheable by flag generation.
  const [cacheable, referred] = await renderLanding({
    paths: ['/', '/?ref=signed-ref'],
  });
  assert.equal(cacheable.cacheControl, 'public, max-age=0, s-maxage=300');
  assert.equal(cacheable.vary, 'X-Valstara-Flag-Generation');
  assert.match(cacheable.flagGeneration ?? '', /^[a-f0-9]{16}$/u);

  // A signed referral is per-request and must never be served from cache.
  assert.equal(referred.cacheControl, 'private, no-store');

  // A non-default flag state must bypass the cache too — otherwise a stale edge
  // copy outlives a flag flip. `giveaway.open` defaults off, so turning it on is
  // a non-default state: this proves the
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

test('a landing ?ref= request renders a valid server-signed form field', async () => {
  const { body } = await renderLanding({
    paths: ['/?ref=ABCDEFGHJKMN&utm_source=newsletter'],
  });
  const signed =
    /name="referral_capture"\s+type="hidden"\s+value="([^"]+)"/u.exec(
      body,
    )?.[1];
  assert.ok(signed, 'the signed referral field is present');
  assert.deepEqual(
    createReferralCaptureService(
      'landing-rendered-page-referral-secret',
    ).verifyRef(signed),
    { ref: 'ABCDEFGHJKMN', utm: { source: 'newsletter' } },
  );
});
