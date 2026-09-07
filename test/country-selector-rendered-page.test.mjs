import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test, { before } from 'node:test';

import { Pool } from 'pg';

const executeFile = promisify(execFile);

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

// A private port range for this suite, away from the other rendered-page tests.
let nextPort = 43_280;

function startServer(databaseUrl) {
  const port = (nextPort += 1);
  const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'country-selector-prefix-pepper',
      RESEND_API_KEY: 'country-selector-resend-key',
      RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
      TURNSTILE_SECRET_KEY: 'country-selector-turnstile-secret',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: 'ignore',
  });
  return { port, server };
}

async function createDatabaseFixture() {
  const databaseName = `valstara_country_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const database = new Pool({ connectionString: databaseUrl.toString() });

  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'country-selector-test'],
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

async function fetchLanding(port, headers) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/`, {
        headers,
      });
      if (response.ok) {
        return {
          body: await response.text(),
          setCookie: response.headers.get('set-cookie'),
        };
      }
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error('Country-selector rendered-page test server did not start.');
}

/** Fetch the landing HTML plus every linked stylesheet, concatenated. */
async function renderLanding(headers = {}) {
  const fixture = await createDatabaseFixture();
  const { port, server } = startServer(fixture.databaseUrl);
  try {
    const page = await fetchLanding(port, headers);
    const cssHrefs = [
      ...page.body.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu),
    ].map((match) => match[1]);
    let css = '';
    for (const href of cssHrefs) {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${port}${href}`,
      );
      css += await response.text();
    }
    return { ...page, css };
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
    await fixture.dispose();
  }
}

before(async () => {
  await executeFile('npm', ['run', 'build']);
});

test('a CF-IPCountry header prefills the matching country as a suggestion', async () => {
  const { body, setCookie } = await renderLanding({ 'CF-IPCountry': 'CA' });

  // Canada is preselected — and it is the only preselected country.
  assert.match(body, /<option value="CA" selected>/u);
  assert.equal(
    (body.match(/<option value="[A-Z]{2}" selected>/gu) ?? []).length,
    1,
  );
  // The empty placeholder is present but not selected, because a suggestion won.
  assert.match(body, /<option value="" disabled>/u);
  assert.doesNotMatch(body, /<option value="" disabled selected>/u);

  // A prefilled page still sets no cookie.
  assert.equal(setCookie, null);
});

test('a missing header renders the selector unfilled, never guessed', async () => {
  const { body } = await renderLanding({});

  // The placeholder is the selected option, and no country is preselected.
  assert.match(body, /<option value="" disabled selected>/u);
  assert.doesNotMatch(body, /<option value="[A-Z]{2}" selected>/u);
});

test('the XX sentinel renders unfilled, exactly like a missing header', async () => {
  const { body } = await renderLanding({ 'CF-IPCountry': 'XX' });
  assert.match(body, /<option value="" disabled selected>/u);
  assert.doesNotMatch(body, /<option value="[A-Z]{2}" selected>/u);
});

test('the country selector is a plain, fully overridable control', async () => {
  const { body } = await renderLanding({ 'CF-IPCountry': 'FR' });

  // France is suggested, but the select itself is never disabled and carries the
  // full option list, so the visitor can pick anything else.
  assert.match(body, /<option value="FR" selected>/u);
  assert.match(body, /<select\b[^>]*\bname="country"[^>]*\brequired\b[^>]*>/u);
  assert.doesNotMatch(body, /<select\b[^>]*\bname="country"[^>]*\bdisabled\b/u);
  // Other countries are present and not preselected — evidence of overridability.
  assert.match(body, /<option value="US">United States<\/option>/u);
  assert.match(body, /<option value="DE">Germany<\/option>/u);
  // A suggestion never marks Canada, so the region field stays hidden by default.
  assert.match(body, /<option value="CA">Canada<\/option>/u);
});

test('the Canada-only region field is always in the DOM and revealed by CSS, not script', async () => {
  const { body, css } = await renderLanding({ 'CF-IPCountry': 'FR' });

  // The region container ships regardless of the suggested country, tagged with
  // the Canada code so markup and stylesheet reconcile.
  assert.match(body, /class="signup-region"[^>]*data-region-for="CA"/u);
  assert.match(body, /<option value="QC">Quebec<\/option>/u);

  // Hidden by default, revealed only when Canada is the checked country — a pure
  // CSS `:has()` rule, so no JavaScript is involved in the reveal.
  assert.match(css, /\.signup-region\s*\{\s*display:\s*none/u);
  assert.match(
    css,
    /:has\(#signup-country option\[value=["']?CA["']?\]:checked\)[^}]*\.signup-region/u,
  );
});

test('the country and region reveal ships no script of its own — the reveal stays pure CSS', async () => {
  const { body } = await renderLanding({ 'CF-IPCountry': 'CA' });

  // The Canada region reveal is pure CSS `:has()` (E3-04): it adds no script.
  // The only scripts on the page are the two theme-toggle scripts, the one
  // signup form island (E3-05), and Cloudflare's Turnstile loader.
  const scripts = [
    ...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu),
  ].map(([, attributes, content]) => ({ attributes, content }));
  const theme = scripts.filter((script) =>
    script.content.includes('valstara-theme'),
  );
  const signupIsland = scripts.filter((script) =>
    script.content.includes('valstara-signup-form'),
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
    'the region reveal adds no script and no third island appears',
  );
  assert.doesNotMatch(body, /client:(?:load|idle|visible|media|only)/u);
});
