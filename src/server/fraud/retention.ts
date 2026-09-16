import type { DatabasePool } from '../db/pool.ts';
import { createFraudService } from './service.ts';

export const ipPrefixRetentionDays = 90;

export function createIpPrefixRetentionJob(
  database: DatabasePool,
  dependencies: { readonly clock?: () => Date } = {},
): { run(limit: number): Promise<number> } {
  const clock = dependencies.clock ?? (() => new Date());
  return {
    run(limit) {
      return createFraudService(database).purgeIpHashes(
        new Date(
          clock().getTime() - ipPrefixRetentionDays * 24 * 60 * 60 * 1_000,
        ),
        limit,
      );
    },
  };
}
