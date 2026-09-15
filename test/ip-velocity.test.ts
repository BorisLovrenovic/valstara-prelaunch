import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createSignupRoute, hashIpPrefix } from '../src/pages/api/signup.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import {
  createIpPrefixRetentionJob,
} from '../src/server/fraud/retention.ts';
import {
  createMaintenanceFailureReporter,
  createVerificationMaintenanceScheduler,
} from '../src/server/subscriber/maintenance.ts';
import type {
  SignupInput,
  SignupOutcome,
} from '../src/server/subscriber/signup.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

function request(): Request {
  return new Request('http://valstara.test/api/signup', {
    body: new URLSearchParams({
      country: 'GB',
      email: 'person@example.test',
      turnstile_token: 'valid-token',
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
}

test('E5-03 truncates an IP prefix before hashing it', () => {
  const pepper = 'ip-velocity-test-pepper';
  const hash = hashIpPrefix('198.51.100.42', pepper);

  assert.deepEqual(
    hash,
    createHmac('sha256', pepper).update('198.51.100.0/24').digest(),
  );
  assert.notDeepEqual(
    hash,
    createHmac('sha256', pepper).update('198.51.100.42').digest(),
  );
  assert.equal(
    hashIpPrefix('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd', pepper)?.toString(
      'hex',
    ),
    hashIpPrefix('2001:db8:1234:5678:1111:2222:3333:4444', pepper)?.toString(
      'hex',
    ),
  );
});

test('E5-03 keeps a full address out of downstream outputs and logs', async () => {
  const fullAddress = '198.51.100.42';
  const rateLimitKeys: string[] = [];
  const signupInputs: SignupInput[] = [];
  const logLines: string[] = [];
  const consoleMethods = ['debug', 'error', 'info', 'log', 'warn'] as const;
  const originalConsole = consoleMethods.map((method) => console[method]);

  for (const method of consoleMethods) {
    console[method] = (...values: unknown[]) => {
      logLines.push(values.map(String).join(' '));
    };
  }

  try {
    const route = createSignupRoute({
      consumeIpRateLimit: async (prefixHash) => {
        rateLimitKeys.push(prefixHash);
        return 'ok';
      },
      flagChallengeTimeout: async () => undefined,
      ipPrefixPepper: 'ip-velocity-test-pepper',
      isSignupEnabled: async () => true,
      monotonicClock: () => 500,
      signup: async (input): Promise<SignupOutcome> => {
        signupInputs.push(input);
        return {
          kind: 'created',
          subscriber: { created: true, id: 'subscriber-id', status: 'pending' },
        };
      },
      sleep: async () => undefined,
      verifyTurnstile: async () => 'verified',
    });
    const response = await route({
      clientAddress: fullAddress,
      request: request(),
    } as never);
    const outputs = JSON.stringify({
      body: await response.json(),
      rateLimitKeys,
      signupInputs: signupInputs.map((input) => ({
        signupIpPrefixHash: input.signupIpPrefixHash?.toString('hex'),
      })),
    });

    assert.equal(response.status, 200);
    assert.doesNotMatch(
      outputs,
      new RegExp(fullAddress.replaceAll('.', '\\.'), 'u'),
    );
    assert.ok(logLines.every((line) => !line.includes(fullAddress)));
    assert.equal(
      rateLimitKeys[0],
      hashIpPrefix(fullAddress, 'ip-velocity-test-pepper')?.toString('hex'),
    );
  } finally {
    for (const [index, method] of consoleMethods.entries()) {
      console[method] = originalConsole[index] as typeof console.log;
    }
  }

  const routeSource = readFileSync(
    new URL('../src/pages/api/signup.ts', import.meta.url),
    'utf8',
  );
  const fraudServiceSource = readFileSync(
    new URL('../src/server/fraud/service.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(routeSource, /getFraudService\(\)\.hashIpPrefix/u);
  assert.doesNotMatch(fraudServiceSource, /\b(?:clientAddress|ipAddress)\b/u);
});

test('E5-03 purges only hashes past 90 days and honours the batch limit', async () => {
  const databaseName = `valstara_ip_velocity_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const applicationUrl = new URL(ownerUrl);
  applicationUrl.username = 'valstara_app';
  applicationUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword,
    release: 'qa-ip-velocity-retention-test',
  });
  const application = createPool(applicationUrl.toString());
  const now = new Date('2026-09-15T12:00:00.000Z');

  try {
    const expiredAt = new Date(
      now.getTime() - (90 * 24 + 1) * 60 * 60 * 1_000,
    );
    const retainedAt = new Date(
      now.getTime() - (90 * 24 - 1) * 60 * 60 * 1_000,
    );
    await owner.execute({
      text: `
        INSERT INTO subscriber (
          id, email, email_normalised, email_domain, status, country,
          signup_ip_prefix_hash, created_at
        )
        VALUES
          ($1, 'expired-a@example.test', 'expired-a@example.test', 'example.test', 'pending', 'GB', decode('aa', 'hex'), $4),
          ($2, 'expired-b@example.test', 'expired-b@example.test', 'example.test', 'pending', 'GB', decode('bb', 'hex'), $4),
          ($3, 'retained@example.test', 'retained@example.test', 'example.test', 'pending', 'GB', decode('cc', 'hex'), $5)
      `,
      values: [randomUUID(), randomUUID(), randomUUID(), expiredAt, retainedAt],
    });

    const job = createIpPrefixRetentionJob(application, { clock: () => now });
    assert.equal(await job.run(1), 1);
    assert.equal(await job.run(1), 1);
    assert.equal(await job.run(1), 0);
    await assert.rejects(job.run(0), /must be positive/u);

    const rows = await owner.list<{
      readonly email: string;
      readonly prefix_hash: string | null;
    }>(
      {
        text: `
          SELECT email, encode(signup_ip_prefix_hash, 'hex') AS prefix_hash
          FROM subscriber
          ORDER BY email
        `,
      },
      10,
    );
    assert.deepEqual(rows, [
      { email: 'expired-a@example.test', prefix_hash: null },
      { email: 'expired-b@example.test', prefix_hash: null },
      { email: 'retained@example.test', prefix_hash: 'cc' },
    ]);
  } finally {
    await application.close();
    await owner.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [databaseName],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${databaseName}"` });
    await admin.close();
  }
});

test('E5-03 raises a P1 compliance alert when the IP-prefix purge fails', async () => {
  const occurredAt = new Date('2026-09-15T12:00:00.000Z');
  const alerts: unknown[] = [];
  const reportFailure = createMaintenanceFailureReporter(
    {
      async send(alert) {
        alerts.push(alert);
      },
    },
    { clock: () => occurredAt },
  );
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: { async run() {} },
      ipPrefixRetention: {
        async run() {
          throw new Error('database unavailable');
        },
      },
      rateLimitRetention: { async run() {} },
      referralCounterRepair: { async run() {} },
      reminder: { async run() {} },
      strandedReferral: { async run() {} },
      verificationRate: { async run() {} },
      verificationTokenRetention: { async run() {} },
    },
    { clock: () => occurredAt, reportFailure },
  );

  await scheduler.runCycle();

  assert.deepEqual(alerts, [
    {
      detail: { job: 'ip_prefix_retention' },
      event: 'verification_maintenance_failed',
      occurredAt,
      severity: 'P1',
    },
  ]);
});
