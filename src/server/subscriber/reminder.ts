import type { DatabasePool } from '../db/pool.ts';
import {
  createSubscriberMaintenanceRepository,
  type SubscriberMaintenanceRepository,
  type VerificationReminderOffsetHours,
} from '../db/subscriber-maintenance.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailRepository } from '../db/email.ts';
import { createEmailQueue } from '../email/queue.ts';
import { createVerificationService } from '../verification/service.ts';

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
  database: DatabasePool,
  dependencies: VerificationReminderDependencies = {},
): VerificationReminderJob {
  return createVerificationReminderJobWithRepository(
    createSubscriberMaintenanceRepository(database),
    database,
    dependencies.clock ?? (() => new Date()),
  );
}

function createVerificationReminderJobWithRepository(
  repository: SubscriberMaintenanceRepository,
  database: DatabasePool,
  clock: () => Date,
): VerificationReminderJob {
  return {
    async run(limit) {
      const due = await repository.listDueVerificationReminders(clock(), limit);
      let queued = 0;

      for (const reminder of due) {
        queued += Number(
          await withTransaction(database, async (connection) => {
            if (
              !(await createSubscriberMaintenanceRepository(
                connection,
              ).lockPendingSubscriber(reminder.subscriber_id))
            )
              return false;
            const businessKey = verificationReminderBusinessKey(
              reminder.subscriber_id,
              reminder.offset_hours,
            );
            if (
              await createEmailRepository(connection).findByBusinessKey(
                businessKey,
              )
            ) {
              return false;
            }
            const issued = await createVerificationService(connection, {
              clock,
            }).issue(reminder.subscriber_id, 'verify');
            return createEmailQueue(database, clock).queue(
              {
                subscriberId: reminder.subscriber_id,
                businessKey,
                template: 'verification_reminder',
                provider: 'resend',
                payload: { token_id: issued.id },
              },
              connection,
            );
          }),
        );
      }

      return { queued, scanned: due.length };
    },
  };
}
