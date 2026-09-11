import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import {
  createRateLimitRetentionJob,
  rateLimitBucketRetentionDays,
} from '../src/server/ratelimit/retention.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-10T12:00:00.000Z');
const documentedRetentionDays = 7;

test('the application-role retention job deletes only expired buckets and honours its batch cap', async () => {
  const databaseName = `valstara_rate_retention_${randomUUID().replaceAll('-', '')}`;
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
    release: 'qa-rate-limit-retention-test',
  });
  const application = createPool(applicationUrl.toString());

  try {
    assert.equal(rateLimitBucketRetentionDays, documentedRetentionDays);
    const expiredAt = new Date(
      now.getTime() - (documentedRetentionDays * 24 + 1) * 60 * 60 * 1_000,
    );
    const retainedAt = new Date(
      now.getTime() - (documentedRetentionDays * 24 - 1) * 60 * 60 * 1_000,
    );
    await owner.execute({
      text: `
        INSERT INTO rate_limit_bucket (key, window_start, count)
        VALUES
          ('signup:ip:expired-a', $1, 1),
          ('signup:ip:expired-b', $1, 1),
          ('signup:ip:retained', $2, 1)
      `,
      values: [expiredAt, retainedAt],
    });

    const job = createRateLimitRetentionJob(application, { clock: () => now });
    assert.equal(await job.run(1), 1);
    assert.equal(await job.run(1), 1);
    assert.equal(await job.run(1), 0);

    const rows = await owner.list<{ key: string }>(
      { text: 'SELECT key FROM rate_limit_bucket ORDER BY key' },
      10,
    );
    assert.deepEqual(rows, [{ key: 'signup:ip:retained' }]);
    await assert.rejects(job.run(0), /must be positive/u);
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
