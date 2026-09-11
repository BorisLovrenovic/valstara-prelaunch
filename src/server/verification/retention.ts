import type { DatabasePool } from '../db/pool.ts';

import { createVerificationService } from './service.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
export const verificationTokenPostExpiryRetentionMs = 30 * DAY_MS;

export interface VerificationTokenRetentionDependencies {
  readonly clock?: () => Date;
}

export function createVerificationTokenRetentionJob(
  database: DatabasePool,
  dependencies: VerificationTokenRetentionDependencies = {},
): { run(limit: number): Promise<number> } {
  const clock = dependencies.clock ?? (() => new Date());
  return {
    run(limit) {
      const before = new Date(
        clock().getTime() - verificationTokenPostExpiryRetentionMs,
      );
      return createVerificationService(database).purgeExpired(before, limit);
    },
  };
}
