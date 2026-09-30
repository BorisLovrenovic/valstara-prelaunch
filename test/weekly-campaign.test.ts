import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createLeaderboardRoute } from '../src/pages/api/leaderboard.ts';
import { createLeaderboardSnapshotRepository } from '../src/server/db/leaderboard-snapshot.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createEmailService } from '../src/server/email/service.ts';
import {
  createWeeklyCampaignJob,
  weeklyWindow,
  type WeeklyCampaignDependencies,
} from '../src/server/email/weekly-campaign.ts';
import { createWeeklyTemplate } from '../src/server/email/weekly-template.ts';
import {
  createPersistedSnapshotCache,
  createSharedLeaderboardSnapshotStore,
} from '../src/server/leaderboard/persisted.ts';

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const secret = 'weekly-campaign-test-secret-32-characters';
const schedule = { isoWeekday: 2, hour: 9, minute: 0 };

test('E8-07 computes ISO UTC windows at the configured boundary', () => {
  const before = weeklyWindow(new Date('2026-10-06T08:59:59.999Z'), schedule);
  assert.equal(before.isoWeek, '2026-W41');
  assert.equal(before.startsAt.toISOString(), '2026-10-06T09:00:00.000Z');
  assert.equal(before.endsAt.toISOString(), '2026-10-07T09:00:00.000Z');
  assert.equal(
    weeklyWindow(new Date('2027-01-01T12:00:00Z'), schedule).isoWeek,
    '2026-W53',
  );
});

