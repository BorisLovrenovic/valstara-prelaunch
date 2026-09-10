import {
  getDatabaseUrl,
  getP1AlertConfiguration,
  getVerificationRateConfiguration,
} from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createRateLimitRetentionJob } from '../ratelimit/retention.ts';
import { createP1AlertWebhookTransport } from '../verification-rate/p1-webhook.ts';
import { createVerificationRateMonitor } from '../verification-rate/service.ts';

import { createUnverifiedExpiryJob } from './expiry.ts';
import {
  createMaintenanceFailureReporter,
  createVerificationMaintenanceScheduler,
} from './maintenance.ts';
import { createVerificationReminderJob } from './reminder.ts';

const database = createPool(getDatabaseUrl());
const clock = (): Date => new Date();
const p1Alerts = createP1AlertWebhookTransport(getP1AlertConfiguration());
const reportFailure = createMaintenanceFailureReporter(p1Alerts, { clock });

async function reportVerificationRateCollapse(alert: {
  readonly baselineRate: number;
  readonly currentRate: number;
  readonly measuredAt: Date;
  readonly relativeDrop: number;
  readonly severity: 'P1';
}): Promise<void> {
  await p1Alerts.send({
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
    reminder: createVerificationReminderJob(database, { clock }),
    verificationRate: createVerificationRateMonitor(
      database,
      getVerificationRateConfiguration(),
      { alert: reportVerificationRateCollapse, clock },
    ),
  },
  { clock, reportFailure },
);

const stop = (): void => {
  void database.close().finally(() => process.exit(0));
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await scheduler.run();
