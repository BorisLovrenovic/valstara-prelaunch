import type { DatabasePool } from '../db/pool.ts';
import { createReferralRepository } from '../db/referral.ts';
import { createVerificationCompletionRepository } from '../db/verification-completion.ts';
import { withTransaction } from '../db/transaction.ts';
import {
  accessWindowBands,
  accessWindowForVerificationOrder,
  type AccessWindowBand,
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
  readonly surveyCompleted: boolean;
}

export interface VerificationCompletionDependencies {
  readonly accessWindowBands?: readonly AccessWindowBand[];
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
        surveyCompleted: false,
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
          surveyCompleted: false,
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
        // Serialise the count-and-assign section so concurrent verifications
        // receive distinct, stable ordinals at a configured band boundary.
        await repository.lockAccessWindowAssignment();
        const verificationTime = clock();
        const verified = await completion.markVerified(
          subscriberId,
          verificationTime,
        );
        if (verified !== 1) {
          throw new Error(
            'A fresh verification token did not verify a pending subscriber.',
          );
        }
        await dependencies.afterStep?.('verified');

        const subscriber = await repository.findSubscriber(subscriberId);
        if (subscriber === null) {
          throw new Error(
            'A verified subscriber could not be read for wave assignment.',
          );
        }
        const order = await repository.verificationOrder();
        const window = accessWindowForVerificationOrder(
          order,
          subscriber.referral_tier,
          dependencies.accessWindowBands ?? accessWindowBands,
        );
        if ((await repository.setAccessWindow(subscriberId, window)) !== 1) {
          throw new Error('The verified subscriber wave was not recorded.');
        }
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
        surveyCompleted: await completion.hasSurveyResponse(subscriberId),
      };
    });
  };
}
