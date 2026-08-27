import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import type { AuditRecordInput } from '../src/server/audit/types.ts';
import type {
  CampaignFlagRepository,
  CampaignFlagRow,
} from '../src/server/db/campaign-flags.ts';
import { DatabaseUnavailableError } from '../src/server/db/errors.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  campaignFlagKeys,
  campaignFlagRegistry,
  type FlagKey,
} from '../src/server/flags/registry.ts';
import {
  createFlagService,
  createFlagServiceWithDependencies,
  flagCacheTtlMilliseconds,
} from '../src/server/flags/service.ts';
import type { FlagClock } from '../src/server/flags/types.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const migrationDirectory = new URL(
  '../src/server/db/migrations/',
  import.meta.url,
);

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

class ManualClock implements FlagClock {
  private milliseconds = 0;

  public advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }

  public now(): number {
    return this.milliseconds;
  }
}

function createMemoryRepository(): CampaignFlagRepository & {
  readonly overrides: Map<string, boolean>;
  readCount: number;
} {
  const overrides = new Map<string, boolean>();

  return {
    overrides,
    readCount: 0,
    async list(keys) {
      this.readCount += 1;
      return keys.flatMap<CampaignFlagRow>((key) => {
        const enabled = overrides.get(key);
        return enabled === undefined ? [] : [{ enabled, key }];
      });
    },
    async set(key, enabled) {
      overrides.set(key, enabled);
    },
  };
}

