import type { DatabasePool } from '../db/pool.ts';
import { createReferralRepository } from '../db/referral.ts';
import { createVerificationCompletionRepository } from '../db/verification-completion.ts';
import { withTransaction } from '../db/transaction.ts';
import {
  accessWindowForVerificationOrder,
  type AccessWindow,
} from '../referral/config.ts';
import { createReferralService } from '../referral/service.ts';

import { createVerificationService } from './service.ts';
import type { ConsumeResult } from './types.ts';

export interface VerificationCompletion {
  readonly accessWindow: AccessWindow | null;
  readonly outcome: ConsumeResult;
  readonly referralCode: string | null;
  readonly statusToken: string | null;
}

export interface VerificationCompletionDependencies {
  readonly clock?: () => Date;
  readonly referralEnabled?: boolean;
  /** Test-only fault injection that proves the whole completion rolls back. */
  readonly afterStep?: (step: VerificationCompletionStep) => Promise<void>;
}

export type VerificationCompletionStep =
  'verified' | 'referral-code' | 'referral-confirmed' | 'access-window';

/**
 * The E3-07 completion boundary. A successful verification commits every
 * durable verification/referral/wave mutation together. Replays do not repeat
 * those mutations, but receive a fresh bearer status token for the same page.
 */
export function createVerificationCompletionService(
  database: DatabasePool,
  dependencies: VerificationCompletionDependencies = {},
): (token: string) => Promise<VerificationCompletion> {
  const clock = dependencies.clock ?? (() => new Date());
  const referralEnabled = dependencies.referralEnabled ?? true;

  return async (token) => {
    if (token === '') {
      return {
        accessWindow: null,
        outcome: 'invalid',
        referralCode: null,
        statusToken: null,
      };
    }

    return withTransaction(database, async (connection) => {
      const verification = createVerificationService(connection, { clock });
      const consumed = await verification.consumeForVerification(token);
      if (consumed.outcome === 'invalid' || consumed.outcome === 'expired') {
        return {
          accessWindow: null,
          outcome: consumed.outcome,
          referralCode: null,
          statusToken: null,
        };
      }
      if (consumed.subscriberId === null) {
        throw new Error(
          'A successful verification consume requires a subscriber.',
        );
      }

      const subscriberId = consumed.subscriberId;
      const referral = createReferralService(connection);
      const completion = createVerificationCompletionRepository(connection);
      const repository = createReferralRepository(connection);

      if (consumed.outcome === 'verified') {
        const verified = await completion.markVerified(subscriberId, clock());
        if (verified !== 1) {
          throw new Error(
            'A fresh verification token did not verify a pending subscriber.',
          );
        }
        await dependencies.afterStep?.('verified');

        const order = await repository.verificationOrder(subscriberId, clock());
        const window = accessWindowForVerificationOrder(order);
        await repository.setAccessWindow(subscriberId, window);
        await dependencies.afterStep?.('access-window');
      }

      // The flag gates only display/new attribution. Code allocation and an
      // already-recorded edge must continue to completion even while it is off;
      // running these idempotently on replay also repairs rows stranded by the
      // former flag-off behaviour.
      await referral.generateCode(subscriberId);
      await dependencies.afterStep?.('referral-code');
      await referral.confirm(subscriberId, clock());
      await dependencies.afterStep?.('referral-confirmed');

      const subscriber = await repository.findSubscriber(subscriberId);
      if (subscriber === null || subscriber.status !== 'verified') {
        throw new Error(
          'A successful verification subscriber could not be read.',
        );
      }

      const status = await verification.issue(subscriberId, 'status');
      return {
        accessWindow: subscriber.access_window,
        outcome: consumed.outcome,
        referralCode: referralEnabled ? subscriber.referral_code : null,
        statusToken: status.token,
      };
    });
  };
}
