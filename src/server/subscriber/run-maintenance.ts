import {
  getDatabaseUrl,
  getP1AlertConfiguration,
  getVerificationRateConfiguration,
} from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createRateLimitRetentionJob } from '../ratelimit/retention.ts';
import { createStrandedReferralReconciliationJob } from '../referral/reconcile-stranded.ts';
import { createReferralCounterRepairJob } from '../referral/counter-repair.ts';
import { createAlertWebhookTransport } from '../verification-rate/p1-webhook.ts';
import { createVerificationRateMonitor } from '../verification-rate/service.ts';
import { createVerificationTokenRetentionJob } from '../verification/retention.ts';

import { createUnverifiedExpiryJob } from './expiry.ts';
import {
  createMaintenanceFailureReporter,
  createVerificationMaintenanceScheduler,
} from './maintenance.ts';
import { createVerificationReminderJob } from './reminder.ts';

const database = createPool(getDatabaseUrl());
const clock = (): Date => new Date();
const alerts = createAlertWebhookTransport(getP1AlertConfiguration());
const reportFailure = createMaintenanceFailureReporter(alerts, { clock });

async function reportVerificationRateCollapse(alert: {
  readonly baselineRate: number;
  readonly currentRate: number;
  readonly measuredAt: Date;
  readonly relativeDrop: number;
  readonly severity: 'P1';
}): Promise<void> {
  await alerts.send({
    detail: {
      baseline_rate: alert.baselineRate,
      current_rate: alert.currentRate,
      relative_drop: alert.relativeDrop,
    },
    event: 'verification_rate_collapsed',
    occurredAt: alert.measuredAt,
    severity: alert.severity,
  });
}

const scheduler = createVerificationMaintenanceScheduler(
  {
    expiry: createUnverifiedExpiryJob(database, { clock }),
    rateLimitRetention: createRateLimitRetentionJob(database, { clock }),
    referralCounterRepair: createReferralCounterRepairJob(database, {
      alert: (alert) => alerts.send(alert),
    }),
    reminder: createVerificationReminderJob(database, { clock }),
    strandedReferral: createStrandedReferralReconciliationJob(database, {
      clock,
    }),
    verificationRate: createVerificationRateMonitor(
      database,
      getVerificationRateConfiguration(),
      { alert: reportVerificationRateCollapse, clock },
    ),
    verificationTokenRetention: createVerificationTokenRetentionJob(database, {
      clock,
    }),
  },
  { clock, reportFailure },
);

const stop = (): void => {
  void database.close().finally(() => process.exit(0));
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await scheduler.run();
