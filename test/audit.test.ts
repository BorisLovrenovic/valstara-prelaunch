import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { auditActions, type AuditAction } from '../src/server/audit/actions.ts';
import {
  redactAuditDetail,
  redactedAuditDetailValue,
} from '../src/server/audit/redact-detail.ts';
import {
  auditQueryMaximumLimit,
  createAuditService,
  createAuditServiceWithRepository,
} from '../src/server/audit/service.ts';
import type { AuditLogRepository } from '../src/server/db/audit-log.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

function isPostgresPermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '42501'
  );
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e109_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e1-09-test',
  });

  return {
    applicationDatabase: createPool(applicationUrl.toString()),
    database,
    async dispose() {
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

function auditInput(action: AuditAction) {
  return {
    action,
    actor: 'operator-1',
    subjectId: '82e81b4b-49e6-4dc0-b5bb-f47e81405c6a',
    subjectType: 'subscriber',
  } as const;
}

test('the required audit action registry is complete', () => {
  assert.deepEqual(auditActions, [
    'subscriber.disqualified',
    'subscriber.anonymised',
    'fraud.reviewed',
    'referral.access_window_promoted',
    'referral.milestone_backfilled',
    'referral.counters_repaired',
    'flag.changed',
    'export.run',
    'draw.executed',
    'dsr.requested',
    'dsr.fulfilled',
    'handoff.frozen',
  ]);
});

test('record rejects an unregistered audit action', async () => {
  const audit = createAuditServiceWithRepository({
    async insert() {
      return undefined;
    },
    async query() {
      return [];
    },
  });

  await assert.rejects(
    audit.record({
      ...auditInput('flag.changed'),
      action: 'unknown.action' as AuditAction,
    }),
    /Unregistered audit action: unknown.action/,
  );
});

test('record redacts token, secret, raw IP, and full email detail for every registered action', async () => {
  const writes: Parameters<AuditLogRepository['insert']>[0][] = [];
  const audit = createAuditServiceWithRepository({
    async insert(entry) {
      writes.push(entry);
    },
    async query() {
      return [];
    },
  });

  for (const action of auditActions) {
    await audit.record({
      ...auditInput(action),
      detail: {
        nested: {
          emailAddress: 'contact person@example.com',
          token: 'verification-token',
        },
        rawAddress: 'source 198.51.100.42',
        request: ['harmless', '2001:db8::1'],
        note: 'source fe80::1',
        secret: 'database-secret',
      },
    });
  }

  assert.equal(writes.length, auditActions.length);
  for (const write of writes) {
    assert.deepEqual(write.detail, {
      nested: {
        emailAddress: redactedAuditDetailValue,
        token: redactedAuditDetailValue,
      },
      rawAddress: redactedAuditDetailValue,
      request: ['harmless', redactedAuditDetailValue],
      note: redactedAuditDetailValue,
      secret: redactedAuditDetailValue,
    });
  }
});

test('redaction preserves safe audit detail values', () => {
  assert.deepEqual(
    redactAuditDetail({
      count: 3,
      outcome: 'upheld',
      values: [true, null, { reason: 'manual' }],
    }),
    {
      count: 3,
      outcome: 'upheld',
      values: [true, null, { reason: 'manual' }],
    },
  );
});

test('record failures for irreversible actions propagate to their callers', async () => {
  const audit = createAuditServiceWithRepository({
    async insert() {
      throw new Error('audit database write failed');
    },
    async query() {
      return [];
    },
  });

  for (const action of [
    'subscriber.disqualified',
    'export.run',
    'draw.executed',
    'dsr.fulfilled',
  ] as const) {
    await assert.rejects(
      audit.record(auditInput(action)),
      /audit database write failed/,
    );
  }
});

test('query requires an explicit bounded limit and passes it to the repository', async () => {
  let receivedLimit: number | undefined;
  const audit = createAuditServiceWithRepository({
    async insert() {
      return undefined;
    },
    async query(_filter, limit) {
      receivedLimit = limit;
      return [];
    },
  });

  await audit.query({ action: 'flag.changed' }, 1);
  assert.equal(receivedLimit, 1);
  await assert.rejects(audit.query({}, 0), RangeError);
  await assert.rejects(audit.query({}, auditQueryMaximumLimit + 1), RangeError);
});

test('the application role can record and query audit rows but cannot update or delete them', async () => {
  const fixture = await createDatabaseFixture();
  const audit = createAuditService(fixture.applicationDatabase);

  try {
    await audit.record({
      ...auditInput('fraud.reviewed'),
      detail: { outcome: 'dismissed' },
    });
    await audit.record({
      ...auditInput('flag.changed'),
      detail: { enabled: true },
      requestId: 'request-1',
    });

    const rows = await audit.query({ subjectType: 'subscriber' }, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.subjectType, 'subscriber');

    await assert.rejects(
      fixture.applicationDatabase.execute({
        text: "UPDATE audit_log SET action = 'flag.changed'",
      }),
      isPostgresPermissionError,
    );
    await assert.rejects(
      fixture.applicationDatabase.execute({ text: 'DELETE FROM audit_log' }),
      isPostgresPermissionError,
    );
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});
