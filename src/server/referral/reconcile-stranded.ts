import { createReferralRepository } from '../db/referral.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createTransactionalEmailProducers } from '../email/producers.ts';

import { createReferralService } from './service.ts';

export interface StrandedReferralReconciliationDependencies {
  readonly clock?: () => Date;
}

/** Repairs only the legacy shape created by the former flag-off completion bug. */
export function createStrandedReferralReconciliationJob(
  database: DatabasePool,
  dependencies: StrandedReferralReconciliationDependencies = {},
): { run(limit: number): Promise<number> } {
  const clock = dependencies.clock ?? (() => new Date());
  const milestone = createTransactionalEmailProducers(
    database,
    clock,
  ).milestone;
  return {
    async run(limit) {
      const referredIds =
        await createReferralRepository(
          database,
        ).findStrandedVerifiedReferralIds(limit);
      for (const referredId of referredIds) {
        await withTransaction(database, async (connection) => {
          await createReferralService(connection, {
            milestoneEmail: milestone,
          }).confirm(referredId, clock());
        });
      }
      return referredIds.length;
    },
  };
}
