import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import { consumeRateLimitWithWindow } from '../src/server/ratelimit/consume.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

test('the real rate-limit bucket returns its reset time under repeated hits', async () => {
  const databaseName = `valstara_rate_window_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const applicationUrl = new URL(ownerUrl);
  applicationUrl.username = 'valstara_app';
  applicationUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword,
    release: 'e11-01-rate-window-test',
  });
  const application = createPool(applicationUrl.toString());

  try {
    const firstAt = new Date('2026-10-07T12:00:00.000Z');
    const tenMinutesLater = new Date('2026-10-07T12:10:00.000Z');
    const windowMs = 15 * 60 * 1_000;
    const first = await consumeRateLimitWithWindow(
      application,
      'signup:ip:wait',
      windowMs,
      firstAt,
    );
    const second = await consumeRateLimitWithWindow(
      application,
      'signup:ip:wait',
      windowMs,
      tenMinutesLater,
    );
    const reset = await consumeRateLimitWithWindow(
      application,
      'signup:ip:wait',
      windowMs,
      new Date('2026-10-07T12:15:00.000Z'),
    );

    assert.deepEqual(first, { count: 1, windowStart: firstAt });
    assert.deepEqual(second, { count: 2, windowStart: firstAt });
    assert.deepEqual(reset, {
      count: 1,
      windowStart: new Date('2026-10-07T12:15:00.000Z'),
    });
  } finally {
    await application.close();
    await owner.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [databaseName],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${databaseName}"` });
    await admin.close();
  }
});
