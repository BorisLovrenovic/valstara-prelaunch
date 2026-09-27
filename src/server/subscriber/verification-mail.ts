import { thinSliceCopy } from '../../copy/e1-11.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import { createVerificationService } from '../verification/service.ts';

/**
 * The signup flow queues through E8-01 and retains E1-11's direct test-mode
 * sender until E8-02 registers Resend. The direct send remains best effort and
 * never rolls back a committed subscriber.
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

export function createResendTestMailSender(
  apiKey: string | undefined,
  testRecipient: string | undefined,
): VerificationMailSender {
  return async (mail) => {
    if (!apiKey || !testRecipient) {
      throw new Error('Resend test-mode configuration is unavailable.');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': mail.businessKey,
      },
      body: JSON.stringify({
        from: 'Valstara <onboarding@resend.dev>',
        subject: thinSliceCopy.verificationSubject,
        text: thinSliceCopy.verificationText(mail.verificationUrl),
        to: [testRecipient],
      }),
    });

    if (!response.ok) {
      throw new Error('Resend test-mode request failed.');
    }
  };
}
