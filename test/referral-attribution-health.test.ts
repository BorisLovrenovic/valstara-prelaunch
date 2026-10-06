import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { ReferralAttributionConfiguration } from '../src/server/config.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createSignupRoute } from '../src/pages/api/signup.ts';
import type { ReferralAttributionHealthRepository } from '../src/server/db/referral-attribution-health.ts';
import { createReferralCaptureService } from '../src/server/referral/capture.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';
import {
  createReferralAttributionHealth,
  runReferralAttributionCheck,
} from '../src/server/referral/attribution-health.ts';

const measuredAt = new Date('2026-10-06T12:00:00.000Z');
const configuration: ReferralAttributionConfiguration = {
  baselineDays: 7,
  cohortHours: 24,
  dropPercent: 50,
  minimumSignups: 50,
};

function fakeRepository(
  current: { signups: number; attributed: number },
  baseline: { signups: number; attributed: number },
): ReferralAttributionHealthRepository {
  return {
    async counts(from, currentFrom, until) {
      assert.equal(from.toISOString(), '2026-09-28T12:00:00.000Z');
      assert.equal(currentFrom.toISOString(), '2026-10-05T12:00:00.000Z');
      assert.equal(until.toISOString(), measuredAt.toISOString());
      return { current, baseline };
    },
  };
}

test('attribution share collapse alerts at the threshold and not just above it', async () => {
  for (const [attributed, expected] of [
    [25, 'collapsed'],
    [26, 'healthy'],
  ] as const) {
    const alerts: unknown[] = [];
    const health = createReferralAttributionHealth(
      fakeRepository(
        { signups: 50, attributed },
        { signups: 100, attributed: 100 },
      ),
      configuration,
      async () => true,
      () => measuredAt,
    );
    const result = await runReferralAttributionCheck(health, async (alert) => {
      alerts.push(alert);
    });
    assert.equal(result.state, expected);
    assert.equal(result.current?.share, attributed / 50);
    assert.equal(alerts.length, expected === 'collapsed' ? 1 : 0);
    if (expected === 'collapsed') {
      assert.deepEqual(alerts[0], {
        baselineShare: 1,
        currentShare: 0.5,
        measuredAt,
        relativeDrop: 0.5,
        severity: 'P1',
      });
    }
  }
});

test('small cohort and zero baseline do not alert', async () => {
  for (const [current, baseline] of [
    [
      { signups: 49, attributed: 0 },
      { signups: 100, attributed: 50 },
    ],
    [
      { signups: 50, attributed: 0 },
      { signups: 100, attributed: 0 },
    ],
  ] as const) {
    let alerts = 0;
    const health = createReferralAttributionHealth(
      fakeRepository(current, baseline),
      configuration,
      async () => true,
      () => measuredAt,
    );
    const result = await runReferralAttributionCheck(health, async () => {
      alerts += 1;
    });
    assert.equal(result.state, 'warming_up');
    assert.equal(alerts, 0);
  }
});

test('referral flag off skips the aggregate query and alerts and reports disabled', async () => {
  let queries = 0;
  let alerts = 0;
  const health = createReferralAttributionHealth(
    {
      async counts() {
        queries += 1;
        throw new Error('must not query');
      },
    },
    configuration,
    async () => false,
    () => measuredAt,
  );
  const result = await runReferralAttributionCheck(health, async () => {
    alerts += 1;
  });
  assert.equal(result.state, 'disabled');
  assert.equal(result.current, null);
  assert.equal(result.baseline, null);
  assert.equal(queries, 0);
  assert.equal(alerts, 0);
});

