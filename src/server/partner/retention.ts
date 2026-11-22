import {
  createPartnerRepository,
  partnerPurgeBatchLimit,
} from '../db/partner.ts';
import type { DatabaseConnection } from '../db/pool.ts';

import { partnerApplicationRetentionMs } from './config.ts';

export interface PartnerApplicationPurgeDependencies {
  readonly clock?: () => Date;
  readonly retentionMs?: number;
}

/**
 * The daily retention purge (E11.7-05): rejected and unconfirmed
 * applications have their personal fields and member link cleared once they
 * have been in that state for the configured 90 days. It follows the existing
 * purge-job pattern: a batch-capped run the scheduler records in
 * `purge_job_run` as `partner_application_purge`. The row itself, with its
 * status, type and timestamps, stays for the programme's counts.
 */
export function createPartnerApplicationPurgeJob(
  database: DatabaseConnection,
  dependencies: PartnerApplicationPurgeDependencies = {},
): { run(limit: number): Promise<number> } {
  const clock = dependencies.clock ?? (() => new Date());
  const retentionMs = dependencies.retentionMs ?? partnerApplicationRetentionMs;
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    throw new RangeError('The partner application retention must be positive.');
  }
  return {
    run(limit) {
      const now = clock();
      return createPartnerRepository(database).purgeRetired(
        new Date(now.getTime() - retentionMs),
        now,
        Math.min(limit, partnerPurgeBatchLimit),
      );
    },
  };
}
