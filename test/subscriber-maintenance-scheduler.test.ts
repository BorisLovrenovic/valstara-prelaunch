import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMaintenanceFailureReporter,
  createVerificationMaintenanceScheduler,
  verificationMaintenanceBatchLimit,
} from '../src/server/subscriber/maintenance.ts';
import {
  createVerificationTokenRetentionJob,
  verificationTokenPostExpiryRetentionMs,
} from '../src/server/verification/retention.ts';

const HOUR_MS = 60 * 60 * 1_000;

test('verification-token retention failure is reported as P1', async () => {
  const occurredAt = new Date('2026-09-10T12:00:00.000Z');
  const alerts: unknown[] = [];
  const report = createMaintenanceFailureReporter(
    {
      async send(alert) {
        alerts.push(alert);
      },
    },
    { clock: () => occurredAt },
  );
  await report('verification_token_retention');
  assert.deepEqual(alerts, [
    {
      detail: { job: 'verification_token_retention' },
      event: 'verification_maintenance_failed',
      occurredAt,
      severity: 'P1',
    },
  ]);
});

test('verification-token retention passes the 30-day cutoff and scheduler batch cap to purgeExpired', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  let values: readonly unknown[] | undefined;
  const database = {
    async execute(query: { readonly values?: readonly unknown[] }) {
      values = query.values;
      return 7;
    },
  } as never;
  const removed = await createVerificationTokenRetentionJob(database, {
    clock: () => now,
  }).run(verificationMaintenanceBatchLimit);

  assert.equal(removed, 7);
  assert.deepEqual(values, [
    new Date(now.getTime() - verificationTokenPostExpiryRetentionMs),
    verificationMaintenanceBatchLimit,
  ]);
});

test('maintenance runs reminders hourly and expiry once per UTC day with fixed batch caps', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const reminderLimits: number[] = [];
  const expiryLimits: number[] = [];
  const retentionLimits: number[] = [];
  const tokenRetentionLimits: number[] = [];
  const strandedReferralLimits: number[] = [];
  const referralCounterRepairLimits: number[] = [];
  let verificationRateRuns = 0;
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: {
        async run(limit) {
          expiryLimits.push(limit);
        },
      },
      rateLimitRetention: {
        async run(limit) {
          retentionLimits.push(limit);
        },
      },
      referralCounterRepair: {
        async run(limit) {
          referralCounterRepairLimits.push(limit);
        },
      },
      reminder: {
        async run(limit) {
          reminderLimits.push(limit);
        },
      },
      strandedReferral: {
        async run(limit) {
          strandedReferralLimits.push(limit);
        },
      },
      verificationRate: {
        async run() {
          verificationRateRuns += 1;
        },
      },
      verificationTokenRetention: {
        async run(limit) {
          tokenRetentionLimits.push(limit);
        },
      },
    },
    {
      clock: () => now,
      async sleep(milliseconds) {
        assert.equal(milliseconds, HOUR_MS);
        now = new Date(now.getTime() + milliseconds);
      },
    },
  );

  await scheduler.run(25);

  assert.equal(reminderLimits.length, 25);
  assert.equal(verificationRateRuns, 25);
  assert.equal(expiryLimits.length, 2);
  assert.equal(retentionLimits.length, 2);
  assert.equal(tokenRetentionLimits.length, 2);
  assert.equal(strandedReferralLimits.length, 2);
  assert.equal(referralCounterRepairLimits.length, 2);
  assert.ok(
    [
      ...reminderLimits,
      ...expiryLimits,
      ...retentionLimits,
      ...tokenRetentionLimits,
      ...strandedReferralLimits,
      ...referralCounterRepairLimits,
    ].every((limit) => limit === verificationMaintenanceBatchLimit),
  );
});

test('maintenance reports failures through its runner seam and retries expiry', async () => {
  const failures: string[] = [];
  let expiryAttempts = 0;
  let retentionAttempts = 0;
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: {
        async run() {
          expiryAttempts += 1;
          if (expiryAttempts === 1) {
            throw new Error('database unavailable');
          }
        },
      },
      rateLimitRetention: {
        async run() {
          retentionAttempts += 1;
          if (retentionAttempts === 1) {
            throw new Error('database unavailable');
          }
        },
      },
      referralCounterRepair: {
        async run() {},
      },
      reminder: {
        async run() {
          throw new Error('database unavailable');
        },
      },
      strandedReferral: {
        async run() {},
      },
      verificationRate: {
        async run() {
          throw new Error('database unavailable');
        },
      },
      verificationTokenRetention: {
        async run() {
          throw new Error('database unavailable');
        },
      },
    },
    {
      clock: () => new Date('2026-09-09T12:00:00.000Z'),
      reportFailure(job) {
        failures.push(job);
      },
    },
  );

  await scheduler.runCycle();
  await scheduler.runCycle();

  assert.deepEqual(failures, [
    'reminder',
    'verification_rate',
    'expiry',
    'rate_limit_retention',
    'verification_token_retention',
    'reminder',
    'verification_rate',
    'verification_token_retention',
  ]);
  assert.equal(expiryAttempts, 2);
  assert.equal(retentionAttempts, 2);
});
