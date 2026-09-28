import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import { createVerificationService } from '../verification/service.ts';

/**
 * The signup flow queues through E8-01. E8-02 dispatches queued mail through
 * the registered Resend provider once a renderer is available.
 */
export interface VerificationTestMail {
  readonly businessKey: string;
  readonly verificationUrl: string;
}

/**
 * Creates a fresh, single-use verification token and its queued mail record.
 * Delivery remains outside this transaction.
 */
export async function queueVerificationMail(
  database: DatabasePool,
  subscriberId: string,
  verificationUrl: (token: string) => string,
  now: Date,
): Promise<VerificationTestMail> {
  return withTransaction(database, async (connection) => {
    const issued = await createVerificationService(connection, {
      clock: () => now,
    }).issue(subscriberId, 'verify');
    const businessKey = `verify:${subscriberId}:${issued.id}`;
    await createEmailQueue(database, () => now).queue(
      {
        businessKey,
        subscriberId,
        template: 'verification_test',
        provider: 'resend',
        payload: { token_id: issued.id },
      },
      connection,
    );

    return { businessKey, verificationUrl: verificationUrl(issued.token) };
  });
}

export type VerificationMailSender = (
  mail: VerificationTestMail,
) => Promise<void>;
