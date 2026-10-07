import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

/**
 * A single fixed-window counter backed by `rate_limit_bucket`.
 *
 * `consumeRateLimit` records one hit against `key` and returns the resulting
 * count for the current window. The upsert is atomic and serialises concurrent
 * callers on the bucket row, which is what lets the signup route guarantee
 * exactly one verification email under a genuine concurrent double-submit
 * (`docs/data/model.md#rate_limit_bucket`). The SQL itself lives in the data
 * layer (`server/db/rate-limit-bucket.ts`); this module owns only the window
 * arithmetic and the transaction that makes the read reflect this hit. E5-03
 * adds per-identity velocity flags on top; the shared cleanup sweep is
 * batch-capped and lives with the retention jobs.
 */
export async function consumeRateLimit(
  database: DatabasePool,
  key: string,
  windowMs: number,
  now: Date,
): Promise<number> {
  const windowThreshold = new Date(now.getTime() - windowMs);
  return withTransaction(database, (connection) =>
    createRateLimitBucketRepository(connection).consume(
      key,
      now,
      windowThreshold,
    ),
  );
}

export async function consumeRateLimitWithWindow(
  database: DatabasePool,
  key: string,
  windowMs: number,
  now: Date,
): Promise<{ count: number; windowStart: Date }> {
  const windowThreshold = new Date(now.getTime() - windowMs);

  return withTransaction(database, (connection) =>
    createRateLimitBucketRepository(connection).consumeWithWindow(
      key,
      now,
      windowThreshold,
    ),
  );
}
