import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createAdminAuthenticator } from '../src/server/admin-auth/authenticate.ts';
import { createAdminAuthMiddleware } from '../src/server/admin-auth/middleware.ts';
import {
  createAdminHealthService,
  createAdminHealthServiceWithSources,
} from '../src/server/admin/health.ts';
import type { AppConfig } from '../src/server/config.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createHealthRoute } from '../src/pages/api/admin/health.ts';
import { generateTotp } from '../src/server/admin-auth/totp.ts';

const at = new Date('2026-10-06T12:00:00.000Z');
const credential = 'e10-05-admin-credential-at-least-32-chars';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const canary =
  '203.0.113.47 raw-secret-token ABCDEFGHJKMN 43f31509-8942-4a26-8771-91d77c4c897f';

function fixtureSources(fixedClock: () => Date) {
  assert.equal(fixedClock(), at);
  return {
    verification: async () => ({
      state: 'healthy' as const,
      measuredAt: at,
      baseline: { rate: 0.8, signups: 100, verified: 80 },
      current: { rate: 0.75, signups: 80, verified: 60 },
      providers: [
        { provider: 'gmail' as const, rate: 0.75, signups: 20, verified: 15 },
      ],
      token: canary,
    }),
    attribution: async () => ({
      state: 'healthy' as const,
      measuredAt: at,
      baseline: { share: 0.5, signups: 100, attributed: 50 },
      current: { share: 0.45, signups: 80, attributed: 36 },
      referralCode: canary,
      subscriberId: canary,
    }),
    counts: async () => ({
      latestSnapshotAt: new Date(at.getTime() - 300_000),
      queuedEmails: 12,
      openFlags: 3,
    }),
    domains: async () => [
      {
        domain: 'send.valstara.com',
        checkedAt: at,
        spf: { passed: true, reason: 'ok' as const },
        dkim: { passed: true, reason: 'ok' as const },
        dmarc: { passed: true, reason: 'ok' as const, policy: 'none' as const },
        rawIp: canary,
      },
    ],
    seedTest: async () => ({
      weekStart: new Date('2026-10-05T00:00:00.000Z'),
      checkedAt: at,
      state: 'current' as const,
      providers: [
        {
          provider: 'gmail' as const,
          placement: 'inbox' as const,
          sentAt: at,
          checkedAt: at,
          marker: canary,
        },
      ],
    }),
    quota: async () => ({
      checkedAt: at,
      providers: [
        {
          provider: 'resend' as const,
          tier: 'paid' as const,
          cap: 1_000,
          dailyConsumption: [{ day: '2026-10-05', accepted: 20 }],
          todayConsumption: 9,
          forecast: 30,
          alertState: 'none' as const,
          token: canary,
        },
      ],
    }),
    purges: async () => [
      {
        job_key: 'ip_prefix_retention' as const,
        last_started_at: at,
        last_finished_at: at,
        last_succeeded_at: at,
        last_outcome: 'succeeded' as const,
        rows_purged: 6,
        last_error_code: null,
      },
    ],
  };
}

