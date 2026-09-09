import type { DatabasePool } from '../db/pool.ts';
import { createSubscriberRepository } from '../db/subscriber.ts';

import { normaliseEmail } from './normalise-email.ts';
import { queueVerificationMail } from './verification-mail.ts';

export interface ResendVerificationInput {
  readonly email: string;
  readonly now: Date;
  readonly verificationUrl: (token: string) => string;
}

export interface ResendVerificationOutcome {
  readonly pendingSubscriberId: string | null;
}

/**
 * Reissues a verification token only for an existing pending subscriber.
 * Its result deliberately exposes no subscriber state, so the route cannot
 * become an email-list enumeration oracle.
 */
export function createResendVerificationService(
  database: DatabasePool,
): (input: ResendVerificationInput) => Promise<ResendVerificationOutcome> {
  return async (input) => {
    const normalised = normaliseEmail(input.email);
    if (normalised === null) {
      return { pendingSubscriberId: null };
    }

    const subscriber = await createSubscriberRepository(
      database,
    ).findByNormalised(normalised.normalised);
    if (subscriber?.status !== 'pending') {
      return { pendingSubscriberId: null };
    }

    // This queues work through the pre-E8 seam. E8-01 owns provider dispatch,
    // retries, and the production email service.
    await queueVerificationMail(
      database,
      subscriber.id,
      input.verificationUrl,
      input.now,
    );
    return { pendingSubscriberId: subscriber.id };
  };
}
