import { getDatabaseUrl } from '../config.ts';
import { createPool } from '../db/pool.ts';

import { createUnverifiedExpiryJob } from './expiry.ts';
import { createVerificationMaintenanceScheduler } from './maintenance.ts';
import { createVerificationReminderJob } from './reminder.ts';

const database = createPool(getDatabaseUrl());
const clock = (): Date => new Date();

function reportFailure(job: 'expiry' | 'reminder'): void {
  process.stderr.write(
    `${JSON.stringify({
      event: 'verification_maintenance_failed',
      job,
      severity: 'P3',
    })}\n`,
  );
}

const scheduler = createVerificationMaintenanceScheduler(
  {
    expiry: createUnverifiedExpiryJob(database, { clock }),
    reminder: createVerificationReminderJob(database, { clock }),
  },
  { clock, reportFailure },
);

const stop = (): void => {
  void database.close().finally(() => process.exit(0));
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await scheduler.run();
