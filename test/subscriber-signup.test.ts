import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createSignupService,
  verificationSendWindowMs,
  type SignupInput,
} from '../src/server/subscriber/signup.ts';
import type { VerificationTestMail } from '../src/server/subscriber/verification-mail.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly database: DatabasePool;
  readonly applicationDatabase: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e302svc_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationDatabaseUrl = new URL(databaseUrl);
  applicationDatabaseUrl.username = 'valstara_app';
  applicationDatabaseUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e3-02-service-test',
  });
  const applicationDatabase = createPool(applicationDatabaseUrl.toString());

  return {
    database,
    applicationDatabase,
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

test('the Compose application role can complete the signup write path', async () => {
  const fixture = await createDatabaseFixture();
  const signup = createSignupService(fixture.applicationDatabase, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => new Date('2026-09-10T12:00:00.000Z'),
    async sendVerificationMail() {},
  });

  try {
    assert.equal((await signup(inputFor('role@example.test'))).kind, 'created');
    assert.equal(await rowCount(fixture.database, 'subscriber'), 1);
    assert.equal(await rowCount(fixture.database, 'verification_token'), 2);
    assert.equal(await rowCount(fixture.database, 'email_send'), 1);
    await assert.rejects(
      fixture.applicationDatabase.execute({
        text: 'UPDATE subscriber SET email = $1 WHERE email_normalised = $2',
        values: ['changed@example.test', 'role@example.test'],
      }),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '42501',
    );
  } finally {
    await fixture.dispose();
  }
});

async function rowCount(
  database: DatabasePool,
  table: string,
): Promise<number> {
  const row = await database.readOne<{ count: string }>({
    text: `SELECT count(*)::text AS count FROM ${table}`,
  });
  return Number(row?.count);
}

function inputFor(
  email: string,
  extra: Partial<SignupInput> = {},
): SignupInput {
  return {
    email,
    verificationUrl: (token) => `http://valstara.test/verify?token=${token}`,
    ...extra,
  };
}

test('a first signup creates a pending subscriber, one token, one queued email, and sends once', async () => {
  const fixture = await createDatabaseFixture();
  const sent: VerificationTestMail[] = [];
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => new Date('2026-09-06T12:00:00.000Z'),
    async sendVerificationMail(mail) {
      sent.push(mail);
    },
  });

  try {
    const outcome = await signup(inputFor('New.User@Example.test'));
    assert.equal(outcome.kind, 'created');

    const subscriber = await fixture.database.readOne<{
      email: string;
      email_normalised: string;
      status: string;
    }>({
      text: 'SELECT email, email_normalised, status FROM subscriber',
    });
    assert.equal(subscriber?.status, 'pending');
    assert.equal(subscriber?.email, 'New.User@Example.test'); // raw preserved
    assert.equal(subscriber?.email_normalised, 'new.user@example.test');

    assert.equal(await rowCount(fixture.database, 'verification_token'), 2);
    assert.equal(await rowCount(fixture.database, 'email_send'), 1);
    assert.equal(sent.length, 1);
  } finally {
    await fixture.dispose();
  }
});

