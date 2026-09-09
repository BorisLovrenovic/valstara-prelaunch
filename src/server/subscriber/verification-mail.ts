import { thinSliceCopy } from '../../copy/e1-11.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { createSubscriberRepository } from '../db/subscriber.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

const verificationLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

/**
 * The verification mail, queued and sent by the signup flow.
 *
 * This is still the deliberately minimal E1-11 test-mode sender: the row in
 * `email_send` is the source of truth, and this fire-and-forget send is best
 * effort. E3-06 owns the real verification-token module and E8-01 the email
 * service with `business_key` idempotency, suppression re-checked at dispatch,
 * and retry. Until then the signup service keeps queueing through here so a
 * send failure never rolls back the subscriber row.
 */
export interface VerificationTestMail {
  readonly businessKey: string;
  readonly verificationUrl: string;
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function createVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Creates a fresh, single-use verification token and its queued mail record.
 * Delivery remains outside this transaction: E8-01 owns dispatch and retry.
 */
export async function queueVerificationMail(
  database: DatabasePool,
  subscriberId: string,
  verificationUrl: (token: string) => string,
  now: Date,
): Promise<VerificationTestMail> {
  return withTransaction(database, async (connection) => {
    const repository = createSubscriberRepository(connection);
    const tokenId = randomUUID();
    const token = createVerificationToken();
    const businessKey = `verify:${subscriberId}:${tokenId}`;

    await repository.insertVerificationToken({
      expiresAt: new Date(now.getTime() + verificationLifetimeMs),
      id: tokenId,
      subscriberId,
      tokenHash: tokenHash(token),
    });
    await repository.insertQueuedVerificationEmail({
      businessKey,
      id: randomUUID(),
      subscriberId,
    });

    return { businessKey, verificationUrl: verificationUrl(token) };
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
