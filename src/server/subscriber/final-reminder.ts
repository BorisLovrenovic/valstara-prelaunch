import type { DatabasePool } from '../db/pool.ts';
import { createSubscriberMaintenanceRepository } from '../db/subscriber-maintenance.ts';
import { createEmailRepository } from '../db/email.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import { createVerificationService } from '../verification/service.ts';

export const finalReminderBatchSize = 500;

export function createFinalReminderJob(
  database: DatabasePool,
  clock: () => Date,
) {
  return {
    async run(afterId: string | null, limit = finalReminderBatchSize) {
      const rows = await createSubscriberMaintenanceRepository(
        database,
      ).listFinalReminderCandidates(afterId, limit);
      let queued = 0;
      for (const row of rows) {
        queued += Number(
          await withTransaction(database, async (connection) => {
            if (
              !(await createSubscriberMaintenanceRepository(
                connection,
              ).lockFinalReminderCandidate(row.id))
            )
              return false;
            const businessKey = `verify-reminder-final:${row.id}`;
            if (
              await createEmailRepository(connection).findByBusinessKey(
                businessKey,
              )
            )
              return false;
            const token = await createVerificationService(connection, {
              clock,
            }).issue(row.id, 'verify');
            return createEmailQueue(database, clock).queue(
              {
                subscriberId: row.id,
                businessKey,
                template: 'verification_reminder',
                provider: 'resend',
                payload: { token_id: token.id },
              },
              connection,
            );
          }),
        );
      }
      return {
        scanned: rows.length,
        queued,
        afterId: rows.at(-1)?.id ?? afterId,
      };
    },
  };
}
