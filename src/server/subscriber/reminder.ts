import { randomUUID } from 'node:crypto';

import type { DatabaseConnection } from '../db/pool.ts';
import {
  createSubscriberMaintenanceRepository,
  type SubscriberMaintenanceRepository,
  type VerificationReminderOffsetHours,
} from '../db/subscriber-maintenance.ts';

export const verificationReminderOffsetsHours = [1, 24, 72] as const;

export interface VerificationReminderRun {
  readonly queued: number;
  readonly scanned: number;
}

export interface VerificationReminderJob {
  run(limit: number): Promise<VerificationReminderRun>;
}

export interface VerificationReminderDependencies {
  readonly clock?: () => Date;
}

export function verificationReminderBusinessKey(
  subscriberId: string,
  offsetHours: VerificationReminderOffsetHours,
): string {
  return `verify-reminder:${subscriberId}:${offsetHours}h`;
}

export function createVerificationReminderJob(
  database: DatabaseConnection,
  dependencies: VerificationReminderDependencies = {},
): VerificationReminderJob {
  return createVerificationReminderJobWithRepository(
    createSubscriberMaintenanceRepository(database),
    dependencies.clock ?? (() => new Date()),
  );
}

function createVerificationReminderJobWithRepository(
  repository: SubscriberMaintenanceRepository,
  clock: () => Date,
): VerificationReminderJob {
  return {
    async run(limit) {
      const due = await repository.listDueVerificationReminders(clock(), limit);
      let queued = 0;

      for (const reminder of due) {
        queued += await repository.queueVerificationReminder(
          randomUUID(),
          reminder.subscriber_id,
          verificationReminderBusinessKey(
            reminder.subscriber_id,
            reminder.offset_hours,
          ),
        );
      }

      return { queued, scanned: due.length };
    },
  };
}
