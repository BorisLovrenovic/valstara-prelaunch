import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createFraudService,
  mxCacheTtlMs,
  mxLookupTimeoutMs,
} from '../src/server/fraud/service.ts';
import { disposableDomainCount } from '../src/server/fraud/blocklist.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly applicationDatabaseUrl: string;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

const execFileAsync = promisify(execFile);

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e501_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e5-01-test',
  });

  return {
    applicationDatabase: createPool(applicationUrl.toString()),
    applicationDatabaseUrl: applicationUrl.toString(),
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

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '42501'
  );
}

function isCheckViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23514'
  );
}

test('the boot-loaded dataset matches its pinned, checksummed snapshot', async () => {
  const dataset = await readFile(
    new URL(
      '../src/server/fraud/disposable-email-domains.json',
      import.meta.url,
    ),
  );
  assert.equal(disposableDomainCount, 8_833);
  assert.equal(
    createHash('sha256').update(dataset).digest('hex'),
    '720bd01d4fd6fa0ea72269e963974cdfe653548bf2695fea365649975c33f091',
  );
});

test('a blocklist hit rejects before an MX lookup', async () => {
  const fixture = await createDatabaseFixture();
  let resolverCalls = 0;
  try {
    const fraud = createFraudService(fixture.applicationDatabase, {
      async mxResolver() {
        resolverCalls += 1;
        return [{}];
      },
    });
    assert.deepEqual(await fraud.screen({ domain: '10minutemail.com' }), {
      flags: [],
      reject: 'blocked_domain',
    });
    assert.equal(resolverCalls, 0);
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('an address with no MX record is rejected as invalid_email', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const fraud = createFraudService(fixture.applicationDatabase, {
      mxResolver: async () => [],
    });
    assert.deepEqual(await fraud.screen({ domain: 'no-mail.example' }), {
      flags: [],
      reject: 'invalid_email',
    });
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('an MX timeout is bounded, cached per domain, and accepts with a review flag', async () => {
  const fixture = await createDatabaseFixture();
  let now = new Date('2026-09-14T12:00:00.000Z');
  let resolverCalls = 0;
  const timeoutBounds: number[] = [];
  try {
    const fraud = createFraudService(fixture.applicationDatabase, {
      clock: () => now,
      async mxResolver() {
        resolverCalls += 1;
        return [{}];
      },
      async withTimeout<Result>(
        _operation: Promise<Result>,
        milliseconds: number,
      ) {
        timeoutBounds.push(milliseconds);
        return 'timeout' as Result | 'timeout';
      },
    });

    const expected = { flags: ['no_mx'] } as const;
    assert.deepEqual(await fraud.screen({ domain: 'slow.example' }), expected);
    assert.deepEqual(await fraud.screen({ domain: 'slow.example' }), expected);
    assert.equal(resolverCalls, 1);
    assert.deepEqual(timeoutBounds, [mxLookupTimeoutMs]);

    now = new Date(now.getTime() + mxCacheTtlMs + 1);
    assert.deepEqual(await fraud.screen({ domain: 'slow.example' }), expected);
    assert.equal(resolverCalls, 2);
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('the MX cache evicts entries at its configured bound', async () => {
  const fixture = await createDatabaseFixture();
  let resolverCalls = 0;
  try {
    const fraud = createFraudService(fixture.applicationDatabase, {
      cacheMaximumEntries: 1,
      async mxResolver() {
        resolverCalls += 1;
        return [{}];
      },
    });
    await fraud.screen({ domain: 'first.example' });
    await fraud.screen({ domain: 'second.example' });
    await fraud.screen({ domain: 'first.example' });
    assert.equal(resolverCalls, 3);
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('an operator allow override beats the dataset and records its actor atomically', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const fraud = createFraudService(fixture.applicationDatabase, {
      mxResolver: async () => [{}],
    });
    await fraud.allowDomain('  10MinuteMail.COM  ', 'operator-17');

    assert.deepEqual(await fraud.screen({ domain: '10minutemail.com' }), {
      flags: [],
    });
    assert.deepEqual(
      await fixture.database.readOne<{
        readonly allowed_by: string;
        readonly domain: string;
      }>({
        text: 'SELECT domain, allowed_by FROM domain_allow WHERE domain = $1',
        values: ['10minutemail.com'],
      }),
      { allowed_by: 'operator-17', domain: '10minutemail.com' },
    );
    assert.deepEqual(
      await fixture.database.readOne<{
        readonly action: string;
        readonly actor: string;
        readonly subject_id: string;
      }>({
        text: `
          SELECT action, actor, subject_id
          FROM audit_log
          WHERE action = 'fraud.domain_allowed'
        `,
      }),
      {
        action: 'fraud.domain_allowed',
        actor: 'operator-17',
        subject_id: '10minutemail.com',
      },
    );
    await assert.rejects(
      fraud.allowDomain('mailinator.com', '  '),
      /actor is required/u,
    );
    await assert.rejects(
      fixture.applicationDatabase.execute({
        text: "UPDATE domain_allow SET allowed_by = 'other-actor' WHERE domain = '10minutemail.com'",
      }),
      isPermissionError,
    );
    await assert.rejects(
      fixture.applicationDatabase.execute({
        text: "DELETE FROM domain_allow WHERE domain = '10minutemail.com'",
      }),
      isPermissionError,
    );
    await assert.rejects(
      fixture.database.execute({
        text: "INSERT INTO domain_allow (domain, allowed_by) VALUES ('bad..example', 'operator-17')",
      }),
      isCheckViolation,
    );
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('an audit failure rolls back the allow override', async () => {
  const fixture = await createDatabaseFixture();
  try {
    await fixture.database.execute({
      text: 'REVOKE INSERT ON TABLE audit_log FROM valstara_app',
    });
    const fraud = createFraudService(fixture.applicationDatabase);
    await assert.rejects(
      fraud.allowDomain('mailinator.com', 'operator-18'),
      isPermissionError,
    );
    assert.equal(
      await fixture.database.readOne({
        text: "SELECT domain FROM domain_allow WHERE domain = 'mailinator.com'",
      }),
      null,
    );
  } finally {
    await fixture.database.execute({
      text: 'GRANT INSERT ON TABLE audit_log TO valstara_app',
    });
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('the operator CLI invokes the audited allow-domain service', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const result = await execFileAsync(
      process.execPath,
      ['scripts/allow-domain.ts', 'mailinator.com', 'cli-operator'],
      {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          DATABASE_URL: fixture.applicationDatabaseUrl,
        },
      },
    );
    assert.equal(result.stdout, 'Allowed mailinator.com.\n');
    assert.deepEqual(
      await fixture.database.readOne<{
        readonly actor: string;
        readonly domain: string;
      }>({
        text: `
          SELECT d.domain, a.actor
          FROM domain_allow d
          JOIN audit_log a ON a.subject_id = d.domain
          WHERE d.domain = 'mailinator.com'
            AND a.action = 'fraud.domain_allowed'
        `,
      }),
      { actor: 'cli-operator', domain: 'mailinator.com' },
    );
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('the timeout path completes signup and persists a no_mx review flag', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const fraud = createFraudService(fixture.applicationDatabase, {
      mxResolver: async () => [{}],
      async withTimeout<Result>() {
        return 'timeout' as Result | 'timeout';
      },
    });
    const signup = createSignupService(fixture.applicationDatabase, {
      raiseFraudFlag: (subscriberId, kind, detail) =>
        fraud.raise(subscriberId, kind, detail),
      screenEmailDomain: (domain) => fraud.screen({ domain }),
      sendVerificationMail: async () => undefined,
    });

    const outcome = await signup({
      country: 'GB',
      email: 'person@slow.example',
      verificationUrl: (token) => `https://valstara.test/verify?token=${token}`,
    });
    assert.equal(outcome.kind, 'created');
    assert.deepEqual(
      await fixture.database.readOne<{
        readonly kind: string;
        readonly reason: string;
        readonly status: string;
      }>({
        text: `
          SELECT f.kind, f.detail->>'reason' AS reason, s.status
          FROM fraud_flag f
          JOIN subscriber s ON s.id = f.subscriber_id
        `,
      }),
      { kind: 'no_mx', reason: 'mx_lookup_timeout', status: 'pending' },
    );
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});
