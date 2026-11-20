import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';

import { startAppServer } from './listen-port.mjs';

const executeFile = promisify(execFile);

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

// A reserved port, confirmed free, with a lost bind race retried on a fresh
// one (test/helpers/listen-port.mjs). Until E11.6-11a the server took a fixed
// port counting up from 62001 in every test process, and any other listener
// there failed every test in the file (2026-11-02). Readiness reads a static
// file, so it never renders, and so never warms, the landing page.
function startServer(databaseUrl, root) {
  return startAppServer({
    label: 'Landing rendered-page test',
    cwd: root,
    readyPath: '/robots.txt',
    env: () => ({
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
    }),
  });
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
export async function renderLanding({ flags = [], paths = ['/'], root } = {}) {
  const fixture = await createDatabaseFixture();
  for (const { key, enabled } of flags) {
    await fixture.database.query(
      `INSERT INTO campaign_flag (key, enabled, updated_by) VALUES ($1, $2, $3)`,
      [key, enabled, 'landing-rendered-page-test'],
    );
  }
  let app;
  try {
    app = await startServer(fixture.databaseUrl, root);
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
  try {
    const responses = [];
    for (const path of paths) {
      responses.push(await fetchLanding(app.port, path));
    }
    return paths.length === 1 ? responses[0] : responses;
  } catch (error) {
    if (app.server.exitCode !== null || app.server.signalCode !== null) {
      throw new Error(
        `Landing test server exited (code ${app.server.exitCode}, signal ${app.server.signalCode}): ${app.output()}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    try {
      await app.stop();
    } finally {
      await fixture.dispose();
    }
  }
}

export function giveawayCard(body) {
  const card =
    /<article\b[^>]*data-giveaway-card[^>]*>([\s\S]*?)<\/article>/u.exec(
      body,
    )?.[1];
  if (!card) throw new Error('The rendered landing page has no giveaway card.');
  return card;
}