function createAuditRecorder(): {
  readonly entries: AuditRecordInput[];
  record(entry: AuditRecordInput): Promise<void>;
} {
  const entries: AuditRecordInput[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e110_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e1-10-test',
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

test('the code registry declares exactly the eight documented keys and defaults', async () => {
  const featureIndex = await readFile(
    new URL('../docs/features/README.md', import.meta.url),
    'utf8',
  );
  const documentedRegistry = Array.from(
    featureIndex.matchAll(/^\| `([^`]+)` \| (?:\*\*)?(on|off)(?:\*\*)? \|/gm),
    ([, key, state]) => [key, state === 'on'] as const,
  );

  assert.equal(campaignFlagKeys.length, 8);
  assert.equal(
    Object.values(campaignFlagRegistry).every(
      (value) => typeof value === 'boolean',
    ),
    true,
  );
  assert.deepEqual(Object.entries(campaignFlagRegistry), documentedRegistry);
});

test('an unregistered key throws without consulting the database', async () => {
  const repository = createMemoryRepository();
  const service = createFlagServiceWithDependencies(
    repository,
    createAuditRecorder(),
  );

  await assert.rejects(
    service.isEnabled('unknown.flag' as FlagKey),
    /Unregistered campaign flag: unknown.flag/,
  );
  assert.equal(repository.readCount, 0);
});

test('a database lookup failure returns every code-declared default', async () => {
  const service = createFlagServiceWithDependencies(
    {
      async list() {
        throw new DatabaseUnavailableError(new Error('database stopped'));
      },
      async set() {
        throw new Error('not used');
      },
    },
    createAuditRecorder(),
  );

  assert.deepEqual(
    await service.list(),
    campaignFlagKeys.map((key) => ({
      enabled: campaignFlagRegistry[key],
      key,
    })),
  );
});

test('set invalidates the local cache immediately and records the supplied actor', async () => {
  const repository = createMemoryRepository();
  const audit = createAuditRecorder();
  const service = createFlagServiceWithDependencies(repository, audit);

  assert.equal(await service.isEnabled('leaderboard.public'), true);
  assert.equal(repository.readCount, 1);
  await service.set('leaderboard.public', false, 'operator-1');
  assert.equal(await service.isEnabled('leaderboard.public'), false);
  assert.equal(repository.readCount, 2);
  assert.deepEqual(audit.entries, [
    {
      action: 'flag.changed',
      actor: 'operator-1',
      detail: { enabled: false },
      subjectId: 'leaderboard.public',
      subjectType: 'campaign_flag',
    },
  ]);
});

test('another service observes a change no later than the five-second TTL', async () => {
  const repository = createMemoryRepository();
  const clock = new ManualClock();
  const firstService = createFlagServiceWithDependencies(
    repository,
    createAuditRecorder(),
    clock,
  );
  const secondService = createFlagServiceWithDependencies(
    repository,
    createAuditRecorder(),
    clock,
  );

  assert.equal(await secondService.isEnabled('leaderboard.public'), true);
  await firstService.set('leaderboard.public', false, 'operator-1');
  assert.equal(await firstService.isEnabled('leaderboard.public'), false);

  clock.advance(flagCacheTtlMilliseconds - 1);
  assert.equal(await secondService.isEnabled('leaderboard.public'), true);
  clock.advance(1);
  assert.equal(await secondService.isEnabled('leaderboard.public'), false);
});

test('set rejects a missing actor before writing a flag or audit row', async () => {
  const repository = createMemoryRepository();
  const audit = createAuditRecorder();
  const service = createFlagServiceWithDependencies(repository, audit);

  await assert.rejects(
    service.set('signup.enabled', false, '  '),
    /requires an actor/,
  );
  assert.equal(repository.overrides.size, 0);
  assert.deepEqual(audit.entries, []);
});

test('the forward migration changes subject_id to text and preserves UUID values', async () => {
  const databaseName = `valstara_e110_migration_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());
  const directory = await mkdtemp(join(tmpdir(), 'valstara-e110-'));
  const existingSubjectId = randomUUID();
  const migrationNames = [
    '0001-initial-schema.sql',
    '0002-application-role-audit-log-permissions.sql',
    '0003-subscriber-giveaway-rules-version.sql',
  ] as const;

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());

  try {
    for (const migrationName of migrationNames) {
      await copyFile(
        new URL(migrationName, migrationDirectory),
        join(directory, migrationName),
      );
    }
    await runMigrations(database, {
      applicationRolePassword,
      directory,
      release: 'before-e1-10',
    });
    await database.execute({
      text: `
        INSERT INTO audit_log (
          id, actor, action, subject_type, subject_id, detail
        )
        VALUES ($1, 'operator-1', 'fraud.reviewed', 'subscriber', $2, '{}'::jsonb)
      `,
      values: [randomUUID(), existingSubjectId],
    });

    const forwardMigration = new URL(
      '0004-audit-log-polymorphic-subject-id.sql',
      migrationDirectory,
    );
    await copyFile(
      forwardMigration,
      join(directory, basename(forwardMigration.pathname)),
    );
    await runMigrations(database, {
      applicationRolePassword,
      directory,
      release: 'e1-10',
    });

    const column = await database.readOne<{ data_type: string }>({
      text: `
          SELECT data_type
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'audit_log'
            AND column_name = 'subject_id'
        `,
    });
    const row = await database.readOne<{ subject_id: string }>({
      text: `
        SELECT subject_id
        FROM audit_log
        WHERE subject_type = 'subscriber'
      `,
    });

    assert.deepEqual(column, { data_type: 'text' });
    assert.deepEqual(row, { subject_id: existingSubjectId });
  } finally {
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
    await rm(directory, { force: true, recursive: true });
  }
});

test('a persisted flag change records the flag key and actor in the audit log', async () => {
  const fixture = await createDatabaseFixture();
  const service = createFlagService(fixture.applicationDatabase);

  try {
    await service.set('leaderboard.public', false, 'operator-1');
    assert.equal(await service.isEnabled('leaderboard.public'), false);
    assert.deepEqual(
      (await service.list()).find(({ key }) => key === 'leaderboard.public'),
      { enabled: false, key: 'leaderboard.public' },
    );

    const flag = await fixture.database.readOne<{
      enabled: boolean;
      updated_by: string;
    }>({
      text: `
        SELECT enabled, updated_by
        FROM campaign_flag
        WHERE key = 'leaderboard.public'
      `,
    });
    const audit = await fixture.database.readOne<{
      action: string;
      actor: string;
      detail: { enabled: boolean };
      subject_id: string;
      subject_type: string;
    }>({
      text: `
        SELECT action, actor, detail, subject_id, subject_type
        FROM audit_log
        WHERE action = 'flag.changed'
      `,
    });

    assert.deepEqual(flag, { enabled: false, updated_by: 'operator-1' });
    assert.deepEqual(audit, {
      action: 'flag.changed',
      actor: 'operator-1',
      detail: { enabled: false },
      subject_id: 'leaderboard.public',
      subject_type: 'campaign_flag',
    });
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});