test('E8-07 shares one persisted snapshot and queues only the eligible weekly audience', async () => {
  const name = `valstara_e807_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(adminUrl);
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const owner = createPool(ownerUrl.toString());
  let app: ReturnType<typeof createPool> | undefined;
  try {
    await runMigrations(owner, {
      applicationRolePassword: appPassword,
      release: 'e8-07-test',
    });
    app = createPool(appUrl.toString());
    const eligible = randomUUID();
    const eligible2 = randomUUID();
    const pending = randomUUID();
    const noConsent = randomUUID();
    const suppressed = randomUUID();
    for (const [id, status, consent] of [
      [eligible, 'verified', true],
      [eligible2, 'verified', true],
      [pending, 'pending', false],
      [noConsent, 'verified', false],
      [suppressed, 'verified', true],
    ] as const) {
      const email = `${id}@example.test`;
      await owner.execute({
        text: `INSERT INTO subscriber
          (id, email, email_normalised, email_domain, status, verified_at,
           marketing_consent_at, marketing_consent_version, marketing_consent_source)
          VALUES ($1, $2, $2, 'example.test', $3, $4, $5, $6, $7)`,
        values: [
          id,
          email,
          status,
          status === 'verified' ? new Date('2026-09-30T00:00:00Z') : null,
          consent ? new Date('2026-09-30T00:00:00Z') : null,
          consent ? 'v1' : null,
          consent ? 'signup' : null,
        ],
      });
    }
    await owner.execute({
      text: `INSERT INTO suppression (email_normalised, reason, source)
        VALUES ($1, 'manual', 'test')`,
      values: [`${suppressed}@example.test`],
    });

    let now = new Date('2026-10-06T08:59:59Z');
    const clock = () => now;
    let sourceCount = 7;
    const store = createSharedLeaderboardSnapshotStore(
      app,
      {
        async leaderboardCandidates() {
          return [
            {
              subscriberId: eligible,
              rank: 1,
              confirmedReferrals: sourceCount,
            },
          ];
        },
      },
      clock,
    );
    const snapshot = await store.refresh();
    const stored = await createLeaderboardSnapshotRepository(app).byId(
      snapshot.id,
    );
    assert.deepEqual(Object.keys(stored?.entries[0] ?? {}).sort(), [
      'confirmed_referrals',
      'display_handle',
      'rank',
    ]);
    assert.doesNotMatch(
      JSON.stringify(stored),
      /example\.test|referral_code|verified_at|subscriber_id/u,
    );
    await assert.rejects(
      owner.execute({
        text: 'INSERT INTO leaderboard_snapshot (id, as_of, entries) VALUES ($1, $2, $3::jsonb)',
        values: [
          randomUUID(),
          now,
          JSON.stringify([
            {
              rank: 1,
              display_handle: 'BQBao_sEnxqw',
              confirmed_referrals: 7,
              email: 'leak@example.test',
            },
          ]),
        ],
      }),
    );

    let failLoad = false;
    const cache = createPersistedSnapshotCache(
      () =>
        failLoad
          ? Promise.reject(new Error('refresh stopped'))
          : store.forSite('2026-W41'),
      (id) => store.publishServed(id),
    );
    await cache.refresh();
    const route = createLeaderboardRoute({
      flags: { isEnabled: async () => true },
      snapshot: cache,
    });
    const response = await route({} as Parameters<typeof route>[0]);
    const page = (await response.json()) as {
      snapshot_id: string;
      entries: { confirmed_referrals: number }[];
    };
    assert.equal(page.snapshot_id, snapshot.id);
    assert.equal(page.entries[0]?.confirmed_referrals, 7);
    sourceCount = 8;
    const aheadOfSite = await store.refresh();
    assert.notEqual(aheadOfSite.id, cache.read()?.id);

    const renderer = createWeeklyTemplate({
      baseUrl: 'https://valstara.com',
      sendingDomain: 'mail.valstara.com',
      snapshotById: (id) => store.byId(id),
    });
    const render = () =>
      renderer.render({
        email: 'reader@example.test',
        payload: {
          snapshot_id: page.snapshot_id,
          status_token_id: randomUUID(),
        },
        token: async () => 'status-token',
        unsubscribePageUrl: 'https://valstara.com/unsubscribe?t=bound-token',
      });
    const message = await render();
    assert.match(message.text, /7 confirmed referrals/u);
    assert.match(message.html ?? '', /7 confirmed referrals/u);
    assert.match(message.text, /unsubscribe\?t=bound-token/u);
    assert.match(message.text, /\/me\?t=status-token/u);
    failLoad = true;
    await assert.rejects(cache.refresh(), /refresh stopped/u);
    assert.deepEqual(await render(), message);
    assert.equal(cache.read()?.id, snapshot.id);
    const offRoute = createLeaderboardRoute({
      flags: { isEnabled: async () => false },
      snapshot: cache,
    });
    assert.equal(
      (await offRoute({} as Parameters<typeof offRoute>[0])).status,
      503,
    );
    assert.match((await render()).text, /7 confirmed referrals/u);

    const email = createEmailService(app, {
      clock,
      tokenSecret: secret,
      baseUrl: 'https://valstara.com',
      providers: new Map(),
      renderers: new Map(),
      isBroadcastEnabled: async () => false,
      operatorTask: async () => undefined,
    });
    let enabled = false;
    const alerts: { severity: string; event: string }[] = [];
    let calls = 0;
    let failSecond = true;
    const jobDependencies: WeeklyCampaignDependencies = {
      database: app,
      flags: { isEnabled: async () => enabled },
      snapshot: store,
      email: {
        queue: async (input, connection) => {
          calls += 1;
          if (failSecond && calls === 2) throw new Error('partial failure');
          return email.queue(input, connection);
        },
      },
      alerts: {
        send: async (alert) => {
          alerts.push(alert);
        },
      },
      clock,
      tokenSecret: secret,
      schedule,
    };
    const job = createWeeklyCampaignJob(jobDependencies);
    assert.equal((await job.run()).state, 'paused');
    enabled = true;
    assert.equal((await job.run()).state, 'early');
    assert.equal(
      (
        await owner.readOne<{ count: string }>({
          text: 'SELECT COUNT(*)::text AS count FROM email_send',
        })
      )?.count,
      '0',
    );
    now = new Date('2026-10-06T09:00:00Z');
    failLoad = false;
    await cache.refresh();
    failLoad = true;
    assert.equal(cache.read()?.id, snapshot.id);
    await assert.rejects(job.run(1), /partial failure/u);
    assert.equal(
      (
        await owner.readOne<{ count: string }>({
          text: 'SELECT COUNT(*)::text AS count FROM email_send',
        })
      )?.count,
      '1',
    );
    failSecond = false;
    assert.equal((await job.run(1)).state, 'completed');
    assert.equal((await job.run(1)).queued, 0);
    const queued = await owner.list<{
      subscriber_id: string;
      business_key: string;
      payload: { snapshot_id: string };
      expires_at: Date;
    }>(
      {
        text: `SELECT subscriber_id, business_key, payload, expires_at
        FROM email_send ORDER BY subscriber_id`,
      },
      10,
    );
    assert.deepEqual(
      queued.map((row) => row.subscriber_id).sort(),
      [eligible, eligible2].sort(),
    );
    assert.ok(
      queued.every(
        (row) =>
          row.business_key === `weekly:2026-W41:${row.subscriber_id}` &&
          row.expires_at.toISOString() === '2026-10-07T09:00:00.000Z',
      ),
    );
    assert.equal(
      queued[0]?.payload.snapshot_id,
      cache.read()?.id,
      'the queued ID must match the lagging site cache, not the newest row',
    );
    failLoad = false;
    await cache.refresh();
    failLoad = true;
    assert.equal(cache.read()?.id, queued[0]?.payload.snapshot_id);
    await assert.rejects(
      app.execute({
        text: 'UPDATE weekly_campaign_run SET snapshot_id = $2 WHERE iso_week = $1',
        values: ['2026-W41', randomUUID()],
      }),
    );
    await assert.rejects(
      owner.execute({
        text: `INSERT INTO weekly_campaign_run (iso_week, state, recorded_at)
        VALUES ('2026-W40', 'started', $1)`,
        values: [now],
      }),
    );
    now = new Date('2026-10-07T09:00:00Z');
    assert.equal((await job.run()).state, 'skipped');
    assert.deepEqual(
      alerts.map(({ severity, event }) => [severity, event]),
      [['P2', 'weekly_campaign_window_missed']],
    );
    assert.equal((await job.run()).state, 'skipped');
    assert.equal(alerts.length, 1);
    const expired = await email.dispatch(10);
    assert.equal(expired.sent, 0);
    assert.equal(expired.failed, 2);
    const failed = await owner.readOne<{ count: string }>({
      text: `SELECT COUNT(*)::text AS count FROM email_send
        WHERE template = 'weekly_campaign_update' AND state = 'failed'
          AND last_error = 'send_window_expired'`,
    });
    assert.equal(failed?.count, '2');

    now = new Date('2026-10-14T10:00:00Z');
    assert.equal((await job.run()).state, 'skipped');
    assert.deepEqual(
      alerts.map(({ severity }) => severity),
      ['P2', 'P2'],
    );
    const missed = await owner.readOne<{
      state: string;
      alerted_at: Date | null;
    }>({
      text: 'SELECT state, alerted_at FROM weekly_campaign_run WHERE iso_week = $1',
      values: ['2026-W42'],
    });
    assert.equal(missed?.state, 'skipped');
    assert.notEqual(missed?.alerted_at, null);

    now = new Date('2026-10-20T09:00:00Z');
    assert.equal((await job.run()).state, 'completed');
    await owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at = NULL,
        marketing_consent_version = NULL, marketing_consent_source = NULL
        WHERE id = $1`,
      values: [eligible2],
    });
    const deliveries: string[] = [];
    const sending = createEmailService(app, {
      clock,
      tokenSecret: secret,
      baseUrl: 'https://valstara.com',
      providers: new Map([
        [
          'brevo',
          {
            id: 'brevo',
            sendingDomain: 'mail.valstara.com',
            capabilities: {
              broadcast: true,
              contactSync: true,
              dailyFreeCap: 300,
            },
            async send({ message, headers }) {
              deliveries.push(message.to);
              assert.match(message.text, /7 confirmed referrals/u);
              assert.match(message.html ?? '', /7 confirmed referrals/u);
              assert.match(
                headers['List-Unsubscribe'] ?? '',
                /\/api\/unsubscribe\?token=/u,
              );
              return { providerMessageId: randomUUID() };
            },
          },
        ],
      ]),
      renderers: new Map([['weekly_campaign_update', renderer]]),
      isBroadcastEnabled: async () => true,
      operatorTask: async () => undefined,
    });
    const dispatched = await sending.dispatch(10);
    assert.equal(dispatched.sent, 1);
    assert.equal(dispatched.suppressed, 1);
    assert.deepEqual(deliveries, [`${eligible}@example.test`]);

    sourceCount = 9;
    now = new Date('2026-10-20T09:01:00Z');
    const newer = await store.refresh();
    assert.notEqual(newer.id, snapshot.id);
    assert.equal(newer.entries[0]?.confirmedReferrals, 9);
    assert.deepEqual(
      await render(),
      message,
      'a retry keeps its queued snapshot',
    );

    now = new Date('2026-10-27T09:00:00Z');
    assert.equal((await job.run()).state, 'completed');
    const crossing = createEmailService(app, {
      clock,
      tokenSecret: secret,
      baseUrl: 'https://valstara.com',
      providers: new Map([
        [
          'brevo',
          {
            id: 'brevo',
            sendingDomain: 'mail.valstara.com',
            capabilities: {
              broadcast: true,
              contactSync: true,
              dailyFreeCap: 300,
            },
            async send() {
              assert.fail('an expired message reached the provider');
            },
          },
        ],
      ]),
      renderers: new Map([
        [
          'weekly_campaign_update',
          {
            kind: 'broadcast' as const,
            async render(input) {
              const message = await renderer.render(input);
              now = new Date('2026-10-28T09:00:00Z');
              return message;
            },
          },
        ],
      ]),
      isBroadcastEnabled: async () => true,
      operatorTask: async () => undefined,
    });
    assert.equal((await crossing.dispatch(10)).sent, 0);
    assert.equal(deliveries.length, 1);

    now = new Date('2026-10-29T09:00:00Z');
    const fresh = await store.refresh();
    assert.equal(await store.purge(100), 2);
    assert.equal(await store.byId(snapshot.id), null);
    assert.equal((await store.byId(newer.id))?.id, newer.id);
    assert.equal((await store.byId(fresh.id))?.id, fresh.id);

    now = new Date('2026-11-09T08:00:00Z');
    const restartedJob = createWeeklyCampaignJob(jobDependencies);
    assert.equal((await restartedJob.run()).state, 'early');
    const missedAfterRestart = await owner.readOne<{
      state: string;
      alerted_at: Date | null;
    }>({
      text: 'SELECT state, alerted_at FROM weekly_campaign_run WHERE iso_week = $1',
      values: ['2026-W45'],
    });
    assert.equal(missedAfterRestart?.state, 'skipped');
    assert.notEqual(missedAfterRestart.alerted_at, null);
    assert.equal(alerts.length, 4);
    assert.equal(
      (
        await owner.readOne<{ count: string }>({
          text: `SELECT COUNT(*)::text AS count FROM email_send
            WHERE business_key LIKE 'weekly:2026-W45:%'`,
        })
      )?.count,
      '0',
    );
  } finally {
    await app?.close();
    await owner.close();
    await admin.execute({ text: `DROP DATABASE "${name}" WITH (FORCE)` });
    await admin.close();
  }
});
