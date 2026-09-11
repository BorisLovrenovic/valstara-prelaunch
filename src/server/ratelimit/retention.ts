import type { DatabaseConnection } from '../db/pool.ts';
import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';

export const rateLimitBucketRetentionDays = 7;

export interface RateLimitRetentionDependencies {
  readonly clock?: () => Date;
}

export interface RateLimitRetentionJob {
  run(limit: number): Promise<number>;
}

export function createRateLimitRetentionJob(
  database: DatabaseConnection,
  dependencies: RateLimitRetentionDependencies = {},
): RateLimitRetentionJob {
  const clock = dependencies.clock ?? (() => new Date());
  const repository = createRateLimitBucketRepository(database);

  return {
    run(limit) {
      const before = new Date(
        clock().getTime() - rateLimitBucketRetentionDays * 24 * 60 * 60 * 1_000,
      );
      return repository.purgeOlderThan(before, limit);
    },
  };
}
