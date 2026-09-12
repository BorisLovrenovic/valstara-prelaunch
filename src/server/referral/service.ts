import { randomBytes, randomUUID } from 'node:crypto';

import {
  createReferralRepository,
  type ReferralRepository,
} from '../db/referral.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

import {
  referralCodeAlphabet,
  referralCodeLength,
  milestoneTiers,
  promoteAccessWindow,
  tierForConfirmedReferrals,
} from './config.ts';

const maximumCodeAttempts = 10;

export interface ReferralServiceDependencies {
  readonly createCode?: () => string;
}

export type AttributeResult =
  | { readonly kind: 'attributed' }
  | { readonly kind: 'self_referral' }
  | { readonly kind: 'unattributed' };

export interface ReferralService {
  attribute(
    referredId: string,
    code: string,
    allowAttribution?: boolean,
  ): Promise<AttributeResult>;
  confirm(referredId: string, now: Date): Promise<void>;
  generateCode(subscriberId: string): Promise<string>;
  getReferralCode(subscriberId: string): Promise<string | null>;
  lookupCode(code: string): Promise<string | null>;
}

/**
 * Referral operations used by E3-07's verification transaction. Attribution,
 * signed refs, and later repair/settlement paths remain in their owning tickets.
 */
export function createReferralService(
  database: DatabaseConnection | DatabasePool,
  dependencies: ReferralServiceDependencies = {},
): ReferralService {
  const createCode = dependencies.createCode ?? createReferralCode;
  return createReferralServiceWithRepository(
    createReferralRepository(database),
    createCode,
    isDatabasePool(database)
      ? (operation) =>
          withTransaction(database, async (connection) =>
            operation(connection),
          )
      : async (operation) => operation(database),
  );
}

type AttributionOperation = (
  connection: DatabaseConnection,
) => Promise<AttributeResult>;
type AttributionTransaction = (
  operation: AttributionOperation,
) => Promise<AttributeResult>;

export function createReferralCode(): string {
  let code = '';
  const unbiasedMaximum = 256 - (256 % referralCodeAlphabet.length);

  while (code.length < referralCodeLength) {
    const remaining = referralCodeLength - code.length;
    for (const value of randomBytes(remaining)) {
      if (value >= unbiasedMaximum) {
        continue;
      }
      code += referralCodeAlphabet.charAt(value % referralCodeAlphabet.length);
      if (code.length === referralCodeLength) {
        break;
      }
    }
  }
  return code;
}

function createReferralServiceWithRepository(
  repository: ReferralRepository,
  createCode: () => string,
  runAttributionTransaction: AttributionTransaction,
): ReferralService {
  return {
    async attribute(referredId, code, allowAttribution = true) {
      return runAttributionTransaction(async (connection) => {
        const transactionalRepository = createReferralRepository(connection);
        const referrerId = await transactionalRepository.findSubscriberIdByCode(
          code,
        );
        if (referrerId === null) {
          return { kind: 'unattributed' };
        }
        if (referrerId === referredId) {
          await createFraudFlagRepository(connection).insertSelfReferralFlag({
            id: randomUUID(),
            subscriberId: referredId,
          });
          return { kind: 'self_referral' };
        }
        if (!allowAttribution) {
          return { kind: 'unattributed' };
        }

        const inserted = await transactionalRepository.insertAttributedEdge(
          randomUUID(),
          referrerId,
          referredId,
        );
        if (inserted === 0) {
          return { kind: 'unattributed' };
        }

        const assigned = await transactionalRepository.assignReferrer(
          referredId,
          referrerId,
        );
        if (assigned !== 1) {
          throw new Error('Referral attribution could not assign its referrer.');
        }
        return { kind: 'attributed' };
      });
    },
    async confirm(referredId, now) {
      const edge = await repository.findEdgeForConfirmation(referredId);
      if (edge === null) {
        return;
      }

      const confirmed = await repository.confirmEdge(referredId, now);
      if (confirmed !== 1) {
        throw new Error('The referral edge could not be confirmed.');
      }

      const confirmedReferrals = await repository.countConfirmedEdges(
        edge.referrer_id,
      );
      const current = await repository.findSubscriber(edge.referrer_id);
      if (current === null) {
        throw new Error('The referral edge referrer could not be read.');
      }

      const nextTier = tierForConfirmedReferrals(confirmedReferrals);
      await repository.setReferralCounterAndTier(
        edge.referrer_id,
        confirmedReferrals,
        nextTier,
      );

      if (nextTier > current.referral_tier) {
        const tier = milestoneTiers.find(
          (candidate) => candidate.number === nextTier,
        );
        if (tier === undefined) {
          throw new Error('The earned referral tier has no configuration.');
        }

        // Cheap rewards settle at confirmation. High-value rewards remain held
        // until the post-launch first-order transition (ADR-025).
        await repository.insertMilestoneAward(
          randomUUID(),
          edge.referrer_id,
          nextTier,
          'wave_upgrade',
          'settled',
          now,
        );
        if (tier.discountPercent > 0) {
          await repository.insertMilestoneAward(
            randomUUID(),
            edge.referrer_id,
            nextTier,
            'discount',
            'held',
            now,
          );
        }
        if (tier.bonusEntries > 0) {
          await repository.insertMilestoneAward(
            randomUUID(),
            edge.referrer_id,
            nextTier,
            'entries',
            'held',
            now,
          );
        }

        if (current.access_window !== null) {
          await repository.setAccessWindow(
            edge.referrer_id,
            promoteAccessWindow(
              current.access_window,
              nextTier - current.referral_tier,
            ),
          );
        }
      }
    },

    async generateCode(subscriberId) {
      const subscriber = await repository.findSubscriber(subscriberId);
      if (subscriber === null) {
        throw new Error('A referral code requires an existing subscriber.');
      }
      if (subscriber.referral_code !== null) {
        return subscriber.referral_code;
      }
      if (subscriber.status !== 'verified') {
        throw new Error('A referral code requires a verified subscriber.');
      }

      for (let attempt = 0; attempt < maximumCodeAttempts; attempt += 1) {
        const code = createCode();
        try {
          const assigned = await repository.assignReferralCode(
            subscriberId,
            code,
          );
          if (assigned === 1) {
            return code;
          }

          // Another verification/replay may have won the allocation race for
          // this subscriber. Return that code so generation stays idempotent.
          const concurrentlyAssigned = await repository.findCode(subscriberId);
          if (concurrentlyAssigned !== null) {
            return concurrentlyAssigned;
          }
        } catch (error) {
          if (!isReferralCodeCollision(error)) {
            throw error;
          }
        }
      }

      throw new Error('Could not allocate a unique referral code.');
    },

    async getReferralCode(subscriberId) {
      return repository.findCode(subscriberId);
    },

    async lookupCode(code) {
      return repository.findSubscriberIdByCode(code);
    },
  };
}

function isDatabasePool(
  database: DatabaseConnection | DatabasePool,
): database is DatabasePool {
  return 'connect' in database;
}

function isReferralCodeCollision(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
