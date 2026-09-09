import type { DatabaseConnection } from '../db/pool.ts';
import { createSubscriberMaintenanceRepository } from '../db/subscriber-maintenance.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

export const unverifiedExpiryHorizonMs = 30 * DAY_MS;

export interface UnverifiedExpiryJob {
  run(limit: number): Promise<number>;
}

export interface UnverifiedExpiryDependencies {
  readonly clock?: () => Date;
  readonly horizonMs?: number;
}

export function createUnverifiedExpiryJob(
  database: DatabaseConnection,
  dependencies: UnverifiedExpiryDependencies = {},
): UnverifiedExpiryJob {
  const clock = dependencies.clock ?? (() => new Date());
  const horizonMs =
    dependencies.horizonMs === undefined
      ? unverifiedExpiryHorizonMs
      : dependencies.horizonMs;

  if (!Number.isFinite(horizonMs) || horizonMs <= 0) {
    throw new RangeError('The unverified expiry horizon must be positive.');
  }

  const repository = createSubscriberMaintenanceRepository(database);
  return {
    async run(limit) {
      const now = clock();
      const before = new Date(now.getTime() - horizonMs);
      return repository.expirePending(before, now, limit);
    },
  };
}
