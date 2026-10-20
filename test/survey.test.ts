import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { verificationCopy } from '../src/copy/verification.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  currentSurveyVersion,
  surveyQuestionSets,
  validateSurveySubmission,
} from '../src/server/survey/questions.ts';
import { createSurveyService } from '../src/server/survey/service.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-22T12:00:00.000Z');
const tokenIds = new Map<string, string>();

function tokenValue(label: string): string {
  const digest = createHash('sha256').update(label).digest('hex');
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  const token = deriveEmailToken(id, process.env.EMAIL_TOKEN_SECRET!);
  tokenIds.set(token, id);
  return token;
}

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
      tokenIds.get(token)!,
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
      tokenIds.get(token)!,
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
      category_preference: ['ai', 'software'],
      shopping_frequency: 'monthly',
    },
    ipPrefixHash: 'hashed-prefix',
    token,
    version: currentSurveyVersion,
  } as const;
}

test('v2 validates every digital-goods token and keeps v1 submissions valid', () => {
  assert.equal(currentSurveyVersion, '2026-10-19');
  assert.deepEqual(
    surveyQuestionSets[currentSurveyVersion].categoryPreference,
    [
      'ai',
      'subscriptions',
      'software',
      'gift_cards',
      'game_keys',
      'game_top_ups',
      'in_game_currency',
    ],
  );
  assert.deepEqual(
    verificationCopy.survey.categoryOptions.map((option) => option.value),
    surveyQuestionSets[currentSurveyVersion].categoryPreference,
  );
  assert.deepEqual(
    verificationCopy.survey.categoryOptions.map((option) => option.label),
    [
      'AI tools',
      'Streaming and subscriptions',
      'Software',
      'Gift cards',
      'Game keys',
      'Game top-ups',
      'In-game currency',
    ],
  );
  assert.equal(
    verificationCopy.survey.frequencyLabel,
    'How often do you buy digital goods?',
  );
  for (const category of surveyQuestionSets[currentSurveyVersion]
    .categoryPreference) {
    assert.notEqual(
      validateSurveySubmission({
        answers: {
          category_preference: [category],
          shopping_frequency: 'monthly',
        },
        version: currentSurveyVersion,
      }),
      null,
    );
  }
  assert.equal(
    validateSurveySubmission({
      answers: {
        category_preference: ['apparel'],
        shopping_frequency: 'weekly',
      },
      version: currentSurveyVersion,
    }),
    null,
  );
  assert.notEqual(
    validateSurveySubmission({
      answers: {
        category_preference: ['apparel'],
        shopping_frequency: 'weekly',
      },
      version: '2026-09-08',
    }),
    null,
  );
});

test('a pre-deploy v1 page submits after v2 deploy without rewriting that response', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const earlierId = await insertSubscriber(fixture.database, 'verified');
    const earlierToken = tokenValue('predeploy-v1-page');
    await seedStatusToken(fixture.database, earlierId, earlierToken);
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
    });
    assert.equal(
      await capture({
        answers: {
          category_preference: ['apparel'],
          shopping_frequency: 'monthly',
        },
        ipPrefixHash: 'predeploy-v1-prefix',
        token: earlierToken,
        version: '2026-09-08',
      }),
      'saved',
    );
    const before = await fixture.database.readOne({
      text: `SELECT r.answers,r.version,s.category_preference
        FROM survey_response r JOIN subscriber s ON s.id=r.subscriber_id
        WHERE r.subscriber_id=$1`,
      values: [earlierId],
    });
    const currentId = await insertSubscriber(fixture.database, 'verified');
    const currentToken = tokenValue('current-v2-page');
    await seedStatusToken(fixture.database, currentId, currentToken);
    assert.equal(
      await capture({
        answers: {
          category_preference: ['ai', 'game_keys'],
          shopping_frequency: 'monthly',
        },
        ipPrefixHash: 'current-v2-prefix',
        token: currentToken,
        version: currentSurveyVersion,
      }),
      'saved',
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `SELECT r.answers,r.version,s.category_preference
          FROM survey_response r JOIN subscriber s ON s.id=r.subscriber_id
          WHERE r.subscriber_id=$1`,
        values: [earlierId],
      }),
      before,
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `SELECT r.answers,r.version,s.category_preference
          FROM survey_response r JOIN subscriber s ON s.id=r.subscriber_id
          WHERE r.subscriber_id=$1`,
        values: [currentId],
      }),
      {
        answers: {
          category_preference: ['ai', 'game_keys'],
          shopping_frequency: 'monthly',
        },
        version: currentSurveyVersion,
        category_preference: ['ai', 'game_keys'],
      },
    );
  } finally {
    await fixture.dispose();
  }
});

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
    const earlierToken = tokenValue('earlier-version-survey-status-token');
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
    const currentToken = tokenValue(
      'changed-current-version-survey-status-token',
    );
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
          category_preference: ['software'],
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
    const token = tokenValue('survey-skip-status-token');
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

    const verificationReplayToken = tokenValue(
      'survey-skip-verification-replay',
    );
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
    const token = tokenValue('pending-survey-status-token');
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
    const token = tokenValue('replacement-survey-status-token');
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
          category_preference: ['gift_cards'],
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
        category_preference: ['gift_cards'],
        shopping_frequency: 'rarely',
      },
      category_preference: ['gift_cards'],
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

