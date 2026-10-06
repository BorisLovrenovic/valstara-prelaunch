import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { purgeJobHealth } from '../src/server/admin/purge-status.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createPurgeJobRunRepository,
  purgeJobKeys,
  type PurgeJobRunRow,
} from '../src/server/db/purge-job-run.ts';
import { createRecordedPurgeJob } from '../src/server/subscriber/purge-run.ts';

const start = new Date('2026-10-06T09:00:00.000Z');
const finish = new Date('2026-10-06T09:01:00.000Z');

test('purge status becomes stale only after twice its daily schedule', () => {
  const base: PurgeJobRunRow = {
    job_key: 'ip_prefix_retention',
    last_started_at: start,
    last_finished_at: finish,
    last_succeeded_at: finish,
    last_outcome: 'succeeded',
    rows_purged: 7,
    last_error_code: null,
  };
  const justUnder = purgeJobHealth(
    [base],
    new Date(finish.getTime() + 48 * 60 * 60 * 1_000 - 1),
  );
  assert.equal(justUnder[0]?.stale, false);
  assert.equal(justUnder[0]?.rowsPurged, 7);
  const justOver = purgeJobHealth(
    [base],
    new Date(finish.getTime() + 48 * 60 * 60 * 1_000 + 1),
  );
  assert.equal(justOver[0]?.stale, true);
  assert.equal(justOver.length, purgeJobKeys.length);
  assert.ok(
    justOver.slice(1).every((job) => job.stale && job.lastOutcome === null),
  );
  const neverSucceeded = purgeJobHealth(
    [{ ...base, last_succeeded_at: null, last_outcome: 'failed' }],
    finish,
  );
  assert.equal(neverSucceeded[0]?.stale, true);
});

test('a failed run-record write never changes the purge result or its original failure', async () => {
  const failedRecord = {
    async start() {
      throw new Error('record unavailable');
    },
    async finish() {
      throw new Error('record unavailable');
    },
  };
  const success = createRecordedPurgeJob(
    {
      async run() {
        return 3;
      },
    },
    failedRecord,
    'rate_limit_retention',
    () => start,
  );
  assert.equal(await success.run(100), 3);
  const purgeError = new Error('purge failed');
  const failure = createRecordedPurgeJob(
    {
      async run(): Promise<number> {
        throw purgeError;
      },
    },
    failedRecord,
    'rate_limit_retention',
    () => start,
  );
  await assert.rejects(failure.run(100), (error) => error === purgeError);
});

test('the application role records purge success and failure but cannot delete runs', async () => {
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const name = `valstara_purge_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const database = createPool(databaseUrl.toString());
  let app: DatabasePool | undefined;
  try {
    await runMigrations(database, {
      applicationRolePassword: appUrl.password,
      release: 'e10-05-purge-test',
    });
    app = createPool(appUrl.toString());
    const repository = createPurgeJobRunRepository(app);
    let now = start;
    const succeeded = createRecordedPurgeJob(
      {
        async run() {
          assert.deepEqual((await repository.list())[0], {
            job_key: 'ip_prefix_retention',
            last_started_at: start,
            last_finished_at: null,
            last_succeeded_at: null,
            last_outcome: null,
            rows_purged: 0,
            last_error_code: null,
          });
          now = finish;
          return 7;
        },
      },
      repository,
      'ip_prefix_retention',
      () => now,
    );
    assert.equal(await succeeded.run(100), 7);
    assert.deepEqual((await repository.list())[0], {
      job_key: 'ip_prefix_retention',
      last_started_at: start,
      last_finished_at: finish,
      last_succeeded_at: finish,
      last_outcome: 'succeeded',
      rows_purged: 7,
      last_error_code: null,
    });
    const failureStart = new Date('2026-10-07T09:00:00.000Z');
    const failureFinish = new Date('2026-10-07T09:01:00.000Z');
    now = failureStart;
    const failed = createRecordedPurgeJob(
      {
        async run(): Promise<number> {
          now = failureFinish;
          throw new Error('secret: 203.0.113.47');
        },
      },
      repository,
      'ip_prefix_retention',
      () => now,
    );
    await assert.rejects(failed.run(100));
    assert.deepEqual((await repository.list())[0], {
      job_key: 'ip_prefix_retention',
      last_started_at: failureStart,
      last_finished_at: failureFinish,
      last_succeeded_at: finish,
      last_outcome: 'failed',
      rows_purged: 0,
      last_error_code: 'purge_failed',
    });
    await assert.rejects(
      app.execute({ text: 'DELETE FROM purge_job_run' }),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '42501',
    );
    await assert.rejects(
      database.execute({
        text: `INSERT INTO purge_job_run (job_key, last_started_at)
          VALUES ('unregistered', $1)`,
        values: [start],
      }),
    );
    await assert.rejects(
      database.execute({
        text: `UPDATE purge_job_run SET rows_purged = -1
          WHERE job_key = 'ip_prefix_retention'`,
      }),
    );
  } finally {
    await app?.close();
    await database.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [name],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${name}"` });
    await admin.close();
  }
});