test('health view includes every named metric and projects away IDs, secrets and raw IPs', async () => {
  const service = createAdminHealthServiceWithSources(fixtureSources, () => at);
  const health = await service.health();
  assert.deepEqual(
    Object.keys(health).sort(),
    [
      'attribution',
      'domainAuthentication',
      'emailQueue',
      'measuredAt',
      'openFlags',
      'purges',
      'quota',
      'seedTest',
      'snapshot',
      'verification',
    ].sort(),
  );
  assert.equal(health.verification.current.rate, 0.75);
  assert.equal(health.attribution.current?.share, 0.45);
  assert.equal(health.snapshot.ageSeconds, 300);
  assert.equal(health.emailQueue.queued, 12);
  assert.equal(health.domainAuthentication[0]?.dmarc.passed, true);
  assert.equal(health.seedTest.providers[0]?.placement, 'inbox');
  assert.equal(health.quota.providers[0]?.todayConsumption, 9);
  assert.equal(health.quota.providers[0]?.forecast, 30);
  assert.equal(health.openFlags, 3);
  assert.equal(health.purges.length, 4);
  assert.equal(health.purges[0]?.lastSucceededAt, at);
  assert.equal(health.purges[0]?.lastOutcome, 'succeeded');
  assert.equal(health.purges[0]?.rowsPurged, 6);
  assert.equal(health.purges[0]?.stale, false);
  assert.ok(health.purges.slice(1).every((job) => job.stale));
  assert.doesNotMatch(
    JSON.stringify(health),
    /203\.0\.113\.47|raw-secret-token|ABCDEFGHJKMN|43f31509-8942-4a26-8771-91d77c4c897f|"subscriberId"|"referralCode"|"token"|"rawIp"/u,
  );

  const route = createHealthRoute(service);
  const middleware = createAdminAuthMiddleware(
    createAdminAuthenticator({ credential, totpSecret }, () => at),
  );
  const unauthenticated = {
    locals: {},
    request: new Request('https://valstara.test/api/admin/health'),
    url: new URL('https://valstara.test/api/admin/health'),
  };
  const denied = await middleware(unauthenticated, async () =>
    route(unauthenticated as never),
  );
  assert.equal(denied.status, 401);
  const authorized = {
    locals: {},
    request: new Request('https://valstara.test/api/admin/health', {
      headers: {
        Authorization: `Bearer ${credential}`,
        'X-Valstara-TOTP': generateTotp(totpSecret, at),
      },
    }),
    url: new URL('https://valstara.test/api/admin/health'),
  };
  const response = await middleware(authorized, async () =>
    route(authorized as never),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.doesNotMatch(
    body,
    /203\.0\.113\.47|raw-secret-token|ABCDEFGHJKMN|43f31509-8942-4a26-8771-91d77c4c897f|"subscriberId"|"referralCode"|"token"|"rawIp"/u,
  );
  assert.equal(JSON.parse(body).purges.length, 4);
});

test('production health sources read the local database and show never-run purges as stale', async () => {
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const name = `valstara_health_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const database = createPool(databaseUrl.toString());
  let app: DatabasePool | undefined;
  try {
    await runMigrations(database, {
      applicationRolePassword: appUrl.password,
      release: 'e10-05-health-test',
    });
    const subscriberId = randomUUID();
    const tokenId = randomUUID();
    await database.execute({
      text: `INSERT INTO subscriber
        (id, email, email_normalised, email_domain, status, created_at)
        VALUES ($1, 'health@example.test', 'health@example.test',
          'example.test', 'pending', $2)`,
      values: [subscriberId, new Date(at.getTime() - 60 * 60 * 1_000)],
    });
    await database.execute({
      text: `INSERT INTO verification_token
        (id, subscriber_id, token_hash, purpose, expires_at)
        VALUES ($1, $2, $3, 'unsubscribe', $4)`,
      values: [
        tokenId,
        subscriberId,
        Buffer.alloc(32, 7),
        new Date(at.getTime() + 24 * 60 * 60 * 1_000),
      ],
    });
    await database.execute({
      text: `INSERT INTO email_send
        (id, subscriber_id, template, provider, business_key, state,
          payload, unsubscribe_token_id)
        VALUES ($1, $2, 'verification_test', 'resend', $3, 'queued',
          $4::jsonb, $5)`,
      values: [
        randomUUID(),
        subscriberId,
        `health:${subscriberId}`,
        JSON.stringify({ token_id: tokenId }),
        tokenId,
      ],
    });
    await database.execute({
      text: `INSERT INTO fraud_flag
        (id, subscriber_id, kind, detail, state)
        VALUES ($1, $2, 'manual', '{}'::jsonb, 'open')`,
      values: [randomUUID(), subscriberId],
    });
    await database.execute({
      text: `INSERT INTO leaderboard_snapshot (id, as_of, entries)
        VALUES ($1, $2, '[]'::jsonb)`,
      values: [randomUUID(), new Date(at.getTime() - 300_000)],
    });
    app = createPool(appUrl.toString());
    const configuration = {
      verificationRate: {
        baselineDays: 7,
        cohortHours: 24,
        collapsePercent: 50,
        minimumSignups: 50,
      },
      referralAttribution: {
        baselineDays: 7,
        cohortHours: 24,
        dropPercent: 50,
        minimumSignups: 50,
      },
      resendDomainAuthentication: {
        dkimExpectedValue: 'p=test',
        rsendCnameExpectedTarget: 'rsend.example.test',
        sendCnameExpectedTarget: 'send.example.test',
      },
      resendSendingDomain: 'send.valstara.com',
      emailQuota: {
        resend: { tier: 'free', cap: 100 },
        brevo: { tier: 'free', cap: 300 },
      },
    } as AppConfig;
    const health = await createAdminHealthService(
      app,
      configuration,
      () => at,
      async (clock) => [
        {
          domain: 'send.valstara.com',
          checkedAt: clock(),
          spf: { passed: true, reason: 'ok' },
          dkim: { passed: true, reason: 'ok' },
          dmarc: { passed: true, reason: 'ok', policy: 'none' },
        },
      ],
    ).health();
    assert.equal(health.verification.state, 'warming_up');
    assert.equal(health.attribution.state, 'warming_up');
    assert.equal(health.snapshot.ageSeconds, 300);
    assert.equal(health.emailQueue.queued, 1);
    assert.equal(health.seedTest.state, 'not_run');
    assert.equal(health.quota.providers.length, 2);
    assert.equal(health.purges.length, 4);
    assert.ok(health.purges.every((job) => job.stale));
    assert.equal(health.openFlags, 1);
  } finally {
    await app?.close();
    await database.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [name],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${name}"` });
    await admin.close();
  }
});
