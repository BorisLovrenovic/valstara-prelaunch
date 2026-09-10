import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createVerificationMaintenanceScheduler,
  verificationMaintenanceBatchLimit,
} from '../src/server/subscriber/maintenance.ts';

const HOUR_MS = 60 * 60 * 1_000;

test('maintenance runs reminders hourly and expiry once per UTC day with fixed batch caps', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const reminderLimits: number[] = [];
  const expiryLimits: number[] = [];
  const retentionLimits: number[] = [];
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
      reminder: {
        async run(limit) {
          reminderLimits.push(limit);
        },
      },
      verificationRate: {
        async run() {
          verificationRateRuns += 1;
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
  assert.ok(
    [...reminderLimits, ...expiryLimits, ...retentionLimits].every(
      (limit) => limit === verificationMaintenanceBatchLimit,
    ),
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
      reminder: {
        async run() {
          throw new Error('database unavailable');
        },
      },
      verificationRate: {
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
    'reminder',
    'verification_rate',
  ]);
  assert.equal(expiryAttempts, 2);
  assert.equal(retentionAttempts, 2);
});
