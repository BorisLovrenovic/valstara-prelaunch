import assert from 'node:assert/strict';
import test from 'node:test';

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
  await insertReferral(f, first.subscriberId);
  await insertReferral(f, first.subscriberId);
  await insertReferral(f, second.subscriberId);
  await insertReferral(f, second.subscriberId, { state: 'attributed' });
  await insertReferral(f, second.subscriberId, { voided: true });
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
  assert.deepEqual(await readPartnerLeaderboard(f.app, viewer.id), refreshed);

  await f.owner.execute({
    text: "UPDATE partner SET status = 'paused', status_changed_at = $2 WHERE id = $1",
    values: [second.id, now],
  });
  const withoutPaused = await readPartnerLeaderboard(f.app, viewer.id);
  assert.deepEqual(withoutPaused, {
    ...refreshed,
    entries: refreshed.entries.slice(1),
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