test('survey completion emits once: skip, first answer, replacement, and skip then answer', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const events: string[] = [];
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => true },
      onFirstAnswer: (version) => events.push(version),
    });
    const first = await insertSubscriber(fixture.database, 'verified');
    const firstToken = tokenValue('completion-first-status-token');
    await seedStatusToken(fixture.database, first, firstToken);
    const skip = (token: string) => ({
      ...submission(token),
      answers: { category_preference: null, shopping_frequency: null },
    });

    assert.equal(await capture(skip(firstToken)), 'skipped');
    assert.deepEqual(events, []);
    assert.equal(await capture(submission(firstToken)), 'saved');
    assert.deepEqual(events, [currentSurveyVersion]);
    assert.equal(
      await capture({
        ...submission(firstToken),
        answers: {
          category_preference: ['gift_cards'],
          shopping_frequency: 'rarely',
        },
      }),
      'saved',
    );
    assert.equal(await capture(skip(firstToken)), 'skipped');
    assert.equal(await capture(submission(firstToken)), 'saved');
    assert.deepEqual(events, [currentSurveyVersion]);

    const second = await insertSubscriber(fixture.database, 'verified');
    const secondToken = tokenValue('completion-second-status-token');
    await seedStatusToken(fixture.database, second, secondToken);
    assert.equal(await capture(skip(secondToken)), 'skipped');
    assert.equal(await capture(submission(secondToken)), 'saved');
    assert.deepEqual(events, [currentSurveyVersion, currentSurveyVersion]);
    const markers = await fixture.database.list<{
      first_answered_at: Date | null;
    }>(
      {
        text: 'SELECT first_answered_at FROM survey_response WHERE subscriber_id = ANY($1::uuid[])',
        values: [[first, second]],
      },
      2,
    );
    assert.equal(
      markers.every(
        (row) => row.first_answered_at?.toISOString() === now.toISOString(),
      ),
      true,
    );
    await assert.rejects(
      fixture.database.execute({
        text: 'UPDATE survey_response SET first_answered_at = NULL WHERE subscriber_id = $1',
        values: [first],
      }),
      /write-once/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test('survey.enabled off is graceful and writes no survey response', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const events: string[] = [];
    const subscriberId = await insertSubscriber(fixture.database, 'verified');
    const token = tokenValue('disabled-survey-status-token');
    await seedStatusToken(fixture.database, subscriberId, token);
    const capture = createSurveyService(fixture.applicationDatabase, {
      clock: () => now,
      flags: { isEnabled: async () => false },
      onFirstAnswer: (version) => events.push(version),
    });

    assert.equal(await capture(submission(token)), 'disabled');
    assert.deepEqual(events, []);
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
    const token = tokenValue('rate-limited-survey-status-token');
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
