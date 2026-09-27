import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fc from 'fast-check';

import {
  DatabaseUnavailableError,
  MigrationChecksumMismatchError,
} from '../src/server/db/errors.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { withTransaction } from '../src/server/db/transaction.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRole = 'valstara_app';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
interface DatabaseFixture {
  readonly database: DatabasePool;
  readonly databaseUrl: string;
  readonly applicationDatabaseUrl: string;
  dispose(): Promise<void>;
}

interface ConstraintRow {
  readonly conname: string;
  readonly definition: string;
}

interface TableRow {
  readonly table_name: string;
}

interface ActivityRow {
  readonly wait_event: string | null;
  readonly wait_event_type: string | null;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e103_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationDatabaseUrl = new URL(databaseUrl);
  applicationDatabaseUrl.username = applicationRole;
  applicationDatabaseUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });

  return {
    database: createPool(databaseUrl.toString()),
    databaseUrl: databaseUrl.toString(),
    applicationDatabaseUrl: applicationDatabaseUrl.toString(),
    async dispose() {
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

function migrate(
  database: DatabasePool,
  options: Omit<Parameters<typeof runMigrations>[1], 'applicationRolePassword'>,
): ReturnType<typeof runMigrations> {
  return runMigrations(database, { ...options, applicationRolePassword });
}

async function withDatabase(
  operation: (database: DatabasePool) => Promise<void>,
): Promise<void> {
  const fixture = await createDatabaseFixture();

  try {
    await migrate(fixture.database, { release: 'test' });
    await operation(fixture.database);
  } finally {
    await fixture.database.close();
    await fixture.dispose();
  }
}

async function insertSubscriber(
  database: DatabasePool,
  id: string,
  emailNormalised = `${id}@example.test`,
  email = emailNormalised,
): Promise<void> {
  await database.execute({
    text: `
      INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
      VALUES ($1, $2, $3, 'example.test', 'pending')
    `,
    values: [id, email, emailNormalised],
  });
}

function hasPostgresCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code;
}

async function assertExactlyOneWriteSucceeds(
  writes: readonly [Promise<unknown>, Promise<unknown>],
): Promise<void> {
  const results = await Promise.allSettled(writes);
  const successfulWrites = results.filter(
    (result) => result.status === 'fulfilled',
  );
  const failedWrites = results.filter((result) => result.status === 'rejected');

  assert.equal(successfulWrites.length, 1);
  assert.equal(failedWrites.length, 1);
  assert.equal(
    failedWrites[0]?.status === 'rejected' &&
      hasPostgresCode('23505')(failedWrites[0].reason),
    true,
  );
}

function databaseUrlWithApplicationName(
  databaseUrl: string,
  applicationName: string,
): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

async function waitForMigrationActivity(
  database: DatabasePool,
  applicationName: string,
  expectedWaitEvent: ActivityRow,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await database.readOne<ActivityRow>({
      text: `
        SELECT wait_event, wait_event_type
        FROM pg_stat_activity
        WHERE application_name = $1
          AND state <> 'idle'
      `,
      values: [applicationName],
    });

    if (
      activity?.wait_event === expectedWaitEvent.wait_event &&
      activity.wait_event_type === expectedWaitEvent.wait_event_type
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  assert.fail(
    `${applicationName} did not reach ${expectedWaitEvent.wait_event_type}:${expectedWaitEvent.wait_event}`,
  );
}

test('migrations run once, record checksums, and reproduce the initial schema with the giveaway rules version from an empty database', async () => {
  const fixture = await createDatabaseFixture();

  try {
    const initialRun = await migrate(fixture.database, {
      release: 'test-release',
    });
    const repeatedRun = await migrate(fixture.database, {
      release: 'test-release',
    });
    const ledger = await fixture.database.list<{
      filename: string;
      checksum: string;
      applied_by_release: string;
    }>(
      {
        text: 'SELECT filename, checksum, applied_by_release FROM migration_ledger ORDER BY filename',
      },
      33,
    );
    const tables = await fixture.database.list<TableRow>(
      {
        text: `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
          ORDER BY table_name
        `,
      },
      21,
    );
    const giveawayRulesVersionColumn = await fixture.database.readOne<{
      data_type: string;
      is_nullable: string;
    }>({
      text: `
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'subscriber'
          AND column_name = 'giveaway_rules_version'
      `,
    });

    assert.deepEqual(initialRun, [
      '0001-initial-schema.sql',
      '0002-application-role-audit-log-permissions.sql',
      '0003-subscriber-giveaway-rules-version.sql',
      '0004-audit-log-polymorphic-subject-id.sql',
      '0005-fraud-flag-challenge-timeout-kind.sql',
      '0006-subscriber-maintenance-permissions.sql',
      '0007-verification-rate-monitor-permissions.sql',
      '0008-e1-e3-runtime-role-permissions.sql',
      '0009-milestone-reward-kinds.sql',
      '0010-referral-utm-permissions.sql',
      '0011-referral-attribution-permissions.sql',
      '0012-reward-gating-permissions.sql',
      '0013-domain-allow-overrides.sql',
      '0014-domain-allow-domain-constraint.sql',
      '0015-duplicate-identity-local-part-index.sql',
      '0016-ip-velocity-permissions.sql',
      '0017-fraud-review-queue-permissions.sql',
      '0018-disqualification-state.sql',
      '0019-ranking-integrity-permissions.sql',
      '0020-top-twenty-review-gate.sql',
      '0021-survey-capture-permissions.sql',
      '0022-member-dashboard-status-permissions.sql',
      '0023-hong-kong-giveaway-and-marketing-consent.sql',
      '0024-giveaway-entry-ledger.sql',
      '0025-giveaway-entry-integrity.sql',
      '0026-giveaway-entry-one-unit.sql',
      '0027-reproducible-draw.sql',
      '0028-draw-entry-lock.sql',
      '0029-draw-evidence-write-once.sql',
      '0030-draw-commit-order.sql',
      '0031-draw-ledger-closure.sql',
      '0032-giveaway-awards.sql',
      '0033-giveaway-award-offer.sql',
    ]);
    assert.deepEqual(repeatedRun, []);
    assert.deepEqual(
      ledger.map((row) => row.filename),
      [
        '0001-initial-schema.sql',
        '0002-application-role-audit-log-permissions.sql',
        '0003-subscriber-giveaway-rules-version.sql',
        '0004-audit-log-polymorphic-subject-id.sql',
        '0005-fraud-flag-challenge-timeout-kind.sql',
        '0006-subscriber-maintenance-permissions.sql',
        '0007-verification-rate-monitor-permissions.sql',
        '0008-e1-e3-runtime-role-permissions.sql',
        '0009-milestone-reward-kinds.sql',
        '0010-referral-utm-permissions.sql',
        '0011-referral-attribution-permissions.sql',
        '0012-reward-gating-permissions.sql',
        '0013-domain-allow-overrides.sql',
        '0014-domain-allow-domain-constraint.sql',
        '0015-duplicate-identity-local-part-index.sql',
        '0016-ip-velocity-permissions.sql',
        '0017-fraud-review-queue-permissions.sql',
        '0018-disqualification-state.sql',
        '0019-ranking-integrity-permissions.sql',
        '0020-top-twenty-review-gate.sql',
        '0021-survey-capture-permissions.sql',
        '0022-member-dashboard-status-permissions.sql',
        '0023-hong-kong-giveaway-and-marketing-consent.sql',
        '0024-giveaway-entry-ledger.sql',
        '0025-giveaway-entry-integrity.sql',
        '0026-giveaway-entry-one-unit.sql',
        '0027-reproducible-draw.sql',
        '0028-draw-entry-lock.sql',
        '0029-draw-evidence-write-once.sql',
        '0030-draw-commit-order.sql',
        '0031-draw-ledger-closure.sql',
        '0032-giveaway-awards.sql',
        '0033-giveaway-award-offer.sql',
      ],
    );
    assert.deepEqual(giveawayRulesVersionColumn, {
      data_type: 'text',
      is_nullable: 'YES',
    });
    assert.match(ledger[0]?.checksum ?? '', /^[a-f0-9]{64}$/);
    assert.equal(ledger[0]?.applied_by_release, 'test-release');
    assert.deepEqual(
      tables.map((row) => row.table_name),
      [
        'audit_log',
        'campaign_flag',
        'domain_allow',
        'email_send',
        'fraud_flag',
        'giveaway_award',
        'giveaway_award_candidate',
        'giveaway_draw',
        'giveaway_draw_selection',
        'giveaway_draw_snapshot_row',
        'giveaway_entry',
        'migration_ledger',
        'milestone_award',
        'rate_limit_bucket',
        'referral_edge',
        'subscriber',
        'suppression',
        'survey_response',
        'top_twenty_review',
        'top_twenty_review_batch',
        'verification_token',
      ],
    );
  } finally {
    await fixture.database.close();
    await fixture.dispose();
  }
});

test('an edited applied migration aborts with a checksum mismatch', async () => {
  const fixture = await createDatabaseFixture();
  const directory = await mkdtemp(join(tmpdir(), 'valstara-e103-'));

  try {
    const migrationPath = join(directory, '0001-checksum.sql');
    await writeFile(
      migrationPath,
      'CREATE TABLE checksum_test (id integer PRIMARY KEY);\n',
    );
    await migrate(fixture.database, { directory, release: 'test' });
    await writeFile(
      migrationPath,
      'CREATE TABLE checksum_test (id integer PRIMARY KEY, label text);\n',
    );

    await assert.rejects(
      migrate(fixture.database, { directory, release: 'test' }),
      MigrationChecksumMismatchError,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
    await fixture.database.close();
    await fixture.dispose();
  }
});

test('an applied migration deleted from disk aborts instead of being silently accepted', async () => {
  const fixture = await createDatabaseFixture();
  const directory = await mkdtemp(join(tmpdir(), 'valstara-e103-'));

  try {
    const migrationPath = join(directory, '0001-probe.sql');
    await writeFile(
      migrationPath,
      'CREATE TABLE deletion_probe (id integer PRIMARY KEY);\n',
    );
    await migrate(fixture.database, { directory, release: 'test' });
    await rm(migrationPath);

    await assert.rejects(
      migrate(fixture.database, { directory, release: 'test' }),
      /Applied migration history does not match checked-in files/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
    await fixture.database.close();
    await fixture.dispose();
  }
});

test('a migration inserted before applied history aborts instead of running retroactively', async () => {
  const fixture = await createDatabaseFixture();
  const directory = await mkdtemp(join(tmpdir(), 'valstara-e103-'));

  try {
    await writeFile(
      join(directory, '0002-existing.sql'),
      'CREATE TABLE existing_probe (id integer PRIMARY KEY);\n',
    );
    await migrate(fixture.database, { directory, release: 'test' });
    await writeFile(
      join(directory, '0001-retroactive.sql'),
      'CREATE TABLE retroactive_probe (id integer PRIMARY KEY);\n',
    );

    await assert.rejects(
      migrate(fixture.database, { directory, release: 'test' }),
      /Applied migration history does not match checked-in files/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
    await fixture.database.close();
    await fixture.dispose();
  }
});

test('the migration runner is idempotent across a seeded range of repeat counts', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (repeatCount) => {
      const fixture = await createDatabaseFixture();

      try {
        let appliedCount = 0;
        for (let index = 0; index < repeatCount; index += 1) {
          appliedCount += (
            await migrate(fixture.database, { release: 'property-test' })
          ).length;
        }
        const ledger = await fixture.database.list<{ filename: string }>(
          { text: 'SELECT filename FROM migration_ledger ORDER BY filename' },
          33,
        );

        assert.equal(appliedCount, 33);
        assert.deepEqual(
          ledger.map((row) => row.filename),
          [
            '0001-initial-schema.sql',
            '0002-application-role-audit-log-permissions.sql',
            '0003-subscriber-giveaway-rules-version.sql',
            '0004-audit-log-polymorphic-subject-id.sql',
            '0005-fraud-flag-challenge-timeout-kind.sql',
            '0006-subscriber-maintenance-permissions.sql',
            '0007-verification-rate-monitor-permissions.sql',
            '0008-e1-e3-runtime-role-permissions.sql',
            '0009-milestone-reward-kinds.sql',
            '0010-referral-utm-permissions.sql',
            '0011-referral-attribution-permissions.sql',
            '0012-reward-gating-permissions.sql',
            '0013-domain-allow-overrides.sql',
            '0014-domain-allow-domain-constraint.sql',
            '0015-duplicate-identity-local-part-index.sql',
            '0016-ip-velocity-permissions.sql',
            '0017-fraud-review-queue-permissions.sql',
            '0018-disqualification-state.sql',
            '0019-ranking-integrity-permissions.sql',
            '0020-top-twenty-review-gate.sql',
            '0021-survey-capture-permissions.sql',
            '0022-member-dashboard-status-permissions.sql',
            '0023-hong-kong-giveaway-and-marketing-consent.sql',
            '0024-giveaway-entry-ledger.sql',
            '0025-giveaway-entry-integrity.sql',
            '0026-giveaway-entry-one-unit.sql',
            '0027-reproducible-draw.sql',
            '0028-draw-entry-lock.sql',
            '0029-draw-evidence-write-once.sql',
            '0030-draw-commit-order.sql',
            '0031-draw-ledger-closure.sql',
            '0032-giveaway-awards.sql',
            '0033-giveaway-award-offer.sql',
          ],
        );
      } finally {
        await fixture.database.close();
        await fixture.dispose();
      }
    }),
    { seed: 20_260_825, numRuns: 5 },
  );
});

test('concurrent migration runners serialize on the PostgreSQL advisory lock', async () => {
  const fixture = await createDatabaseFixture();
  const directory = await mkdtemp(join(tmpdir(), 'valstara-e103-'));
  const firstRunnerName = 'e103-migration-runner-first';
  const secondRunnerName = 'e103-migration-runner-second';
  const firstRunner = createPool(
    databaseUrlWithApplicationName(fixture.databaseUrl, firstRunnerName),
  );
  const secondRunner = createPool(
    databaseUrlWithApplicationName(fixture.databaseUrl, secondRunnerName),
  );

  try {
    await writeFile(
      join(directory, '0001-concurrency-probe.sql'),
      'DO $$ BEGIN PERFORM pg_sleep(0.5); END; $$;\nCREATE TABLE migration_concurrency_probe (id integer PRIMARY KEY);\n',
    );

    const firstRun = migrate(firstRunner, {
      directory,
      release: 'concurrency-test',
    });
    await waitForMigrationActivity(fixture.database, firstRunnerName, {
      wait_event: 'PgSleep',
      wait_event_type: 'Timeout',
    });

    const secondRun = migrate(secondRunner, {
      directory,
      release: 'concurrency-test',
    });
    await waitForMigrationActivity(fixture.database, secondRunnerName, {
      wait_event: 'advisory',
      wait_event_type: 'Lock',
    });

    const [firstApplied, secondApplied] = await Promise.all([
      firstRun,
      secondRun,
    ]);
    const ledger = await fixture.database.list<{ filename: string }>(
      { text: 'SELECT filename FROM migration_ledger ORDER BY filename' },
      2,
    );

    assert.deepEqual(firstApplied, ['0001-concurrency-probe.sql']);
    assert.deepEqual(secondApplied, []);
    assert.deepEqual(ledger, [{ filename: '0001-concurrency-probe.sql' }]);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await firstRunner.close();
    await secondRunner.close();
    await fixture.database.close();
    await fixture.dispose();
  }
});

test('the named database constraints exist in the PostgreSQL catalogue', async () => {
  await withDatabase(async (database) => {
    const constraints = await database.list<ConstraintRow>(
      {
        text: `
          SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conname = ANY($1::text[])
          ORDER BY conname
        `,
        values: [
          [
            'uq_email_send_business_key',
            'uq_giveaway_entry_subscriber_method_source_edge',
            'uq_milestone_award_subscriber_tier_kind',
            'uq_referral_edge_referred_id',
            'uq_subscriber_email_normalised',
          ],
        ],
      },
      10,
    );

    assert.deepEqual(constraints, [
      {
        conname: 'uq_email_send_business_key',
        definition: 'UNIQUE (business_key)',
      },
      {
        conname: 'uq_giveaway_entry_subscriber_method_source_edge',
        definition:
          'UNIQUE NULLS NOT DISTINCT (subscriber_id, method, source_edge_id)',
      },
      {
        conname: 'uq_milestone_award_subscriber_tier_kind',
        definition: 'UNIQUE (subscriber_id, tier, reward_kind)',
      },
      {
        conname: 'uq_referral_edge_referred_id',
        definition: 'UNIQUE (referred_id)',
      },
      {
        conname: 'uq_subscriber_email_normalised',
        definition: 'UNIQUE (email_normalised)',
      },
    ]);
  });
});

test('unique keys reject duplicates at the database level', async () => {
  await withDatabase(async (database) => {
    const referrerId = randomUUID();
    const referredId = randomUUID();
    const alternateReferrerId = randomUUID();
    const emailSendId = randomUUID();
    const awardId = randomUUID();
    const entryId = randomUUID();

    await insertSubscriber(database, referrerId);
    await insertSubscriber(database, referredId);
    await insertSubscriber(database, alternateReferrerId);

    await assert.rejects(
      insertSubscriber(database, randomUUID(), `${referrerId}@example.test`),
      hasPostgresCode('23505'),
    );

    await database.execute({
      text: `
        INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
        VALUES ($1, $2, $3, 'attributed', 'none')
      `,
      values: [randomUUID(), referrerId, referredId],
    });
    await assert.rejects(
      database.execute({
        text: `
          INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
          VALUES ($1, $2, $3, 'attributed', 'none')
        `,
        values: [randomUUID(), alternateReferrerId, referredId],
      }),
      hasPostgresCode('23505'),
    );

    await database.execute({
      text: `
        INSERT INTO email_send (id, subscriber_id, template, provider, business_key, state)
        VALUES ($1, $2, 'verification', 'resend', 'verify:example', 'queued')
      `,
      values: [emailSendId, referrerId],
    });
    await assert.rejects(
      database.execute({
        text: `
          INSERT INTO email_send (id, subscriber_id, template, provider, business_key, state)
          VALUES ($1, $2, 'verification', 'resend', 'verify:example', 'queued')
        `,
        values: [randomUUID(), referrerId],
      }),
      hasPostgresCode('23505'),
    );

    await database.execute({
      text: `
        INSERT INTO milestone_award (id, subscriber_id, tier, reward_kind, state)
        VALUES ($1, $2, 1, 'entries', 'settled')
      `,
      values: [awardId, referrerId],
    });
    await assert.rejects(
      database.execute({
        text: `
          INSERT INTO milestone_award (id, subscriber_id, tier, reward_kind, state)
          VALUES ($1, $2, 1, 'entries', 'settled')
        `,
        values: [randomUUID(), referrerId],
      }),
      hasPostgresCode('23505'),
    );

    await database.execute({
      text: `
        INSERT INTO giveaway_entry (id, subscriber_id, method, entries, rules_version, rules_sha256)
        VALUES ($1, $2, 'base', 1, 'v1', decode(repeat('ab', 32), 'hex'))
      `,
      values: [entryId, referrerId],
    });
    await assert.rejects(
      database.execute({
        text: `
          INSERT INTO giveaway_entry (id, subscriber_id, method, entries, rules_version, rules_sha256)
          VALUES ($1, $2, 'base', 1, 'v1', decode(repeat('ab', 32), 'hex'))
        `,
        values: [randomUUID(), referrerId],
      }),
      hasPostgresCode('23505'),
    );
  });
});

test('subscriber rejects distinct raw emails with the same normalised key', async () => {
  await withDatabase(async (database) => {
    const emailNormalised = 'alex@example.test';

    await insertSubscriber(
      database,
      randomUUID(),
      emailNormalised,
      'Alex+launch@example.test',
    );
    await assert.rejects(
      insertSubscriber(
        database,
        randomUUID(),
        emailNormalised,
        'alex@example.test',
      ),
      hasPostgresCode('23505'),
    );
  });
});

test('pending subscribers have null referral codes and the unique index permits two null codes', async () => {
  await withDatabase(async (database) => {
    await insertSubscriber(database, randomUUID());
    await insertSubscriber(database, randomUUID());

    const pendingSubscribers = await database.list<{
      referral_code: string | null;
    }>(
      {
        text: `
          SELECT referral_code
          FROM subscriber
          WHERE status = 'pending'
          ORDER BY created_at, id
        `,
      },
      2,
    );

    assert.deepEqual(pendingSubscribers, [
      { referral_code: null },
      { referral_code: null },
    ]);
  });
});

test('the application role rejects audit-log updates and deletes at the database level', async () => {
  const fixture = await createDatabaseFixture();
  const auditLogId = randomUUID();
  const applicationDatabase = createPool(fixture.applicationDatabaseUrl);

  try {
    await migrate(fixture.database, { release: 'test' });
    await applicationDatabase.execute({
      text: `
        INSERT INTO audit_log (id, actor, action, subject_type, detail)
        VALUES ($1, 'test-actor', 'test.action', 'subscriber', '{}'::jsonb)
      `,
      values: [auditLogId],
    });

    await assert.rejects(
      applicationDatabase.execute({
        text: "UPDATE audit_log SET action = 'changed' WHERE id = $1",
        values: [auditLogId],
      }),
      hasPostgresCode('42501'),
    );
    await assert.rejects(
      applicationDatabase.execute({
        text: 'DELETE FROM audit_log WHERE id = $1',
        values: [auditLogId],
      }),
      hasPostgresCode('42501'),
    );
  } finally {
    await applicationDatabase.close();
    await fixture.database.close();
    await fixture.dispose();
  }
});

test('the application role authenticates after migrations upgrade an existing database', async () => {
  const fixture = await createDatabaseFixture();
  const applicationDatabase = createPool(fixture.applicationDatabaseUrl);

  try {
    await migrate(fixture.database, { release: 'test' });
    const identity = await applicationDatabase.readOne<{
      current_user: string;
    }>({ text: 'SELECT current_user' });

    assert.deepEqual(identity, { current_user: applicationRole });
  } finally {
    await applicationDatabase.close();
    await fixture.database.close();
    await fixture.dispose();
  }
});

test('concurrent database sessions allow exactly one duplicate normalised email and referral edge write', async () => {
  const fixture = await createDatabaseFixture();
  const firstSession = createPool(fixture.databaseUrl);
  const secondSession = createPool(fixture.databaseUrl);

  try {
    await migrate(fixture.database, { release: 'test' });

    const emailNormalised = `${randomUUID()}@example.test`;
    await assertExactlyOneWriteSucceeds([
      insertSubscriber(firstSession, randomUUID(), emailNormalised),
      insertSubscriber(secondSession, randomUUID(), emailNormalised),
    ]);

    const referrerId = randomUUID();
    const alternateReferrerId = randomUUID();
    const referredId = randomUUID();
    await insertSubscriber(fixture.database, referrerId);
    await insertSubscriber(fixture.database, alternateReferrerId);
    await insertSubscriber(fixture.database, referredId);

    await assertExactlyOneWriteSucceeds([
      firstSession.execute({
        text: `
          INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
          VALUES ($1, $2, $3, 'attributed', 'none')
        `,
        values: [randomUUID(), referrerId, referredId],
      }),
      secondSession.execute({
        text: `
          INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
          VALUES ($1, $2, $3, 'attributed', 'none')
        `,
        values: [randomUUID(), alternateReferrerId, referredId],
      }),
    ]);
  } finally {
    await firstSession.close();
    await secondSession.close();
    await fixture.database.close();
    await fixture.dispose();
  }
});

test('all unique constraints and the write-once trigger hold across seeded generated rows', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.uuid(), { minLength: 13, maxLength: 13 }),
      fc.integer({ min: 0, max: 1_000 }),
      async (ids, tier) => {
        await withDatabase(async (database) => {
          const [
            subscriberId,
            duplicateSubscriberId,
            referrerId,
            alternateReferrerId,
            referredId,
            edgeId,
            duplicateEdgeId,
            emailSendId,
            duplicateEmailSendId,
            awardId,
            duplicateAwardId,
            entryId,
            duplicateEntryId,
          ] = ids;
          const emailNormalised = `${subscriberId}@example.test`;
          const businessKey = `verification:${subscriberId}`;

          await insertSubscriber(database, subscriberId, emailNormalised);
          await insertSubscriber(database, referrerId);
          await insertSubscriber(database, alternateReferrerId);
          await insertSubscriber(database, referredId);

          await assert.rejects(
            insertSubscriber(database, duplicateSubscriberId, emailNormalised),
            hasPostgresCode('23505'),
          );

          await database.execute({
            text: `
              INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
              VALUES ($1, $2, $3, 'attributed', 'none')
            `,
            values: [edgeId, referrerId, referredId],
          });
          await assert.rejects(
            database.execute({
              text: `
                INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
                VALUES ($1, $2, $3, 'attributed', 'none')
              `,
              values: [duplicateEdgeId, alternateReferrerId, referredId],
            }),
            hasPostgresCode('23505'),
          );

          await database.execute({
            text: `
              INSERT INTO email_send (id, subscriber_id, template, provider, business_key, state)
              VALUES ($1, $2, 'verification', 'resend', $3, 'queued')
            `,
            values: [emailSendId, subscriberId, businessKey],
          });
          await assert.rejects(
            database.execute({
              text: `
                INSERT INTO email_send (id, subscriber_id, template, provider, business_key, state)
                VALUES ($1, $2, 'verification', 'resend', $3, 'queued')
              `,
              values: [duplicateEmailSendId, subscriberId, businessKey],
            }),
            hasPostgresCode('23505'),
          );

          await database.execute({
            text: `
              INSERT INTO milestone_award (id, subscriber_id, tier, reward_kind, state)
              VALUES ($1, $2, $3, 'entries', 'settled')
            `,
            values: [awardId, subscriberId, tier],
          });
          await assert.rejects(
            database.execute({
              text: `
                INSERT INTO milestone_award (id, subscriber_id, tier, reward_kind, state)
                VALUES ($1, $2, $3, 'entries', 'settled')
              `,
              values: [duplicateAwardId, subscriberId, tier],
            }),
            hasPostgresCode('23505'),
          );

          await database.execute({
            text: `
              INSERT INTO giveaway_entry (id, subscriber_id, method, entries, rules_version, rules_sha256)
              VALUES ($1, $2, 'base', 1, 'v1', decode(repeat('ab', 32), 'hex'))
            `,
            values: [entryId, subscriberId],
          });
          await assert.rejects(
            database.execute({
              text: `
                INSERT INTO giveaway_entry (id, subscriber_id, method, entries, rules_version, rules_sha256)
                VALUES ($1, $2, 'base', 1, 'v1', decode(repeat('ab', 32), 'hex'))
              `,
              values: [duplicateEntryId, subscriberId],
            }),
            hasPostgresCode('23505'),
          );

          await database.execute({
            text: 'UPDATE subscriber SET referred_by_id = $1 WHERE id = $2',
            values: [referrerId, referredId],
          });
          await assert.rejects(
            database.execute({
              text: 'UPDATE subscriber SET referred_by_id = $1 WHERE id = $2',
              values: [alternateReferrerId, referredId],
            }),
            hasPostgresCode('P0001'),
          );
        });
      },
    ),
    { seed: 20_260_825, numRuns: 3 },
  );
});

