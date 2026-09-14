import type { DatabasePool } from '../db/pool.ts';
import type { Alert } from '../verification-rate/p1-webhook.ts';

import {
  createReferralService,
  referralCounterRepairMaximumLimit,
  type ReferralCounterRepairResult,
} from './service.ts';

export interface ReferralCounterRepairDependencies {
  readonly alert: (alert: Alert) => Promise<void> | void;
  readonly clock?: () => Date;
}

export interface ReferralCounterRepairJob {
  run(limit: number): Promise<ReferralCounterRepairResult>;
}

/** Rebuilds denormalised referral counters from their authoritative tables. */
export function createReferralCounterRepairJob(
  database: DatabasePool,
  dependencies: ReferralCounterRepairDependencies,
): ReferralCounterRepairJob {
  const clock = dependencies.clock ?? (() => new Date());
  const referral = createReferralService(database);

  return {
    async run(limit) {
      if (limit > referralCounterRepairMaximumLimit) {
        throw new RangeError(
          `A counter repair limit must be no greater than ${referralCounterRepairMaximumLimit}.`,
        );
      }
      const result = await referral.recomputeCounters(limit);
      if (result.corrected !== 0) {
        await dependencies.alert({
          detail: { checked: result.checked, corrected: result.corrected },
          event: 'referral_counters_corrected',
          occurredAt: clock(),
          severity: 'P2',
        });
      }
      return result;
    },
  };
}