test('signup persists verified UTM data and keeps utm null when it is absent', async () => {
  const fixture = await createDatabaseFixture();
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    async sendVerificationMail() {},
  });
  try {
    await signup(
      inputFor('utm@example.test', {
        utm: { campaign: 'autumn', source: 'newsletter' },
      }),
    );
    await signup(inputFor('no-utm@example.test'));
    const rows = await fixture.database.list<{
      email_normalised: string;
      utm: unknown;
    }>(
      {
        text: 'SELECT email_normalised, utm FROM subscriber ORDER BY email_normalised',
      },
      2,
    );
    assert.deepEqual(rows, [
      { email_normalised: 'no-utm@example.test', utm: null },
      {
        email_normalised: 'utm@example.test',
        utm: { campaign: 'autumn', source: 'newsletter' },
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('a repeat for a verified subscriber reports the internal already_verified outcome and sends nothing', async () => {
  const fixture = await createDatabaseFixture();
  const sent: VerificationTestMail[] = [];
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => new Date('2026-09-06T12:00:00.000Z'),
    async sendVerificationMail(mail) {
      sent.push(mail);
    },
  });

  try {
    await signup(inputFor('member@example.test'));
    await fixture.database.execute({
      text: "UPDATE subscriber SET status = 'verified', verified_at = now() WHERE email_normalised = $1",
      values: ['member@example.test'],
    });

    const outcome = await signup(inputFor('member@example.test'));
    assert.equal(outcome.kind, 'already_verified');

    // No second email was queued or sent for the verified row.
    assert.equal(await rowCount(fixture.database, 'email_send'), 1);
    assert.equal(sent.length, 1);
  } finally {
    await fixture.dispose();
  }
});

test('a pending repeat inside the send window is throttled, and after the window re-queues a fresh mail', async () => {
  const fixture = await createDatabaseFixture();
  const sent: VerificationTestMail[] = [];
  let now = new Date('2026-09-06T12:00:00.000Z');
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => now,
    async sendVerificationMail(mail) {
      sent.push(mail);
    },
  });

  try {
    assert.equal(
      (await signup(inputFor('again@example.test'))).kind,
      'created',
    );

    // Immediate repeat: same subscriber, no second mail.
    const throttled = await signup(inputFor('again@example.test'));
    assert.equal(throttled.kind, 'existing');
    assert.equal(await rowCount(fixture.database, 'subscriber'), 1);
    assert.equal(await rowCount(fixture.database, 'email_send'), 1);
    assert.equal(sent.length, 1);

    // Past the window: a genuine repeat re-queues a fresh verification mail.
    now = new Date(now.getTime() + verificationSendWindowMs + 1_000);
    const resent = await signup(inputFor('again@example.test'));
    assert.equal(resent.kind, 'existing');
    assert.equal(await rowCount(fixture.database, 'subscriber'), 1);
    assert.equal(await rowCount(fixture.database, 'verification_token'), 4);
    assert.equal(await rowCount(fixture.database, 'email_send'), 2);
    assert.equal(sent.length, 2);
  } finally {
    await fixture.dispose();
  }
});

test('a malformed email is rejected with invalid_email and writes no row', async () => {
  const fixture = await createDatabaseFixture();
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    async sendVerificationMail() {
      return undefined;
    },
  });

  try {
    const outcome = await signup(inputFor('not an email'));
    assert.equal(outcome.kind, 'invalid_email');
    assert.equal(await rowCount(fixture.database, 'subscriber'), 0);
    assert.equal(await rowCount(fixture.database, 'email_send'), 0);
  } finally {
    await fixture.dispose();
  }
});

test('a send failure never rolls back the committed subscriber, token or queued email', async () => {
  const fixture = await createDatabaseFixture();
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => new Date('2026-09-06T12:00:00.000Z'),
    async sendVerificationMail() {
      throw new Error('provider outage');
    },
  });

  try {
    // Mutating the implementation to send inside the write transaction would
    // roll these rows back and fail this test.
    const outcome = await signup(inputFor('committed@example.test'));
    assert.equal(outcome.kind, 'created');
    assert.equal(await rowCount(fixture.database, 'subscriber'), 1);
    assert.equal(await rowCount(fixture.database, 'verification_token'), 2);
    assert.equal(await rowCount(fixture.database, 'email_send'), 1);
  } finally {
    await fixture.dispose();
  }
});

test('a concurrent double-submit produces one subscriber and exactly one email, against a real database', async () => {
  const fixture = await createDatabaseFixture();
  const sent: VerificationTestMail[] = [];
  const submitted: boolean[] = [];
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => new Date('2026-09-06T12:00:00.000Z'),
    async sendVerificationMail(mail) {
      sent.push(mail);
    },
    onCreated: ({ hasValidRef }) => submitted.push(hasValidRef),
  });

  try {
    const outcomes = await Promise.all([
      signup(inputFor('race@example.test')),
      signup(inputFor('race@example.test')),
    ]);

    const kinds = outcomes.map((outcome) => outcome.kind).sort();
    assert.deepEqual(kinds, ['created', 'existing']);
    assert.equal(await rowCount(fixture.database, 'subscriber'), 1);
    assert.equal(await rowCount(fixture.database, 'email_send'), 1);
    assert.equal(sent.length, 1);
    assert.deepEqual(submitted, [false]);
  } finally {
    await fixture.dispose();
  }
});
