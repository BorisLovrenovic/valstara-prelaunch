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

test('giveaway reconciliation failure is reported as P2', async () => {
  const occurredAt = new Date('2026-10-02T12:00:00.000Z');
  const alerts: unknown[] = [];
  const report = createMaintenanceFailureReporter(
    {
      async send(alert) {
        alerts.push(alert);
      },
    },
    { clock: () => occurredAt },
  );
  await report('giveaway_entry_reconciliation');
  assert.deepEqual(alerts, [
    {
      detail: { job: 'giveaway_entry_reconciliation' },
      event: 'verification_maintenance_failed',
      occurredAt,
      severity: 'P2',
    },
  ]);
});

test('E8-06 email reconciliation runs hourly with the batch cap and reports failure as P2', async () => {
  const at = new Date('2026-09-30T12:00:00.000Z');
  const limits: number[] = [];
  const alerts: unknown[] = [];
  const noOp = { async run() {} };
  const report = createMaintenanceFailureReporter(
    {
      send: async (alert) => {
        alerts.push(alert);
      },
    },
    { clock: () => at },
  );
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: noOp,
      rateLimitRetention: noOp,
      referralCounterRepair: noOp,
      reminder: noOp,
      strandedReferral: noOp,
      verificationRate: noOp,
      verificationTokenRetention: noOp,
      emailReconciliation: {
        async run(limit) {
          limits.push(limit);
          throw new Error('provider down');
        },
      },
    },
    { clock: () => at, reportFailure: report },
  );
  await scheduler.runCycle();
  await scheduler.runCycle();
  assert.deepEqual(limits, [
    verificationMaintenanceBatchLimit,
    verificationMaintenanceBatchLimit,
  ]);
  assert.deepEqual(
    alerts,
    Array.from({ length: 2 }, () => ({
      detail: { job: 'email_reconciliation' },
      event: 'verification_maintenance_failed',
      occurredAt: at,
      severity: 'P2',
    })),
  );
});

test('giveaway reconciliation is scheduled on every maintenance cycle with the batch cap', async () => {
  const limits: number[] = [];
  const noOp = { async run() {} };
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: noOp,
      giveawayEntryReconciliation: {
        async run(limit) {
          limits.push(limit);
        },
      },
      rateLimitRetention: noOp,
      referralCounterRepair: noOp,
      reminder: noOp,
      strandedReferral: noOp,
      verificationRate: noOp,
      verificationTokenRetention: noOp,
    },
    { clock: () => new Date('2026-10-02T12:00:00.000Z') },
  );
  await scheduler.runCycle();
  await scheduler.runCycle();
  assert.deepEqual(limits, [
    verificationMaintenanceBatchLimit,
    verificationMaintenanceBatchLimit,
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

test('maintenance shutdown finishes its active cycle before stopping', async () => {
  let started!: () => void;
  let finish!: () => void;
  const cycleStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cycleCanFinish = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let cycles = 0;
  const noOp = { async run() {} };
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: noOp,
      rateLimitRetention: noOp,
      referralCounterRepair: noOp,
      reminder: {
        async run() {
          cycles += 1;
          started();
          await cycleCanFinish;
        },
      },
      strandedReferral: noOp,
      verificationRate: noOp,
      verificationTokenRetention: noOp,
    },
    { clock: () => new Date('2026-09-27T12:00:00.000Z') },
  );
  const shutdown = new AbortController();
  const running = scheduler.run(undefined, shutdown.signal);

  await cycleStarted;
  shutdown.abort();
  let stopped = false;
  void running.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);

  finish();
  await running;
  assert.equal(cycles, 1);
});