test('subscriber.referred_by_id can be set once but cannot be reassigned', async () => {
  await withDatabase(async (database) => {
    const referrerId = randomUUID();
    const otherReferrerId = randomUUID();
    const referredId = randomUUID();

    await insertSubscriber(database, referrerId);
    await insertSubscriber(database, otherReferrerId);
    await insertSubscriber(database, referredId);
    await database.execute({
      text: 'UPDATE subscriber SET referred_by_id = $1 WHERE id = $2',
      values: [referrerId, referredId],
    });

    await assert.rejects(
      database.execute({
        text: 'UPDATE subscriber SET referred_by_id = $1 WHERE id = $2',
        values: [otherReferrerId, referredId],
      }),
      hasPostgresCode('P0001'),
    );
  });
});

test('the transaction helper rolls back and query lists require an explicit positive limit', async () => {
  await withDatabase(async (database) => {
    await assert.rejects(
      withTransaction(database, async (connection) => {
        await connection.execute({
          text: `
            INSERT INTO suppression (email_normalised, reason, source)
            VALUES ('rollback@example.test', 'manual', 'test')
          `,
        });
        throw new Error('induced rollback');
      }),
      /induced rollback/,
    );

    const suppressed = await database.readOne<{ email_normalised: string }>({
      text: "SELECT email_normalised FROM suppression WHERE email_normalised = 'rollback@example.test'",
    });
    const limited = await database.list<{ value: number }>(
      { text: 'SELECT generate_series(1, 3) AS value' },
      2,
    );

    await assert.rejects(
      database.list({ text: 'SELECT generate_series(1, 3)' }, Number.NaN),
      RangeError,
    );
    await assert.rejects(
      database.execute({ text: 'SELECT generate_series(1, 3)' }),
      /Result-set queries must use readOne\(\) or list\(\) with an explicit limit/,
    );
    await assert.rejects(
      database.execute({
        text: '/* leading comment */ SELECT generate_series(1, 3)',
      }),
      /Result-set queries must use readOne\(\) or list\(\) with an explicit limit/,
    );
    await assert.doesNotReject(
      database.execute({
        text: `
          /* SELECT inside a comment is not a result query. */
          INSERT INTO suppression (email_normalised, reason, source)
          VALUES ('comment@example.test', 'manual', 'test')
        `,
      }),
    );
    assert.equal(suppressed, null);
    assert.deepEqual(
      limited.map((row) => row.value),
      [1, 2],
    );
  });
});

test('pool exhaustion surfaces as DatabaseUnavailableError', async () => {
  const database = createPool(
    process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl,
  );
  const connections = await Promise.all(
    Array.from({ length: 10 }, () => database.connect()),
  );

  try {
    await assert.rejects(database.connect(), DatabaseUnavailableError);
  } finally {
    for (const connection of connections) {
      connection.release();
    }
    await database.close();
  }
});
