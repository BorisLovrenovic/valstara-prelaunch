import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createCampaignFlagRepository } from '../src/server/db/campaign-flags.ts';
import { displayNameDisclosureVersion as version } from '../src/server/partner/config.ts';
import {
  createPartnerLeaderboardJob,
  partnerLeaderboardLabel,
  readPartnerLeaderboard,
} from '../src/server/partner/leaderboard.ts';
import {
  createMaintenanceFailureReporter,
  createVerificationMaintenanceScheduler,
} from '../src/server/subscriber/maintenance.ts';
import { exportSubjectPage } from '../src/server/db/dsr-export.ts';
import {
  createPartnerFixture,
  insertPartner,
  insertReferral,
  partnerErasure,
} from './helpers/partner-review-fixture.ts';

test('leaderboard labels use only the current optional name and support Unicode initials', () => {
  assert.equal(partnerLeaderboardLabel(null, version, true), 'Partner');
  assert.equal(partnerLeaderboardLabel('123 !!', version, true), 'Partner');
  assert.equal(partnerLeaderboardLabel('Private Name', null, true), 'Partner');
  assert.equal(
    partnerLeaderboardLabel('Private Name', version + 1, false),
    'Partner',
  );
  assert.equal(
    partnerLeaderboardLabel('Élodie Ångström', version, false),
    'É. Å.',
  );
  assert.equal(
    partnerLeaderboardLabel('E\u0301lodie 王', version, false),
    'E\u0301. 王.',
  );
  assert.equal(partnerLeaderboardLabel('Morgan', version, false), 'M.');
  assert.equal(
    partnerLeaderboardLabel('Riley North', version, true),
    'Riley North',
  );
});

test('the production maintenance scheduler publishes the partner snapshot', async (t) => {
  const f = await createPartnerFixture('partner-leaderboard-production');
  t.after(() => f.dispose());
  const partner = await insertPartner(f, { status: 'active' });
  await insertReferral(f, partner.subscriberId);
  await createCampaignFlagRepository(f.app).set(
    'partners.enabled',
    true,
    'admin.operator',
  );
  assert.equal(await readPartnerLeaderboard(f.app, partner.id), null);

  const child = spawn(
    process.execPath,
    ['src/server/subscriber/run-maintenance.ts'],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        DATABASE_URL: f.appDatabaseUrl,
        EMAIL_BASE_URL: 'http://localhost:4321',
        EMAIL_TOKEN_SECRET: 'local-only-email-token-secret-32-chars',
        BREVO_WEBHOOK_TOKEN: 'local-only-brevo-webhook-token-32-chars',
        P1_ALERT_WEBHOOK_TOKEN: 'maintenance-test-token',
        P1_ALERT_WEBHOOK_URL: 'http://127.0.0.1:9/local-only-alert-sink',
        RESEND_API_KEY: 'maintenance-test-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
        NODE_ENV: 'test',
        NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
        WEEKLY_SEND_UTC: '2@09:00',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    },
  );
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errors += chunk;
  });
  try {
    const heartbeat = async () =>
      f.owner.readOne({
        text: `SELECT last_beat_at FROM maintenance_heartbeat
          WHERE loop_key = 'scheduler_cycle' AND last_beat_at IS NOT NULL`,
      });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      assert.equal(child.exitCode, null, errors);
      assert.equal(child.signalCode, null, errors);
      if ((await heartbeat()) !== null) break;
      await sleep(50);
    }
    assert.ok(await heartbeat(), `maintenance cycle did not finish: ${errors}`);
    const snapshot = await readPartnerLeaderboard(f.app, partner.id);
    assert.equal(
      snapshot?.ownRank,
      1,
      'production cycle did not publish a rank',
    );
    assert.deepEqual(snapshot.entries, [
      { rank: 1, confirmedSignups: 1, label: 'Partner' },
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    }
  }
});

