import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';

const executeFile = promisify(execFile);

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

// Stay outside Linux's usual ephemeral client-port range during the full suite.
let nextPort = 62_000;

function startServer(databaseUrl, root) {
  const port = (nextPort += 1);
  const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    cwd: root,
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
export async function renderLanding({ flags = [], paths = ['/'], root } = {}) {
  const fixture = await createDatabaseFixture();
  for (const { key, enabled } of flags) {
    await fixture.database.query(
      `INSERT INTO campaign_flag (key, enabled, updated_by) VALUES ($1, $2, $3)`,
      [key, enabled, 'landing-rendered-page-test'],
    );
  }
  const { port, server, standardError } = startServer(
    fixture.databaseUrl,
    root,
  );
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

export function giveawayCard(body) {
  const card =
    /<article\b[^>]*data-giveaway-card[^>]*>([\s\S]*?)<\/article>/u.exec(
      body,
    )?.[1];
  if (!card) throw new Error('The rendered landing page has no giveaway card.');
  return card;
}
