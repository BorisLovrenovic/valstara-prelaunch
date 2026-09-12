import { randomBytes, randomUUID } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
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
  milestoneReachedAtConfirmation,
  type MilestoneTier,
  promoteAccessWindow,
} from './config.ts';

const maximumCodeAttempts = 10;
export const milestoneBackfillMaximumLimit = 100;

export interface ReferralServiceDependencies {
  readonly createCode?: () => string;
  readonly tiers?: readonly MilestoneTier[];
}

export interface MilestoneBackfillResult {
  readonly awarded: number;
  readonly checked: number;
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
  backfillTier(
    tier: number,
    actor: string,
    limit: number,
    now: Date,
  ): Promise<MilestoneBackfillResult>;
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
  const tiers = dependencies.tiers ?? milestoneTiers;
  return createReferralServiceWithRepository(
    createReferralRepository(database),
    createCode,
    tiers,
    isDatabasePool(database)
      ? (operation) =>
          withTransaction(database, async (connection) => operation(connection))
      : async (operation) => operation(database),
  );
}

type ReferralTransaction = <Result>(
  operation: (connection: DatabaseConnection) => Promise<Result>,
) => Promise<Result>;

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
  tiers: readonly MilestoneTier[],
  runTransaction: ReferralTransaction,
): ReferralService {
  return {
    async attribute(referredId, code, allowAttribution = true) {
      return runTransaction(async (connection) => {
        const transactionalRepository = createReferralRepository(connection);
        const referrerId =
          await transactionalRepository.findSubscriberIdByCode(code);
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
          throw new Error(
            'Referral attribution could not assign its referrer.',
          );
        }
        return { kind: 'attributed' };
      });
    },
    async backfillTier(tierNumber, actor, limit, now) {
      if (actor.trim() === '') {
        throw new RangeError('A milestone backfill requires a human actor.');
      }
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > milestoneBackfillMaximumLimit
      ) {
        throw new RangeError(
          `A milestone backfill limit must be between 1 and ${milestoneBackfillMaximumLimit}.`,
        );
      }
      const tier = tiers.find(
        (candidate) => candidate.enabled && candidate.number === tierNumber,
      );
      if (tier === undefined) {
        throw new RangeError('A milestone backfill requires an enabled tier.');
      }

      return runTransaction(async (connection) => {
        const transactionalRepository = createReferralRepository(connection);
        const candidateIds =
          await transactionalRepository.findMilestoneBackfillCandidateIds(
            tier.number,
            tier.threshold,
            limit,
          );
        let awarded = 0;

        for (const subscriberId of candidateIds) {
          const subscriber =
            await transactionalRepository.findSubscriber(subscriberId);
          if (subscriber === null) {
            throw new Error(
              'A milestone backfill subscriber could not be read.',
            );
          }
          const previousSettledTier =
            await transactionalRepository.findSettledReferralTier(subscriberId);
          if (
            await awardMilestone(
              transactionalRepository,
              subscriberId,
              tier,
              now,
            )
          ) {
            awarded += 1;
            if (subscriber.access_window !== null) {
              await transactionalRepository.setAccessWindow(
                subscriberId,
                promoteAccessWindow(
                  subscriber.access_window,
                  tier.number - previousSettledTier,
                ),
              );
            }
          }
          const settledTier =
            await transactionalRepository.findSettledReferralTier(subscriberId);
          const confirmedReferrals =
            await transactionalRepository.countConfirmedEdges(subscriberId);
          await transactionalRepository.setReferralCounterAndTier(
            subscriberId,
            confirmedReferrals,
            settledTier,
          );
        }

        await createAuditService(connection).record({
          action: 'referral.milestone_backfilled',
          actor,
          detail: {
            awarded,
            checked: candidateIds.length,
            limit,
          },
          subjectId: String(tier.number),
          subjectType: 'referral_tier',
        });
        return { awarded, checked: candidateIds.length };
      });
    },
    async confirm(referredId, now) {
      await runTransaction(async (connection) => {
        const transactionalRepository = createReferralRepository(connection);
        const edge =
          await transactionalRepository.findEdgeForConfirmation(referredId);
        if (edge === null) {
          return;
        }

        // Serialising confirmations for one referrer ensures two real people
        // verifying together cannot both skip over an exact tier threshold.
        const current = await transactionalRepository.lockSubscriber(
          edge.referrer_id,
        );
        if (current === null) {
          throw new Error('The referral edge referrer could not be read.');
        }

        const confirmed = await transactionalRepository.confirmEdge(
          referredId,
          now,
        );
        if (confirmed !== 1) {
          throw new Error('The referral edge could not be confirmed.');
        }

        const confirmedReferrals =
          await transactionalRepository.countConfirmedEdges(edge.referrer_id);
        const previousSettledTier =
          await transactionalRepository.findSettledReferralTier(
            edge.referrer_id,
          );
        const reachedTier = milestoneReachedAtConfirmation(
          confirmedReferrals,
          tiers,
        );
        if (
          reachedTier !== null &&
          (await awardMilestone(
            transactionalRepository,
            edge.referrer_id,
            reachedTier,
            now,
          ))
        ) {
          if (current.access_window !== null) {
            await transactionalRepository.setAccessWindow(
              edge.referrer_id,
              promoteAccessWindow(
                current.access_window,
                reachedTier.number - previousSettledTier,
              ),
            );
          }
        }

        const settledTier =
          await transactionalRepository.findSettledReferralTier(
            edge.referrer_id,
          );
        await transactionalRepository.setReferralCounterAndTier(
          edge.referrer_id,
          confirmedReferrals,
          settledTier,
        );
      });
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

async function awardMilestone(
  repository: ReferralRepository,
  subscriberId: string,
  tier: MilestoneTier,
  now: Date,
): Promise<boolean> {
  // The settled wave upgrade is the tier-progress record. Inserting it first
  // makes the database constraint the arbiter for exactly-once evaluation.
  const inserted = await repository.insertMilestoneAward(
    randomUUID(),
    subscriberId,
    tier.number,
    'wave_upgrade',
    'settled',
    now,
  );
  if (inserted === 0) {
    return false;
  }
  if (tier.discountPercent > 0) {
    await repository.insertMilestoneAward(
      randomUUID(),
      subscriberId,
      tier.number,
      'discount',
      'held',
      now,
    );
  }
  if (tier.bonusEntries > 0) {
    await repository.insertMilestoneAward(
      randomUUID(),
      subscriberId,
      tier.number,
      'entries',
      'held',
      now,
    );
  }
  return true;
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
