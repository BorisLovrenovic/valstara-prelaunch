import { randomUUID } from 'node:crypto';

import { getGiveawayEntryPeriodStart } from '../config.ts';
import { createGiveawayEntryRepository } from '../db/giveaway-entry.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import {
  createTransactionalEmailProducers,
  type TransactionalEmailProducers,
} from '../email/producers.ts';
import type { FlagService } from '../flags/types.ts';

import { createGiveawayEligibilityService } from './eligibility.ts';

export interface CurrentGiveawayRules {
  rulesVersion: string;
  sha256: string;
}

export const giveawayEntryPeriodEnd = new Date('2027-03-02T00:00:00.000Z');

export interface GiveawayAccrualService {
  accrue(
    subscriberId: string,
    method: 'base' | 'referral',
    sourceEdgeId?: string,
  ): Promise<boolean>;
  accrueForVerification(
    referredId: string,
  ): Promise<readonly ('base' | 'referral')[]>;
}

export function createGiveawayAccrualService(
  database: DatabasePool,
  flags: Pick<FlagService, 'isEnabled'>,
  currentRules: () => CurrentGiveawayRules,
  periodStart: Date | null = getGiveawayEntryPeriodStart(),
  clock: () => Date = () => new Date(),
  receiptEmail?: TransactionalEmailProducers['receipt'],
  onEntry?: (method: 'base' | 'referral') => void,
): GiveawayAccrualService {
  const receipt =
    receiptEmail ?? createTransactionalEmailProducers(database, clock).receipt;
  return {
    async accrue(subscriberId, method, sourceEdgeId) {
      const inserted = await withTransaction(database, (connection) =>
        createGiveawayAccrualServiceInTransaction(
          connection,
          flags,
          currentRules,
          periodStart,
          receipt,
        ).accrue(subscriberId, method, sourceEdgeId),
      );
      if (inserted) {
        try {
          onEntry?.(method);
        } catch {
          /* Analytics never affects entry accrual. */
        }
      }
      return inserted;
    },
    async accrueForVerification(referredId) {
      const methods = await withTransaction(database, (connection) =>
        createGiveawayAccrualServiceInTransaction(
          connection,
          flags,
          currentRules,
          periodStart,
          receipt,
        ).accrueForVerification(referredId),
      );
      for (const method of methods) {
        try {
          onEntry?.(method);
        } catch {
          /* Analytics never affects entry accrual. */
        }
      }
      return methods;
    },
  };
}

/** Use only from a caller that already owns the surrounding transaction. */
export function createGiveawayAccrualServiceInTransaction(
  database: DatabaseConnection,
  flags: Pick<FlagService, 'isEnabled'>,
  currentRules: () => CurrentGiveawayRules,
  periodStart: Date | null = getGiveawayEntryPeriodStart(),
  receipt?: (
    connection: DatabaseConnection,
    subscriberId: string,
    rulesVersion: string,
  ) => Promise<boolean>,
): GiveawayAccrualService {
  const repository = createGiveawayEntryRepository(database);
  const eligibility = createGiveawayEligibilityService(database, flags);

  async function accrue(
    subscriberId: string,
    method: 'base' | 'referral',
    sourceEdgeId?: string,
  ): Promise<boolean> {
    if (!(await eligibility.isEligible(subscriberId))) return false;
    if (periodStart === null) return false;
    if ((method === 'base') !== (sourceEdgeId === undefined)) {
      throw new TypeError(
        'A referral entry requires an edge; a base entry cannot carry one.',
      );
    }
    const subscriber = await repository.lockSubscriber(subscriberId);
    if (subscriber?.status !== 'verified') return false;
    if (
      subscriber.verifiedAt === null ||
      subscriber.verifiedAt < periodStart ||
      subscriber.verifiedAt >= giveawayEntryPeriodEnd
    )
      return false;
    if (
      sourceEdgeId !== undefined &&
      !(await repository.confirmedEdgeBelongsTo(
        sourceEdgeId,
        subscriberId,
        periodStart,
        giveawayEntryPeriodEnd,
      ))
    )
      return false;

    const rules = currentRules();
    if (!/^[a-f0-9]{64}$/u.test(rules.sha256)) {
      throw new Error('The current giveaway rules hash is invalid.');
    }
    const alreadyEnteredUnderVersion = await repository.hasEntryForRulesVersion(
      subscriberId,
      rules.rulesVersion,
    );
    const inserted = await repository.insertEntry({
      id: randomUUID(),
      subscriberId,
      method,
      sourceEdgeId: sourceEdgeId ?? null,
      rulesVersion: rules.rulesVersion,
      rulesSha256: Buffer.from(rules.sha256, 'hex'),
    });
    if (
      inserted === 1 &&
      subscriber.giveawayRulesVersion === null &&
      (await repository.stampFirstRulesVersion(
        subscriberId,
        rules.rulesVersion,
      )) !== 1
    ) {
      throw new Error(
        'The subscriber first-entry rules version could not be recorded.',
      );
    }
    if (
      inserted === 1 &&
      !alreadyEnteredUnderVersion &&
      receipt !== undefined
    ) {
      await receipt(database, subscriberId, rules.rulesVersion);
    }
    return inserted === 1;
  }

  return {
    accrue,
    async accrueForVerification(referredId) {
      if (!(await flags.isEnabled('giveaway.open'))) return [];
      const methods: ('base' | 'referral')[] = [];
      if (await accrue(referredId, 'base')) methods.push('base');
      const edge = await repository.confirmedEdgeFor(referredId);
      if (edge !== null && (await accrue(edge.referrerId, 'referral', edge.id)))
        methods.push('referral');
      return methods;
    },
  };
}
