import { randomBytes, randomUUID } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
import {
  getReferralAttributionConfiguration,
  type ReferralAttributionConfiguration,
} from '../config.ts';
import { createCampaignFlagRepository } from '../db/campaign-flags.ts';
import { createReferralAttributionHealthRepository } from '../db/referral-attribution-health.ts';
import {
  createReferralRepository,
  type ReferralRepository,
} from '../db/referral.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import { createReferralCodeRepository } from '../db/referral-code.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createFlagServiceWithDependencies } from '../flags/service.ts';

import { referralCodeAlphabet, referralCodeLength } from './config.ts';
import { normaliseReferralCodeForLookup } from './code-registry.ts';
import { rewardStateAtConfirmation } from './reward-state.ts';
import {
  recomputeReferralRewards,
  referralRewardConfiguration,
  type ReferralRewardConfiguration,
} from './rewards.ts';
import { computeReferralStatus, type ReferralStatus } from './status.ts';
import {
  createReferralAttributionHealth,
  type ReferralAttributionHealth,
} from './attribution-health.ts';

const maximumCodeAttempts = 10;
export const referralCounterRepairMaximumLimit = 1_000;

export interface ReferralServiceDependencies {
  readonly attributionConfiguration?: ReferralAttributionConfiguration;
  readonly isReferralEnabled?: () => Promise<boolean>;
  readonly clock?: () => Date;
  readonly createCode?: () => string;
  /** The coupon ladder and wave-1 figures (E11.7-03); configuration. */
  readonly rewards?: ReferralRewardConfiguration;
}

export interface ReferralCounterRepairResult {
  readonly checked: number;
  readonly corrected: number;
}

export type AttributeResult =
  | { readonly kind: 'attributed' }
  | { readonly kind: 'self_referral' }
  | { readonly kind: 'unattributed' };

export interface ReferralService {
  attributionHealth(): Promise<ReferralAttributionHealth>;
  attribute(
    referredId: string,
    code: string,
    allowAttribution?: boolean,
  ): Promise<AttributeResult>;
  /** New confirmed edge's settled referrer tier; null on a no-op. */
  confirm(referredId: string, now: Date): Promise<number | null>;
  generateCode(subscriberId: string): Promise<string>;
  getReferralCode(subscriberId: string): Promise<string | null>;
  lookupCode(code: string): Promise<string | null>;
  recomputeCounters(limit: number): Promise<ReferralCounterRepairResult>;
  status(subscriberId: string): Promise<ReferralStatus>;
}

/**
 * Referral operations used by E3-07's verification transaction. Attribution,
 * signed refs and confirmation rewards live here.
 */