test('scheduled snapshots rank confirmed signups in batches and retain the last complete cache on failure', async (t) => {
  const f = await createPartnerFixture('partner-leaderboard');
  t.after(() => f.dispose());
  const initial = new Date('2026-11-24T11:00:00Z');
  const hour = 60 * 60 * 1000;
  let now = initial;
  const clock = () => now;
  let enabled = false;
  const job = createPartnerLeaderboardJob(f.app, async () => enabled, clock);
  const first = await insertPartner(f, { status: 'active' });
  const second = await insertPartner(f, { status: 'active' });
  const paused = await insertPartner(f, { status: 'paused' });
  const confirmed = await insertReferral(f, first.subscriberId);
  await insertReferral(f, first.subscriberId);
  await insertReferral(f, second.subscriberId);
  const attributed = await insertReferral(f, first.subscriberId, {
    state: 'attributed',
  });
  const voided = await insertReferral(f, first.subscriberId, { voided: true });
  await insertReferral(f, paused.subscriberId);
  await f.owner.execute({
    text: "UPDATE subscriber SET verified_at = '2026-11-03Z' WHERE id = $1",
    values: [second.subscriberId],
  });
  // Verify that a malformed edge cannot score an unverified subscriber.
  const unverified = await insertReferral(f, second.subscriberId, {
    state: 'attributed',
  });
  await f.owner.execute({
    text: "UPDATE referral_edge SET state = 'confirmed', confirmed_at = $2 WHERE id = $1",
    values: [unverified.edgeId, initial],
  });
  for (let i = 0; i < 99; ++i) await insertPartner(f, { status: 'active' });
  const viewer = await insertPartner(f, { status: 'active' });
  await f.owner.execute({
    text: "UPDATE subscriber SET verified_at = '2026-11-04Z' WHERE id = $1",
    values: [viewer.subscriberId],
  });
  await job.run();
  assert.equal(await readPartnerLeaderboard(f.app, viewer.id), null);

  type Alert = Parameters<
    Parameters<typeof createMaintenanceFailureReporter>[0]['send']
  >[0];
  const alerts: Alert[] = [];
  const reportFailure = createMaintenanceFailureReporter(
    {
      async send(alert) {
        alerts.push(alert);
      },
    },
    { clock },
  );
  const noop = { run: async () => {} };
  const sleeps: number[] = [];
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: noop,
      rateLimitRetention: noop,
      reminder: noop,
      referralCounterRepair: noop,
      strandedReferral: noop,
      verificationRate: noop,
      verificationTokenRetention: noop,
      partnerLeaderboard: job,
    },
    {
      clock,
      reportFailure,
      async sleep(ms) {
        sleeps.push(ms);
        const snapshot = await readPartnerLeaderboard(f.app, viewer.id);
        assert.equal(snapshot?.asOf, initial.toISOString());
        assert.equal(snapshot.ownRank, 102);
        assert.equal(snapshot.entries.length, 20);
        assert.deepEqual(snapshot.entries.slice(0, 3), [
          { rank: 1, confirmedSignups: 2, label: 'Partner' },
          { rank: 2, confirmedSignups: 1, label: 'Partner' },
          { rank: 3, confirmedSignups: 0, label: 'Partner' },
        ]);
        assert.equal(
          (await readPartnerLeaderboard(f.app, paused.id))?.ownRank,
          null,
        );
        assert.equal(
          (
            await exportSubjectPage(
              f.app,
              'partner_leaderboard_rank',
              viewer.subscriberId,
              0,
            )
          )[0]?.data.rank,
          102,
        );

        await insertReferral(f, second.subscriberId);
        await insertReferral(f, second.subscriberId);
        assert.deepEqual(
          await readPartnerLeaderboard(f.app, viewer.id),
          snapshot,
        );
        const restarted = createPartnerLeaderboardJob(
          f.app,
          async () => true,
          clock,
        );
        await restarted.run();
        assert.deepEqual(
          await readPartnerLeaderboard(f.app, viewer.id),
          snapshot,
        );
        now = new Date(now.getTime() + ms);
      },
    },
  );
  enabled = true;
  await scheduler.run(2);
  assert.deepEqual(sleeps, [hour]);
  const refreshed = await readPartnerLeaderboard(f.app, viewer.id);
  assert.equal(refreshed?.asOf, now.toISOString());
  assert.equal(refreshed.entries[0]?.confirmedSignups, 3);
  assert.equal(refreshed.ownRank, 102);

  const erasure = partnerErasure(f, async () => {});
  for (const referral of [confirmed, attributed, voided]) {
    const confirm = await erasure.signedConfirmation(referral.referredId);
    assert.deepEqual(await confirm(), { kind: 'pending' });
  }
  now = new Date(now.getTime() + hour);
  await scheduler.runCycle();
  assert.deepEqual(
    await readPartnerLeaderboard(f.app, viewer.id),
    {
      ...refreshed,
      asOf: now.toISOString(),
    },
    'signed confirmation preserves only the confirmed, non-voided credit',
  );
  await erasure.fulfil();
  for (const referral of [confirmed, attributed, voided]) {
    assert.deepEqual(
      await f.owner.readOne({
        text: 'SELECT referred_id FROM referral_edge WHERE id = $1',
        values: [referral.edgeId],
      }),
      { referred_id: null },
    );
  }
  now = new Date(now.getTime() + hour);
  await scheduler.runCycle();
  const afterErasure = {
    ...refreshed,
    asOf: now.toISOString(),
  };
  assert.deepEqual(
    await readPartnerLeaderboard(f.app, viewer.id),
    afterErasure,
    'fulfilment preserves only the confirmed, non-voided credit',
  );

  await f.owner.execute({
    text: 'ALTER TABLE partner_leaderboard_rank ADD CONSTRAINT test_refresh_failure CHECK (confirmed_signups <> 4)',
  });
  await insertReferral(f, second.subscriberId);
  now = new Date(now.getTime() + hour);
  await scheduler.runCycle();
  assert.deepEqual(
    alerts.map(({ detail, severity }) => ({ detail, severity })),
    [{ detail: { job: 'partner_leaderboard_snapshot' }, severity: 'P2' }],
  );
  assert.deepEqual(
    await readPartnerLeaderboard(f.app, viewer.id),
    afterErasure,
  );

  await f.owner.execute({
    text: "UPDATE partner SET status = 'paused', status_changed_at = $2 WHERE id = $1",
    values: [second.id, now],
  });
  const withoutPaused = await readPartnerLeaderboard(f.app, viewer.id);
  assert.deepEqual(withoutPaused, {
    ...afterErasure,
    entries: afterErasure.entries.slice(1),
  });
  assert.equal((await readPartnerLeaderboard(f.app, second.id))?.ownRank, null);

  // Test a failed live name/eligibility lookup using the actual app role.
  await f.owner.execute({
    text: 'REVOKE SELECT ON partner_leaderboard_rank FROM valstara_app',
  });
  assert.equal(await readPartnerLeaderboard(f.app, viewer.id), null);
  await f.owner.execute({
    text: 'GRANT SELECT ON partner_leaderboard_rank TO valstara_app',
  });
  assert.deepEqual(
    await readPartnerLeaderboard(f.app, viewer.id),
    withoutPaused,
  );
});
