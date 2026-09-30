import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import {
  createEmailQuotaService,
  quotaForecast,
} from '../src/server/email/quota.ts';
import { createEmailService } from '../src/server/email/service.ts';
import type { AlertTransport } from '../src/server/verification-rate/p1-webhook.ts';

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const fixedNow = new Date('2026-09-30T12:00:00.000Z');

test('E8-09 forecasts the busiest day plus seven positive slope days', () => {
  assert.equal(quotaForecast([0, 0, 0, 0, 0, 0, 0]), 0);
  assert.equal(quotaForecast([10, 20, 30, 40, 50, 60, 70]), 140);
  assert.equal(quotaForecast([70, 60, 50, 40, 30, 20, 10]), 70);
  assert.equal(quotaForecast([0, 0, 200, 0, 0, 0, 0]), 200);
  assert.equal(quotaForecast([0, 0, 0, 0, 0, 0, 0], 450), 450);
  assert.throws(() => quotaForecast([1, 2]), /seven/u);
});

test('E8-09 counts accepted sends and seeds, exports health, and deduplicates alerts', async () => {
  const name = `valstara_e809_${randomUUID().replaceAll('-', '')}`;
  const root = createPool(adminUrl);
  await root.execute({ text: `CREATE DATABASE "${name}"` });
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const owner = createPool(ownerUrl.toString());
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  let app: ReturnType<typeof createPool> | undefined;
  try {
    await runMigrations(owner, {
      applicationRolePassword: appPassword,
      release: 'e8-09-test',
    });
    app = createPool(appUrl.toString());
    const subscriberId = randomUUID();
    await owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
        status, marketing_consent_at, marketing_consent_version, marketing_consent_source) VALUES
        ($1, 'quota@example.test', 'quota@example.test', 'example.test', 'verified', $2, 'test', 'signup')`,
      values: [subscriberId, fixedNow],
    });
    const day = new Date('2026-09-29T23:59:59.000Z');
    await owner.execute({
      text: `INSERT INTO email_send (id, subscriber_id, template, provider,
        business_key, state, accepted_at, updated_at, provider_message_id) VALUES
        ($1, $2, 'verification', 'resend', 'accepted-resend', 'delivered', $3, $4, 'resend-id'),
        ($5, $2, 'verification', 'resend', 'unaccepted-resend', 'failed', NULL, $4, NULL),
        ($6, $2, 'weekly', 'brevo', 'accepted-brevo', 'sent', $3, $4, 'brevo-id')`,
      values: [
        randomUUID(),
        subscriberId,
        day,
        fixedNow,
        randomUUID(),
        randomUUID(),
      ],
    });
    await owner.execute({
      text: `INSERT INTO email_seed_test (week_start, provider, marker, sent_at)
        VALUES ('2026-09-28', 'gmail', $1, $2)`,
      values: [randomUUID(), day],
    });
    await owner.execute({
      text: `INSERT INTO email_broadcast_seed_test (week_start, provider, marker, sent_at)
        VALUES ('2026-09-28', 'gmail', $1, $2)`,
      values: [randomUUID(), day],
    });
    await assert.rejects(
      owner.execute({
        text: `UPDATE email_send SET accepted_at = $1
          WHERE business_key = 'accepted-resend'`,
        values: [fixedNow],
      }),
      /write-once/u,
    );
    const sentAlerts: { severity: string; provider: unknown }[] = [];
    const alerts: AlertTransport = {
      async send(alert) {
        sentAlerts.push({
          severity: alert.severity,
          provider: alert.detail.provider,
        });
      },
    };
    const configuration = {
      resend: { tier: 'paid' as const, cap: 2 },
      brevo: { tier: 'paid' as const, cap: 4 },
    };
    const quota = createEmailQuotaService(
      app,
      configuration,
      alerts,
      () => fixedNow,
    );
    const result = await quota.run();
    const email = createEmailService(app, {
      clock: () => fixedNow,
      tokenSecret: 'fixture-only-token-secret',
      baseUrl: 'https://valstara.example',
      providers: new Map(),
      renderers: new Map(),
      isBroadcastEnabled: async () => false,
      operatorTask: async () => {},
      quotaConfiguration: configuration,
    });
    assert.deepEqual(await email.quotaProjection(), result);
    assert.equal(result.checkedAt.toISOString(), fixedNow.toISOString());
    const resend = result.providers.find(
      (entry) => entry.provider === 'resend',
    )!;
    const brevo = result.providers.find((entry) => entry.provider === 'brevo')!;
    assert.equal(resend.dailyConsumption.length, 7);
    assert.equal(resend.dailyConsumption.at(-1)?.accepted, 2);
    assert.equal(resend.todayConsumption, 0);
    assert.equal(resend.forecast, 3.5);
    assert.equal(resend.alertState, 'P1');
    assert.equal(brevo.dailyConsumption.at(-1)?.accepted, 2);
    assert.equal(brevo.forecast, 3.5);
    assert.equal(brevo.alertState, 'none');
    await quota.run();
    assert.deepEqual(sentAlerts, [{ severity: 'P1', provider: 'resend' }]);
    for (let index = 0; index < 3; index += 1) {
      const id = randomUUID();
      await owner.execute({
        text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
          status, marketing_consent_at, marketing_consent_version, marketing_consent_source)
          VALUES ($1, $2, $2, 'example.test', 'verified', $3, 'test', 'signup')`,
        values: [id, `quota-${index}@example.test`, fixedNow],
      });
    }
    const projected = createEmailQuotaService(
      app,
      {
        resend: { tier: 'paid', cap: 3 },
        brevo: { tier: 'paid', cap: 5 },
      },
      alerts,
      () => fixedNow,
    );
    const [projectedResult] = await Promise.all([
      projected.run(),
      projected.run(),
    ]);
    assert.equal(projectedResult.providers[0]?.alertState, 'P2');
    assert.equal(projectedResult.providers[1]?.forecast, 4);
    assert.deepEqual(sentAlerts, [
      { severity: 'P1', provider: 'resend' },
      { severity: 'P2', provider: 'resend' },
    ]);
    const override = createEmailQuotaService(
      app,
      {
        resend: { tier: 'paid', cap: 4 },
        brevo: { tier: 'paid', cap: 4 },
      },
      alerts,
      () => fixedNow,
    );
    const changed = await override.run();
    assert.equal(changed.providers[0]?.alertState, 'none');
    assert.equal(changed.providers[1]?.alertState, 'P2');
    assert.deepEqual(sentAlerts, [
      { severity: 'P1', provider: 'resend' },
      { severity: 'P2', provider: 'resend' },
      { severity: 'P2', provider: 'brevo' },
    ]);
  } finally {
    await app?.close();
    await owner.close();
    await root.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [name],
      },
      10,
    );
    await root.execute({ text: `DROP DATABASE "${name}"` });
    await root.close();
  }
});
