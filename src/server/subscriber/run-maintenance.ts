import { getDatabaseUrl, getVerificationRateConfiguration } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createVerificationRateMonitor } from '../verification-rate/service.ts';

import { createUnverifiedExpiryJob } from './expiry.ts';
import { createVerificationMaintenanceScheduler } from './maintenance.ts';
import { createVerificationReminderJob } from './reminder.ts';

const database = createPool(getDatabaseUrl());
const clock = (): Date => new Date();

function reportFailure(job: 'expiry' | 'reminder' | 'verification_rate'): void {
  process.stderr.write(
    `${JSON.stringify({
      event: 'verification_maintenance_failed',
      job,
      severity: job === 'verification_rate' ? 'P1' : 'P3',
    })}\n`,
  );
}

function reportVerificationRateCollapse(alert: {
  readonly baselineRate: number;
  readonly currentRate: number;
  readonly measuredAt: Date;
  readonly relativeDrop: number;
  readonly severity: 'P1';
}): void {
  process.stderr.write(
    `${JSON.stringify({
      event: 'verification_rate_collapsed',
      baseline_rate: alert.baselineRate,
      current_rate: alert.currentRate,
      measured_at: alert.measuredAt.toISOString(),
      relative_drop: alert.relativeDrop,
      severity: alert.severity,
    })}\n`,
  );
}

const scheduler = createVerificationMaintenanceScheduler(
  {
    expiry: createUnverifiedExpiryJob(database, { clock }),
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
