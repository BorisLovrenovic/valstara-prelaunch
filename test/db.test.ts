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

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

interface ConstraintRow {
  readonly conname: string;
  readonly definition: string;
}

interface TableRow {
  readonly table_name: string;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e103_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });

  return {
    database: createPool(databaseUrl.toString()),
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

async function withDatabase(
  operation: (database: DatabasePool) => Promise<void>,
): Promise<void> {
  const fixture = await createDatabaseFixture();

  try {
    await runMigrations(fixture.database, { release: 'test' });
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
): Promise<void> {
  await database.execute({
    text: `
      INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
      VALUES ($1, $2, $3, 'example.test', 'pending')
    `,
    values: [id, emailNormalised, emailNormalised],
  });
}

function hasPostgresCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code;
}

test('migrations run once, record checksums, and reproduce the initial schema from an empty database', async () => {
  const fixture = await createDatabaseFixture();

  try {
    const initialRun = await runMigrations(fixture.database, {
      release: 'test-release',
    });
    const repeatedRun = await runMigrations(fixture.database, {
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
      10,
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
      20,
    );

    assert.deepEqual(initialRun, ['0001-initial-schema.sql']);
    assert.deepEqual(repeatedRun, []);
    assert.deepEqual(
      ledger.map((row) => row.filename),
      ['0001-initial-schema.sql'],
    );
    assert.match(ledger[0]?.checksum ?? '', /^[a-f0-9]{64}$/);
    assert.equal(ledger[0]?.applied_by_release, 'test-release');
    assert.deepEqual(
      tables.map((row) => row.table_name),
      [
        'audit_log',
        'campaign_flag',
        'email_send',
        'fraud_flag',
        'giveaway_draw',
        'giveaway_entry',
        'migration_ledger',
        'milestone_award',
        'rate_limit_bucket',
        'referral_edge',
        'subscriber',
        'suppression',
        'survey_response',
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
    await runMigrations(fixture.database, { directory, release: 'test' });
    await writeFile(
      migrationPath,
      'CREATE TABLE checksum_test (id integer PRIMARY KEY, label text);\n',
    );

    await assert.rejects(
      runMigrations(fixture.database, { directory, release: 'test' }),
      MigrationChecksumMismatchError,
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
            await runMigrations(fixture.database, { release: 'property-test' })
          ).length;
        }
        const ledger = await fixture.database.list<{ filename: string }>(
          { text: 'SELECT filename FROM migration_ledger' },
          2,
        );

        assert.equal(appliedCount, 1);
        assert.deepEqual(
          ledger.map((row) => row.filename),
          ['0001-initial-schema.sql'],
        );
      } finally {
        await fixture.database.close();
        await fixture.dispose();
      }
    }),
    { seed: 20_260_825, numRuns: 5 },
  );
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
            'uq_milestone_award_subscriber_tier',
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
        conname: 'uq_milestone_award_subscriber_tier',
        definition: 'UNIQUE (subscriber_id, tier)',
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
        INSERT INTO giveaway_entry (id, subscriber_id, method, entries, jurisdiction, rules_version)
        VALUES ($1, $2, 'base', 1, 'SE', 'v1')
      `,
      values: [entryId, referrerId],
    });
    await assert.rejects(
      database.execute({
        text: `
          INSERT INTO giveaway_entry (id, subscriber_id, method, entries, jurisdiction, rules_version)
          VALUES ($1, $2, 'base', 1, 'SE', 'v1')
        `,
        values: [randomUUID(), referrerId],
      }),
      hasPostgresCode('23505'),
    );
  });
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
              INSERT INTO giveaway_entry (id, subscriber_id, method, entries, jurisdiction, rules_version)
              VALUES ($1, $2, 'base', 1, 'SE', 'v1')
            `,
            values: [entryId, subscriberId],
          });
          await assert.rejects(
            database.execute({
              text: `
                INSERT INTO giveaway_entry (id, subscriber_id, method, entries, jurisdiction, rules_version)
                VALUES ($1, $2, 'base', 1, 'SE', 'v1')
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
