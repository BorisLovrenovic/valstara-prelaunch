import { createAuditService } from '../audit/service.ts';
import { ConfigurationError, getGiveawayEntryPeriodStart } from '../config.ts';
import { createGiveawayEntryRepository } from '../db/giveaway-entry.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createTransactionalEmailProducers } from '../email/producers.ts';
import type { FlagService } from '../flags/types.ts';

import {
  createGiveawayAccrualServiceInTransaction,
  giveawayEntryPeriodEnd,
  type CurrentGiveawayRules,
} from './accrue.ts';

export const giveawayReconciliationMaximumLimit = 1_000;

export function createGiveawayEntryReconciliationJob(
  database: DatabasePool,
  flags: Pick<FlagService, 'isEnabled'>,
  currentRules: () => Promise<CurrentGiveawayRules>,
  periodStart: Date | null = getGiveawayEntryPeriodStart(),
  clock: () => Date = () => new Date(),
  onEntry?: (method: 'base' | 'referral') => void,
): { run(limit: number): Promise<{ checked: number; accrued: number }> } {
  const receipt = createTransactionalEmailProducers(database, clock).receipt;
  return {
    async run(limit) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > giveawayReconciliationMaximumLimit
      ) {
        throw new RangeError(
          'Giveaway reconciliation limit must be 1 to 1000.',
        );
      }
      const entered: ('base' | 'referral')[] = [];
      const result = await withTransaction(database, async (connection) => {
        const enabled = await flags.isEnabled('giveaway.open');
        if (enabled && periodStart === null) {
          throw new ConfigurationError(
            'WAITLIST_LIVE_AT',
            'is required while giveaway.open is on',
          );
        }
        const candidates = enabled
          ? await createGiveawayEntryRepository(connection).missingEntitlements(
              periodStart!,
              giveawayEntryPeriodEnd,
              limit,
            )
          : [];
        const rules = candidates.length > 0 ? await currentRules() : null;
        let accrued = 0;
        if (rules !== null) {
          const service = createGiveawayAccrualServiceInTransaction(
            connection,
            flags,
            () => rules,
            periodStart,
            receipt,
          );
          for (const candidate of candidates) {
            if (
              await service.accrue(
                candidate.subscriberId,
                candidate.method,
                candidate.sourceEdgeId ?? undefined,
              )
            ) {
              accrued += 1;
              entered.push(candidate.method);
            }
          }
        }
        await createAuditService(connection).record({
          action: 'giveaway.entries_backfilled',
          actor: 'system:giveaway-reconciliation',
          subjectId: 'giveaway-entry-ledger',
          subjectType: 'giveaway_entry',
          detail: { checked: candidates.length, accrued, limit, enabled },
        });
        return { checked: candidates.length, accrued };
      });
      for (const method of entered) {
        try {
          onEntry?.(method);
        } catch {
          /* Ledger commit is authoritative. */
        }
      }
      return result;
    },
  };
}
