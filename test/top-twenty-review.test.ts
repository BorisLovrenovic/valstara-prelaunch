import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createTopTwentyReviewGate,
  TopTwentyReviewRequiredError,
} from '../src/server/fraud/top-twenty-review.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e507_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e5-07-test',
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

async function insertEntrant(
  database: DatabasePool,
  label: string,
  entries: number,
): Promise<string> {
  const subscriberId = randomUUID();
  const email = `${label}@top-twenty.example`;
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status
      )
      VALUES ($1, $2, $2, 'top-twenty.example', 'verified')
    `,
    values: [subscriberId, email],
  });
  await database.execute({
    text: `
      INSERT INTO giveaway_entry (
        id, subscriber_id, method, entries, jurisdiction, rules_version
      )
      VALUES ($1, $2, 'base', $3, 'GB', 'review-v1')
    `,
    values: [randomUUID(), subscriberId, entries],
  });
  return subscriberId;
}

function reviewed(
  subscriberIds: readonly string[],
): readonly { readonly outcome: string; readonly subscriberId: string }[] {
  return subscriberIds.map((subscriberId) => ({
    outcome: 'cleared',
    subscriberId,
  }));
}

test('E5-07 refuses the award-path precondition until every current top-twenty account is reviewed and audited', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberIds = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        insertEntrant(fixture.database, `entrant-${index}`, 100 - index),
      ),
    );
    const gate = createTopTwentyReviewGate(fixture.applicationDatabase);

    await assert.rejects(
      gate.assertReviewedAndCurrent(),
      TopTwentyReviewRequiredError,
    );
    await assert.rejects(
      gate.reviewCurrentTopTwenty(
        reviewed(subscriberIds.slice(0, 19)),
        'operator',
      ),
      /Every current top-twenty account requires one outcome/u,
    );

    await gate.reviewCurrentTopTwenty(reviewed(subscriberIds), 'operator');
    await gate.assertReviewedAndCurrent();

    const outcomes = await fixture.database.list<{
      readonly actor: string;
      readonly outcome: string;
    }>(
      {
        text: `
          SELECT actor, outcome
          FROM top_twenty_review
          ORDER BY reviewed_at, subscriber_id
        `,
      },
      20,
    );
    assert.equal(outcomes.length, 20);
    assert.deepEqual(
      new Set(outcomes.map((outcome) => outcome.actor)),
      new Set(['operator']),
    );
    assert.deepEqual(
      new Set(outcomes.map((outcome) => outcome.outcome)),
      new Set(['cleared']),
    );
    const audit = await fixture.database.readOne<{
      readonly actor: string;
      readonly action: string;
    }>({
      text: `
        SELECT actor, action
        FROM audit_log
        WHERE action = 'giveaway.top_twenty_reviewed'
      `,
    });
    assert.deepEqual(audit, {
      action: 'giveaway.top_twenty_reviewed',
      actor: 'operator',
    });
  } finally {
    await fixture.dispose();
  }
});

test('E5-07 invalidates a completed review when raw top-twenty membership changes', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberIds = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        insertEntrant(fixture.database, `membership-${index}`, 100 - index),
      ),
    );
    const gate = createTopTwentyReviewGate(fixture.applicationDatabase);
    await gate.reviewCurrentTopTwenty(
      reviewed(subscriberIds.slice(0, 20)),
      'operator',
    );

    const newLeader = await insertEntrant(
      fixture.database,
      'new-leader',
      1_000,
    );
    await assert.rejects(
      gate.assertReviewedAndCurrent(),
      TopTwentyReviewRequiredError,
    );

    const invalidated = await fixture.database.readOne<{
      readonly invalidated_at: Date | null;
    }>({
      text: 'SELECT invalidated_at FROM top_twenty_review_batch',
    });
    assert.notEqual(invalidated?.invalidated_at, null);
    const invalidationAudit = await fixture.database.readOne<{
      readonly actor: string;
      readonly detail: { readonly reason: string };
    }>({
      text: `
        SELECT actor, detail
        FROM audit_log
        WHERE action = 'giveaway.top_twenty_review_invalidated'
      `,
    });
    assert.deepEqual(invalidationAudit, {
      actor: 'system:top_twenty_review_gate',
      detail: { reason: 'membership_changed' },
    });

    await gate.reviewCurrentTopTwenty(
      reviewed([newLeader, ...subscriberIds.slice(0, 19)]),
      'operator',
    );
    await gate.assertReviewedAndCurrent();
  } finally {
    await fixture.dispose();
  }
});
