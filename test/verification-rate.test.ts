import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { VerificationRateConfiguration } from '../src/server/config.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createVerificationRateMonitor } from '../src/server/verification-rate/service.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const measuredAt = new Date('2026-09-16T12:00:00.000Z');

const configuration: VerificationRateConfiguration = {
  baselineDays: 7,
  cohortHours: 24,
  collapsePercent: 50,
  minimumSignups: 10,
};

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e310_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e3-10-verification-rate-test',
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

async function insertSubscribers(
  database: DatabasePool,
  {
    createdAt,
    domains = ['example.test'],
    total,
    verified,
  }: {
    readonly createdAt: Date;
    readonly domains?: readonly string[];
    readonly total: number;
    readonly verified: number;
  },
): Promise<void> {
  for (let index = 0; index < total; index += 1) {
    const id = randomUUID();
    const domain = domains[index % domains.length] ?? 'example.test';
    const email = `${id}@${domain}`;
    const isVerified = index < verified;
    await database.execute({
      text: `
        INSERT INTO subscriber (
          id, email, email_normalised, email_domain, status, created_at, verified_at
        )
        VALUES ($1, $2, $2, $3, $4, $5, $6)
      `,
      values: [
        id,
        email,
        domain,
        isVerified ? 'verified' : 'pending',
        createdAt,
        isVerified ? createdAt : null,
      ],
    });
  }
}

test('a simulated verification-rate collapse raises a P1 alert with a mailbox-provider breakdown', async () => {
  const fixture = await createDatabaseFixture();
  const alerts: unknown[] = [];
  const baselineAt = new Date('2026-09-10T12:00:00.000Z');
  const currentAt = new Date('2026-09-16T06:00:00.000Z');

  try {
    await insertSubscribers(fixture.database, {
      createdAt: baselineAt,
      total: 10,
      verified: 8,
    });
    await insertSubscribers(fixture.database, {
      createdAt: currentAt,
      domains: [
        'gmail.com',
        'outlook.com',
        'gmx.com',
        'web.de',
        'example.test',
      ],
      total: 10,
      verified: 3,
    });
    const monitor = createVerificationRateMonitor(
      fixture.applicationDatabase,
      configuration,
      { alert: (alert) => alerts.push(alert), clock: () => measuredAt },
    );

    const health = await monitor.run();

    assert.equal(health.state, 'collapsed');
    assert.deepEqual(health.current, { rate: 0.3, signups: 10, verified: 3 });
    assert.deepEqual(health.baseline, { rate: 0.8, signups: 10, verified: 8 });
    assert.deepEqual(
      health.providers.map(({ provider, rate, signups, verified }) => ({
        provider,
        rate,
        signups,
        verified,
      })),
      [
        { provider: 'gmail', rate: 0.5, signups: 2, verified: 1 },
        { provider: 'gmx', rate: 0.5, signups: 2, verified: 1 },
        { provider: 'microsoft', rate: 0.5, signups: 2, verified: 1 },
        { provider: 'other', rate: 0, signups: 2, verified: 0 },
        { provider: 'web_de', rate: 0, signups: 2, verified: 0 },
      ],
    );
    assert.deepEqual(alerts, [
      {
        baselineRate: 0.8,
        currentRate: 0.3,
        measuredAt,
        relativeDrop: 0.625,
        severity: 'P1',
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('a traffic drop with an unchanged verification rate does not alert', async () => {
  const fixture = await createDatabaseFixture();
  const alerts: unknown[] = [];

  try {
    await insertSubscribers(fixture.database, {
      createdAt: new Date('2026-09-10T12:00:00.000Z'),
      total: 50,
      verified: 40,
    });
    await insertSubscribers(fixture.database, {
      createdAt: new Date('2026-09-16T06:00:00.000Z'),
      total: 10,
      verified: 8,
    });
    const monitor = createVerificationRateMonitor(
      fixture.applicationDatabase,
      configuration,
      { alert: (alert) => alerts.push(alert), clock: () => measuredAt },
    );

    const health = await monitor.run();

    assert.equal(health.state, 'healthy');
    assert.equal(health.baseline.rate, 0.8);
    assert.equal(health.current.rate, 0.8);
    assert.deepEqual(alerts, []);
  } finally {
    await fixture.dispose();
  }
});

test('a cold cohort remains warming up and cannot raise a false alert', async () => {
  const fixture = await createDatabaseFixture();
  const alerts: unknown[] = [];

  try {
    await insertSubscribers(fixture.database, {
      createdAt: new Date('2026-09-10T12:00:00.000Z'),
      total: 10,
      verified: 10,
    });
    await insertSubscribers(fixture.database, {
      createdAt: new Date('2026-09-16T06:00:00.000Z'),
      total: 9,
      verified: 0,
    });
    const monitor = createVerificationRateMonitor(
      fixture.applicationDatabase,
      configuration,
      { alert: (alert) => alerts.push(alert), clock: () => measuredAt },
    );

    const health = await monitor.run();

    assert.equal(health.state, 'warming_up');
    assert.equal(health.current.rate, 0);
    assert.deepEqual(alerts, []);
  } finally {
    await fixture.dispose();
  }
});
