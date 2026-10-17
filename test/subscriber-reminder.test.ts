import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { createVerificationService } from '../src/server/verification/service.ts';
import { createFinalReminderJob } from '../src/server/subscriber/final-reminder.ts';
import {
  createVerificationReminderJob,
  verificationReminderBusinessKey,
} from '../src/server/subscriber/reminder.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const HOUR_MS = 60 * 60 * 1_000;
const baseTime = new Date('2026-09-09T00:00:00.000Z');

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e308reminder_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = 'valstara_app';
  applicationUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e3-08-reminder-test',
  });
  const applicationDatabase = createPool(applicationUrl.toString());

  return {
    applicationDatabase,
    database,
    async dispose() {
      await applicationDatabase.close();
      await database.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [databaseName],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${databaseName}"` });
      await admin.close();
    },
  };
}

async function insertSubscriber(
  database: DatabasePool,
  createdAt: Date,
  status: 'pending' | 'verified' = 'pending',
): Promise<string> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, created_at, verified_at
      )
      VALUES ($1, $2, $2, 'example.test', $3, $4, $5)
    `,
    values: [
      id,
      email,
      status,
      createdAt,
      status === 'verified' ? createdAt : null,
    ],
  });
  return id;
}

async function reminderKeys(
  database: DatabasePool,
  subscriberId: string,
): Promise<readonly string[]> {
  const rows = await database.list<{ business_key: string }>(
    {
      text: `
        SELECT business_key
        FROM email_send
        WHERE subscriber_id = $1 AND template = 'verification_reminder'
        ORDER BY business_key
      `,
      values: [subscriberId],
    },
    10,
  );
  return rows.map((row) => row.business_key);
}

test('final reminder queues once per pending unsuppressed subscriber under concurrency', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const pending = await insertSubscriber(fixture.database, baseTime);
    const suppressed = await insertSubscriber(fixture.database, baseTime);
    const verified = await insertSubscriber(
      fixture.database,
      baseTime,
      'verified',
    );
    await fixture.database.execute({
      text: `INSERT INTO suppression (email_normalised,reason,source)
        SELECT email_normalised,'manual','test' FROM subscriber WHERE id=$1`,
      values: [suppressed],
    });
    const job = createFinalReminderJob(
      fixture.applicationDatabase,
      () => baseTime,
    );
    const runs = await Promise.all([job.run(null, 10), job.run(null, 10)]);
    assert.equal(
      runs.reduce((sum, run) => sum + run.queued, 0),
      1,
    );
    assert.deepEqual(await reminderKeys(fixture.database, pending), [
      `verify-reminder-final:${pending}`,
    ]);
    assert.deepEqual(await reminderKeys(fixture.database, suppressed), []);
    assert.deepEqual(await reminderKeys(fixture.database, verified), []);
    assert.deepEqual(await job.run(null, 10), {
      scanned: 0,
      queued: 0,
      afterId: null,
    });
    const token = await fixture.database.readOne<{
      token_hash: Buffer;
      expires_at: Date;
    }>({
      text: `SELECT t.token_hash,t.expires_at FROM verification_token t
        JOIN email_send e ON e.subscriber_id=t.subscriber_id
        WHERE e.business_key=$1 AND t.id=(e.payload->>'token_id')::uuid`,
      values: [`verify-reminder-final:${pending}`],
    });
    assert.equal(token?.token_hash.length, 32);
    assert.equal(token?.expires_at.toISOString(), '2026-09-16T00:00:00.000Z');
  } finally {
    await fixture.dispose();
  }
});

test('the clock-injected ladder queues exactly one reminder at each of +1h, +24h, and +72h', async () => {
  const fixture = await createDatabaseFixture();
  let now = new Date(baseTime);
  const job = createVerificationReminderJob(fixture.applicationDatabase, {
    clock: () => now,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database, baseTime);
    const cases = [
      { atHours: 1, beforeQueued: 0, atQueued: 1 },
      { atHours: 24, beforeQueued: 0, atQueued: 1 },
      { atHours: 72, beforeQueued: 0, atQueued: 1 },
    ] as const;

    for (const entry of cases) {
      now = new Date(baseTime.getTime() + entry.atHours * HOUR_MS - 1);
      assert.equal((await job.run(10)).queued, entry.beforeQueued);
      now = new Date(baseTime.getTime() + entry.atHours * HOUR_MS);
      assert.equal((await job.run(10)).queued, entry.atQueued);
    }

    assert.deepEqual(await reminderKeys(fixture.database, subscriberId), [
      verificationReminderBusinessKey(subscriberId, 1),
      verificationReminderBusinessKey(subscriberId, 24),
      verificationReminderBusinessKey(subscriberId, 72),
    ]);
    assert.equal((await job.run(10)).queued, 0);
  } finally {
    await fixture.dispose();
  }
});

test('the ladder stops immediately when the subscriber verifies', async () => {
  const fixture = await createDatabaseFixture();
  let now = new Date(baseTime.getTime() + HOUR_MS);
  const job = createVerificationReminderJob(fixture.applicationDatabase, {
    clock: () => now,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database, baseTime);
    assert.equal((await job.run(10)).queued, 1);

    now = new Date(baseTime.getTime() + 2 * HOUR_MS);
    await fixture.database.execute({
      text: `
        UPDATE subscriber
        SET status = 'verified', verified_at = $2
        WHERE id = $1
      `,
      values: [subscriberId, now],
    });

    now = new Date(baseTime.getTime() + 80 * HOUR_MS);
    assert.deepEqual(await job.run(10), { queued: 0, scanned: 0 });
    assert.equal(
      (await reminderKeys(fixture.database, subscriberId)).length,
      1,
    );
  } finally {
    await fixture.dispose();
  }
});

test('the unique business key deduplicates concurrent reminder runs', async () => {
  const fixture = await createDatabaseFixture();
  const subscriberId = await insertSubscriber(fixture.database, baseTime);
  const now = new Date(baseTime.getTime() + 80 * HOUR_MS);
  const job = createVerificationReminderJob(fixture.applicationDatabase, {
    clock: () => now,
  });

  try {
    const results = await Promise.all([job.run(10), job.run(10)]);
    assert.equal(
      results.reduce((total, result) => total + result.queued, 0),
      3,
    );
    assert.equal(
      (await reminderKeys(fixture.database, subscriberId)).length,
      3,
    );
  } finally {
    await fixture.dispose();
  }
});

test('the reminder job never scans or queues more than its batch cap', async () => {
  const fixture = await createDatabaseFixture();
  const now = new Date(baseTime.getTime() + 80 * HOUR_MS);
  const job = createVerificationReminderJob(fixture.applicationDatabase, {
    clock: () => now,
  });

  try {
    for (let index = 0; index < 3; index += 1) {
      await insertSubscriber(fixture.database, baseTime);
    }

    assert.deepEqual(await job.run(2), { queued: 2, scanned: 2 });
    assert.deepEqual(await job.run(2), { queued: 2, scanned: 2 });
    await assert.rejects(job.run(0), /maintenance limit must be positive/u);
  } finally {
    await fixture.dispose();
  }
});

test('if the reminder job stops, the original verification token still verifies the subscriber', async () => {
  const fixture = await createDatabaseFixture();

  try {
    const subscriberId = await insertSubscriber(fixture.database, baseTime);
    const issued = await createVerificationService(fixture.database, {
      clock: () => baseTime,
    }).issue(subscriberId, 'verify');

    const completed = await createVerificationCompletionService(
      fixture.database,
      {
        clock: () => new Date(baseTime.getTime() + 73 * HOUR_MS),
        referralEnabled: false,
      },
    )(issued.token);

    assert.equal(completed.outcome, 'verified');
    const subscriber = await fixture.database.readOne<{ status: string }>({
      text: 'SELECT status FROM subscriber WHERE id = $1',
      values: [subscriberId],
    });
    assert.equal(subscriber?.status, 'verified');
  } finally {
    await fixture.dispose();
  }
});