test('real database attribution health counts edge rows, not signup ref hints', async () => {
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const name = `valstara_e1005_${randomUUID().replaceAll('-', '')}`;
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
      release: 'e10-05-attribution-test',
    });
    const applicationDatabase = createPool(appUrl.toString());
    app = applicationDatabase;
    const referrer = randomUUID();
    const baselineReferred = randomUUID();
    const currentReferred = randomUUID();
    const unlinked = randomUUID();
    for (const [id, createdAt, hadRef] of [
      [referrer, '2026-09-30T12:00:00.000Z', false],
      [baselineReferred, '2026-09-30T12:00:00.000Z', true],
      [currentReferred, '2026-10-06T11:00:00.000Z', true],
      [unlinked, '2026-10-06T11:00:00.000Z', true],
    ] as const) {
      await database.execute({
        text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
          status, created_at, signup_had_ref)
          VALUES ($1, $2, $2, 'example.test', 'pending', $3, $4)`,
        values: [id, `${id}@example.test`, createdAt, hadRef],
      });
    }
    for (const referred of [baselineReferred, currentReferred]) {
      await database.execute({
        text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state,
          reward_state) VALUES ($1, $2, $3, 'attributed', 'none')`,
        values: [randomUUID(), referrer, referred],
      });
    }
    const result = await createReferralService(applicationDatabase, {
      attributionConfiguration: { ...configuration, minimumSignups: 1 },
      isReferralEnabled: async () => true,
      clock: () => measuredAt,
      milestoneEmail: async () => false,
    }).attributionHealth();
    assert.deepEqual(result.current, { signups: 2, attributed: 1, share: 0.5 });
    assert.deepEqual(result.baseline, {
      signups: 2,
      attributed: 1,
      share: 0.5,
    });
    assert.equal(result.state, 'healthy');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(referrer, 'u'));

    // The same server-side capture and route path used by ?ref= must write
    // an edge. This catches a broken handoff between signing and attribution.
    await database.execute({
      text: `UPDATE subscriber SET status = 'verified', referral_code = $2,
        verified_at = $3 WHERE id = $1`,
      values: [referrer, 'ABCDEFGHJKMN', measuredAt],
    });
    const capture = createReferralCaptureService('e10-05-capture-secret', {
      clock: () => measuredAt,
    });
    const signed = capture.signRef(
      capture.capture(new URL('https://valstara.test/?ref=ABCDEFGHJKMN')),
    );
    assert.equal(capture.verifyRef(signed)?.ref, 'ABCDEFGHJKMN');
    const signup = createSignupService(applicationDatabase, {
      clock: () => measuredAt,
      isReferralEnabled: async () => true,
      raiseFraudFlag: async () => undefined,
      screenEmailDomain: async () => ({ flags: [] }),
      sendVerificationMail: async () => undefined,
      attributeReferral: (referredId, code, allowAttribution) =>
        createReferralService(applicationDatabase, {
          milestoneEmail: async () => false,
        }).attribute(referredId, code, allowAttribution),
    });
    const route = createSignupRoute({
      isSignupEnabled: async () => true,
      verifyTurnstile: async () => 'verified',
      consumeIpRateLimit: async () => 'ok',
      signup,
      verifyReferralCapture: (value) => capture.verifyRef(value),
      flagChallengeTimeout: async () => undefined,
      ipPrefixPepper: 'e10-05-prefix-pepper',
      clock: () => measuredAt,
      monotonicClock: () => 0,
      sleep: async () => undefined,
    });
    const response = await route({
      clientAddress: '203.0.113.10',
      request: new Request('https://valstara.test/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          email: 'from-ref@example.test',
          turnstile_token: 'verified',
          referral_capture: signed,
        }),
      }),
    } as never);
    assert.equal(response.status, 200);
    const edge = await database.readOne<{ count: string }>({
      text: `SELECT COUNT(*)::text AS count FROM referral_edge e
        JOIN subscriber s ON s.id = e.referred_id
        WHERE s.email_normalised = 'from-ref@example.test'
          AND e.referrer_id = $1`,
      values: [referrer],
    });
    assert.equal(edge?.count, '1');

    await database.execute({
      text: `INSERT INTO campaign_flag (key, enabled, updated_by)
        VALUES ('referral.enabled', false, 'e10-05-test')`,
    });
    const disabled = await createReferralService(applicationDatabase, {
      clock: () => measuredAt,
      milestoneEmail: async () => false,
    }).attributionHealth();
    assert.equal(disabled.state, 'disabled');
    assert.equal(disabled.current, null);
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
