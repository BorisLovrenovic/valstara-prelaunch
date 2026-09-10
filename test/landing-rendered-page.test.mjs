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
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'landing-rendered-page-prefix-pepper',
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

async function fetchLanding(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) {
        const body = await response.text();
        return { body, setCookie: response.headers.get('set-cookie') };
      }
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error('Landing rendered-page test server did not start.');
}

async function renderLanding(setFlag) {
  const fixture = await createDatabaseFixture();
  if (setFlag !== undefined) {
    await fixture.database.query(
      `INSERT INTO campaign_flag (key, enabled, updated_by) VALUES ($1, $2, $3)`,
      ['signup.enabled', setFlag, 'e2-06-landing-test'],
    );
  }
  const { port, server } = startServer(fixture.databaseUrl);
  try {
    return await fetchLanding(port);
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
    await fixture.dispose();
  }
}

before(async () => {
  await executeFile('npm', ['run', 'build']);
});

test('with signup.enabled on, the landing page renders the signup form and every section', async () => {
  const { body, setCookie } = await renderLanding(true);

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
  const { body, setCookie } = await renderLanding(false);

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
  const { body } = await renderLanding(true);

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
