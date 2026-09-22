import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  currentSurveyVersion,
  validateSurveySubmission,
} from '../src/server/survey/questions.ts';
import { createSurveyService } from '../src/server/survey/service.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-22T12:00:00.000Z');

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e603_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e6-03-test',
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
  status: 'pending' | 'verified',
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at
      )
      VALUES ($1, $2, $2, 'example.test', $3, $4)
    `,
    values: [
      id,
      `${id}@example.test`,
      status,
      status === 'verified' ? now : null,
    ],
  });
  return id;
}

async function seedStatusToken(
  database: DatabasePool,
  subscriberId: string,
  token: string,
): Promise<void> {
  await database.execute({
    text: `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at
      )
      VALUES ($1, $2, $3, 'status', $4)
    `,
    values: [
      randomUUID(),
      subscriberId,
      createHash('sha256').update(token).digest(),
      new Date('2026-10-22T12:00:00.000Z'),
    ],
  });
}

async function seedConsumedVerificationToken(
  database: DatabasePool,
  subscriberId: string,
  token: string,
): Promise<void> {
  await database.execute({
    text: `
      INSERT INTO verification_token (
        id, subscriber_id, token_hash, purpose, expires_at, consumed_at
      )
      VALUES ($1, $2, $3, 'verify', $4, $5)
    `,
    values: [
      randomUUID(),
      subscriberId,
      createHash('sha256').update(token).digest(),
      new Date('2026-10-22T12:00:00.000Z'),
      now,
    ],
  });
}

function submission(token: string) {
  return {
    answers: {
      category_preference: ['apparel', 'home'],
      shopping_frequency: 'monthly',
    },
    ipPrefixHash: 'hashed-prefix',
    token,
    version: currentSurveyVersion,
  } as const;
}

test('answers validate and persist against their named version across a question-set change', async () => {
  const fixture = await createDatabaseFixture();
  const earlierVersion = '2026-09-08';
  const changedCurrentVersion = '2026-10-01';
  const versionedSets = {
    [earlierVersion]: {
      categoryPreference: ['apparel', 'home'],
      shoppingFrequency: ['monthly'],
    },
    [changedCurrentVersion]: {
      categoryPreference: ['collectibles'],
      shoppingFrequency: ['quarterly'],
    },
  } as const;

  try {
    const earlierSubscriberId = await insertSubscriber(
      fixture.database,
      'verified',
    );
    const earlierToken = 'earlier-version-survey-status-token';
    await seedStatusToken(fixture.database, earlierSubscriberId, earlierToken);
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
      questionSets: versionedSets,
    });

    assert.equal(
      await capture({
        answers: {
          category_preference: ['apparel'],
          shopping_frequency: 'monthly',
        },
        ipPrefixHash: 'earlier-version-prefix',
        token: earlierToken,
        version: earlierVersion,
      }),
      'saved',
    );
    const earlierStoredResponse = await fixture.database.readOne({
      text: 'SELECT answers, version FROM survey_response WHERE subscriber_id = $1',
      values: [earlierSubscriberId],
    });
    assert.deepEqual(earlierStoredResponse, {
      answers: {
        category_preference: ['apparel'],
        shopping_frequency: 'monthly',
      },
      version: earlierVersion,
    });

    const currentSubscriberId = await insertSubscriber(
      fixture.database,
      'verified',
    );
    const currentToken = 'changed-current-version-survey-status-token';
    await seedStatusToken(fixture.database, currentSubscriberId, currentToken);
    assert.equal(
      await capture({
        answers: {
          category_preference: ['collectibles'],
          shopping_frequency: 'quarterly',
        },
        ipPrefixHash: 'changed-current-version-prefix',
        token: currentToken,
        version: changedCurrentVersion,
      }),
      'saved',
    );

    assert.deepEqual(
      await fixture.database.readOne({
        text: 'SELECT answers, version FROM survey_response WHERE subscriber_id = $1',
        values: [currentSubscriberId],
      }),
      {
        answers: {
          category_preference: ['collectibles'],
          shopping_frequency: 'quarterly',
        },
        version: changedCurrentVersion,
      },
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: 'SELECT answers, version FROM survey_response WHERE subscriber_id = $1',
        values: [earlierSubscriberId],
      }),
      earlierStoredResponse,
      'changing the current question-set version leaves the earlier response unchanged',
    );

    assert.equal(
      validateSurveySubmission(
        {
          answers: {
            category_preference: ['collectibles'],
            shopping_frequency: 'quarterly',
          },
          version: earlierVersion,
        },
        versionedSets,
      ),
      null,
    );
    assert.notEqual(
      validateSurveySubmission({
        answers: {
          category_preference: null,
          shopping_frequency: 'monthly',
        },
        version: currentSurveyVersion,
      }),
      null,
    );
    assert.notEqual(
      validateSurveySubmission({
        answers: {
          category_preference: ['home'],
          shopping_frequency: null,
        },
        version: currentSurveyVersion,
      }),
      null,
    );
  } finally {
    await fixture.dispose();
  }
});

test('a full skip is stored explicitly and does not denormalise categories', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'verified');
    const token = 'survey-skip-status-token';
    await seedStatusToken(fixture.database, subscriberId, token);
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });

    assert.equal(
      await capture({
        answers: {
          category_preference: null,
          shopping_frequency: null,
        },
        ipPrefixHash: 'skip-prefix',
        token,
        version: currentSurveyVersion,
      }),
      'skipped',
    );

    assert.deepEqual(
      await fixture.database.readOne({
        text: `
          SELECT r.answers, r.version, s.category_preference
          FROM survey_response r
          JOIN subscriber s ON s.id = r.subscriber_id
          WHERE r.subscriber_id = $1
        `,
        values: [subscriberId],
      }),
      {
        answers: {
          category_preference: null,
          shopping_frequency: null,
        },
        category_preference: null,
        version: currentSurveyVersion,
      },
    );

    const verificationReplayToken = 'survey-skip-verification-replay';
    await seedConsumedVerificationToken(
      fixture.database,
      subscriberId,
      verificationReplayToken,
    );
    const completion = await createVerificationCompletionService(
      fixture.applicationDatabase,
      { clock: () => now },
    )(verificationReplayToken);
    assert.equal(
      completion.surveyCompleted,
      true,
      'a recorded skip suppresses the verification-page prompt on replay',
    );
  } finally {
    await fixture.dispose();
  }
});

test('an unverified subscriber cannot submit a survey', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'pending');
    const token = 'pending-survey-status-token';
    await seedStatusToken(fixture.database, subscriberId, token);
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });

    assert.equal(await capture(submission(token)), 'unverified');
    assert.equal(
      await fixture.database.readOne({
        text: 'SELECT subscriber_id FROM survey_response WHERE subscriber_id = $1',
        values: [subscriberId],
      }),
      null,
    );
  } finally {
    await fixture.dispose();
  }
});

test('resubmission replaces one response, updates the handoff field, and audits the replacement', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'verified');
    const token = 'replacement-survey-status-token';
    await seedStatusToken(fixture.database, subscriberId, token);
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });

    assert.equal(await capture(submission(token)), 'saved');
    assert.equal(
      await capture({
        ...submission(token),
        answers: {
          category_preference: ['beauty'],
          shopping_frequency: 'rarely',
        },
        requestId: 'survey-request-2',
      }),
      'saved',
    );

    const response = await fixture.database.readOne<{
      answers: unknown;
      category_preference: string[];
      version: string;
    }>({
      text: `
        SELECT r.answers, r.version, s.category_preference
        FROM survey_response r
        JOIN subscriber s ON s.id = r.subscriber_id
        WHERE r.subscriber_id = $1
      `,
      values: [subscriberId],
    });
    assert.deepEqual(response, {
      answers: {
        category_preference: ['beauty'],
        shopping_frequency: 'rarely',
      },
      category_preference: ['beauty'],
      version: currentSurveyVersion,
    });
    assert.equal(
      (
        await fixture.database.readOne<{ count: number }>({
          text: 'SELECT count(*)::integer AS count FROM survey_response WHERE subscriber_id = $1',
          values: [subscriberId],
        })
      )?.count,
      1,
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `
          SELECT actor, action, subject_id, detail, request_id
          FROM audit_log
          WHERE action = 'survey.response_replaced'
        `,
      }),
      {
        action: 'survey.response_replaced',
        actor: 'subscriber:self',
        detail: {
          currentVersion: currentSurveyVersion,
          previousVersion: currentSurveyVersion,
        },
        request_id: 'survey-request-2',
        subject_id: subscriberId,
      },
    );
  } finally {
    await fixture.dispose();
  }
});

test('survey.enabled off is graceful and writes no survey response', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'verified');
    const token = 'disabled-survey-status-token';
    await seedStatusToken(fixture.database, subscriberId, token);
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => false },
    });

    assert.equal(await capture(submission(token)), 'disabled');
    assert.equal(
      await fixture.database.readOne({
        text: 'SELECT subscriber_id FROM survey_response WHERE subscriber_id = $1',
        values: [subscriberId],
      }),
      null,
    );
  } finally {
    await fixture.dispose();
  }
});

test('invalid versions write nothing and per-subscriber attempts are bounded', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, 'verified');
    const token = 'rate-limited-survey-status-token';
    await seedStatusToken(fixture.database, subscriberId, token);
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });

    assert.equal(
      await capture({ ...submission(token), version: 'unknown-version' }),
      'invalid_input',
    );
    assert.equal(
      await fixture.database.readOne({
        text: 'SELECT subscriber_id FROM survey_response WHERE subscriber_id = $1',
        values: [subscriberId],
      }),
      null,
    );

    for (let attempt = 0; attempt < 9; attempt += 1) {
      assert.equal(await capture(submission(token)), 'saved');
    }
    assert.equal(await capture(submission(token)), 'rate_limited');
  } finally {
    await fixture.dispose();
  }
});
