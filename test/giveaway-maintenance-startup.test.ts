import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';

test('the maintenance entry point starts with the configured draw worker', async () => {
  const name = `valstara_e705_maintenance_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  let owner: ReturnType<typeof createPool> | undefined;
  try {
    await admin.execute({ text: `CREATE DATABASE "${name}"` });
    owner = createPool(databaseUrl.toString());
    await runMigrations(owner, {
      applicationRolePassword: appUrl.password,
      release: 'e7-05-maintenance-startup-test',
    });
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server/subscriber/run-maintenance.ts'],
      {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          DATABASE_URL: appUrl.toString(),
          DRAND_CHAIN_HASH: 'ab'.repeat(32),
          DRAND_CHAIN_PUBLIC_KEY: 'cd'.repeat(48),
          DRAND_RELAY_URLS: 'https://relay-one.test,https://relay-two.test',
          P1_ALERT_WEBHOOK_TOKEN: 'maintenance-test-token',
          P1_ALERT_WEBHOOK_URL: 'http://127.0.0.1:9/local-only-alert-sink',
          RESEND_API_KEY: 'maintenance-test-resend-key',
          RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
          RESEND_KEY_MODE: 'test',
          RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
          RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
          RESEND_SENDING_DOMAIN: 'send.valstara.com',
          NODE_ENV: 'test',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let errors = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    try {
      let connected = false;
      // The child opens this connection after installing its signal handlers.
      // Wait for that observable startup state before testing shutdown.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) {
          assert.fail(`maintenance exited before connecting: ${errors}`);
        }
        const sessions = await admin.list<{ pid: number }>(
          {
            text: `SELECT pid FROM pg_stat_activity
                   WHERE datname = $1 AND usename = 'valstara_app'`,
            values: [name],
          },
          1,
        );
        if (sessions.length > 0) {
          connected = true;
          break;
        }
        await sleep(50);
      }
      assert.equal(connected, true, `maintenance did not connect: ${errors}`);
      assert.equal(child.exitCode, null, errors);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    }
    assert.equal(child.exitCode, 0, errors);
  } finally {
    await owner?.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [name],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE IF EXISTS "${name}"` });
    await admin.close();
  }
});