export function createReferralService(
  database: DatabaseConnection | DatabasePool,
  dependencies: ReferralServiceDependencies = {},
): ReferralService {
  const createCode = dependencies.createCode ?? createReferralCode;
  const rewards = dependencies.rewards ?? referralRewardConfiguration;
  const clock = dependencies.clock ?? (() => new Date());
  const flagService = createFlagServiceWithDependencies(
    createCampaignFlagRepository(database),
    async () => {
      throw new Error('Referral health flag reader is read-only.');
    },
    { now: () => clock().getTime() },
  );
  const attributionHealth = createReferralAttributionHealth(
    createReferralAttributionHealthRepository(database),
    dependencies.attributionConfiguration ??
      getReferralAttributionConfiguration(),
    dependencies.isReferralEnabled ??
      (() => flagService.isEnabled('referral.enabled')),
    clock,
  );
  return createReferralServiceWithRepository(
    createReferralRepository(database),
    createCode,
    rewards,
    clock,
    isDatabasePool(database)
      ? (operation) =>
          withTransaction(database, async (connection) => operation(connection))
      : async (operation) => operation(database),
    attributionHealth,
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
  rewards: ReferralRewardConfiguration,
  clock: () => Date,
  runTransaction: ReferralTransaction,
  attributionHealth: () => Promise<ReferralAttributionHealth>,
): ReferralService {
  return {
    attributionHealth,
    async attribute(referredId, code, allowAttribution = true) {
      return runTransaction(async (connection) => {
        const transactionalRepository = createReferralRepository(connection);
        const referrerId = await transactionalRepository.findSubscriberIdByCode(
          normaliseReferralCodeForLookup(code),
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
          throw new Error(
            'Referral attribution could not assign its referrer.',
          );
        }
        return { kind: 'attributed' };
      });
    },
    async confirm(referredId, now) {
      return runTransaction(async (connection) => {
        const transactionalRepository = createReferralRepository(connection);
        const edge =
          await transactionalRepository.findEdgeForConfirmation(referredId);
        if (edge === null) {
          return null;
        }

        // Serialising confirmations for one referrer ensures two real people
        // verifying together each see the other's edge in the recompute.
        const current = await transactionalRepository.lockSubscriber(
          edge.referrer_id,
        );
        if (current === null) {
          throw new Error('The referral edge referrer could not be read.');
        }

        const confirmed = await transactionalRepository.confirmEdge(
          referredId,
          rewardStateAtConfirmation('cheap'),
          now,
        );
        if (confirmed !== 1) {
          throw new Error('The referral edge could not be confirmed.');
        }

        // The ladder and wave 1 are derived state, recomputed from the
        // referrer's confirmed, non-voided edges in this transaction (E11.7-03).
        await recomputeReferralRewards(connection, edge.referrer_id, {
          actor: 'system:referral-confirmation',
          configuration: rewards,
          now,
        });
        return transactionalRepository.findSettledReferralTier(
          edge.referrer_id,
        );
      });
    },

    async generateCode(subscriberId) {
      return runTransaction(async (connection) => {
        const transactionalRepository = createReferralRepository(connection);
        const registry = createReferralCodeRepository(connection);
        // The row lock serialises concurrent allocation for one subscriber, so
        // a replay waits and then returns the code the first call assigned.
        const subscriber =
          await transactionalRepository.lockSubscriber(subscriberId);
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
          // The shared registry (E11.7-01) is the one namespace for member and
          // partner codes: a code any owner holds, in any case, is regenerated.
          if (!(await registry.claimMemberCode(code, subscriberId))) {
            continue;
          }
          if (
            (await transactionalRepository.assignReferralCode(
              subscriberId,
              code,
            )) !== 1
          ) {
            throw new Error('The claimed referral code could not be assigned.');
          }
          return code;
        }

        throw new Error('Could not allocate a unique referral code.');
      });
    },

    async getReferralCode(subscriberId) {
      return repository.findCode(subscriberId);
    },

    async lookupCode(code) {
      return repository.findSubscriberIdByCode(
        normaliseReferralCodeForLookup(code),
      );
    },

    async recomputeCounters(limit) {
      assertCounterRepairLimit(limit);
      return runTransaction(async (connection) => {
        const transactionalRepository = createReferralRepository(connection);
        const subscriberIds =
          await transactionalRepository.findSubscriberIdsForCounterRepair(
            limit,
          );
        let corrected = 0;
        const now = clock();
        for (const subscriberId of subscriberIds) {
          const recomputed = await recomputeReferralRewards(
            connection,
            subscriberId,
            {
              actor: 'system:referral-counter-repair',
              configuration: rewards,
              now,
            },
          );
          if (recomputed.changed) {
            corrected += 1;
          }
        }
        await createAuditService(connection).record({
          action: 'referral.counters_repaired',
          actor: 'system:referral-counter-repair',
          detail: { checked: subscriberIds.length, corrected, limit },
          subjectId: 'daily',
          subjectType: 'referral_counter_repair',
        });
        return { checked: subscriberIds.length, corrected };
      });
    },

    async status(subscriberId) {
      const subscriber = await repository.findSubscriber(subscriberId);
      if (
        subscriber === null ||
        subscriber.status !== 'verified' ||
        subscriber.referral_code === null
      ) {
        throw new Error(
          'Referral status requires a verified subscriber with a referral code.',
        );
      }

      const [giveawayEntries, ownRank] = await Promise.all([
        repository.findGiveawayEntryTotal(subscriberId),
        repository.findOwnReferralRank(subscriberId),
      ]);

      return computeReferralStatus(
        subscriber.confirmed_referrals,
        subscriber.referral_code,
        {
          accessWindow: subscriber.access_window,
          giveawayEntries,
          ownRank,
          verificationOrderWindow: subscriber.verification_order_window,
        },
      );
    },
  };
}

function assertCounterRepairLimit(limit: number): void {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > referralCounterRepairMaximumLimit
  ) {
    throw new RangeError(
      `A counter repair limit must be between 1 and ${referralCounterRepairMaximumLimit}.`,
    );
  }
}

function isDatabasePool(
  database: DatabaseConnection | DatabasePool,
): database is DatabasePool {
  return 'connect' in database;
}
