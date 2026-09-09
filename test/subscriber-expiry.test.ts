import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createReferralRepository } from '../src/server/db/referral.ts';
import { createSubscriberMaintenanceRepository } from '../src/server/db/subscriber-maintenance.ts';
import {
  createUnverifiedExpiryJob,
  unverifiedExpiryHorizonMs,
} from '../src/server/subscriber/expiry.ts';
import { createVerificationReminderJob } from '../src/server/subscriber/reminder.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const baseTime = new Date('2026-09-09T00:00:00.000Z');

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e308expiry_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e3-08-expiry-test',
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

test('the clock-injected sweep expires only pending rows strictly past the 30-day horizon', async () => {
  const fixture = await createDatabaseFixture();
  let now = new Date(baseTime.getTime() + unverifiedExpiryHorizonMs);
  const job = createUnverifiedExpiryJob(fixture.applicationDatabase, {
    clock: () => now,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database, baseTime);
    assert.equal(
      await job.run(10),
      0,
      'exactly at the horizon remains pending',
    );

    now = new Date(now.getTime() + 1);
    assert.equal(await job.run(10), 1);
    const row = await fixture.database.readOne<{
      expired_at: Date;
      status: string;
      updated_at: Date;
    }>({
      text: 'SELECT status, expired_at, updated_at FROM subscriber WHERE id = $1',
      values: [subscriberId],
    });
    assert.equal(row?.status, 'expired');
    assert.equal(row?.expired_at.getTime(), now.getTime());
    assert.equal(row?.updated_at.getTime(), now.getTime());
  } finally {
    await fixture.dispose();
  }
});

test('the expiry sweep honours its cap and leaves verified and not-yet-due rows untouched', async () => {
  const fixture = await createDatabaseFixture();
  const old = new Date(baseTime.getTime() - unverifiedExpiryHorizonMs - 1);
  const job = createUnverifiedExpiryJob(fixture.applicationDatabase, {
    clock: () => baseTime,
  });

  try {
    const pendingIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      pendingIds.push(await insertSubscriber(fixture.database, old));
    }
    const verifiedId = await insertSubscriber(
      fixture.database,
      old,
      'verified',
    );
    const recentId = await insertSubscriber(fixture.database, baseTime);

    assert.equal(await job.run(2), 2);
    assert.equal(await job.run(2), 2);
    assert.equal(await job.run(2), 1);
    assert.equal(await job.run(2), 0);
    await assert.rejects(job.run(0), /maintenance limit must be positive/u);

    const expired = await fixture.database.list<{ id: string }>(
      {
        text: "SELECT id FROM subscriber WHERE status = 'expired' ORDER BY id",
      },
      10,
    );
    assert.deepEqual(expired.map((row) => row.id).sort(), pendingIds.sort());
    const untouched = await fixture.database.list<{
      id: string;
      status: string;
    }>(
      {
        text: 'SELECT id, status FROM subscriber WHERE id = $1 OR id = $2 ORDER BY id',
        values: [verifiedId, recentId],
      },
      2,
    );
    assert.deepEqual(
      new Map(untouched.map((row) => [row.id, row.status])),
      new Map([
        [verifiedId, 'verified'],
        [recentId, 'pending'],
      ]),
    );
  } finally {
    await fixture.dispose();
  }
});

test('expired rows are excluded at the shared counted-status query layer and from reachable reminder queries', async () => {
  const fixture = await createDatabaseFixture();
  const old = new Date(baseTime.getTime() - unverifiedExpiryHorizonMs - 1);
  const expiry = createUnverifiedExpiryJob(fixture.applicationDatabase, {
    clock: () => baseTime,
  });

  try {
    const expiredId = await insertSubscriber(fixture.database, old);
    const verifiedId = await insertSubscriber(
      fixture.database,
      old,
      'verified',
    );
    const counted = createSubscriberMaintenanceRepository(fixture.database);

    assert.equal(await counted.countCountedSubscribers(), 1);
    assert.equal(await expiry.run(10), 1);
    assert.equal(await counted.countCountedSubscribers(), 1);
    assert.equal(
      await createReferralRepository(fixture.database).verificationOrder(
        verifiedId,
        old,
      ),
      1,
    );

    const reminder = createVerificationReminderJob(
      fixture.applicationDatabase,
      {
        clock: () => baseTime,
      },
    );
    assert.deepEqual(await reminder.run(10), { queued: 0, scanned: 0 });
    const row = await fixture.database.readOne<{ status: string }>({
      text: 'SELECT status FROM subscriber WHERE id = $1',
      values: [expiredId],
    });
    assert.equal(row?.status, 'expired');
  } finally {
    await fixture.dispose();
  }
});

test('the expiry horizon rejects non-positive configuration', () => {
  const database = {} as DatabasePool;
  assert.throws(
    () => createUnverifiedExpiryJob(database, { horizonMs: 0 }),
    /expiry horizon must be positive/u,
  );
});
