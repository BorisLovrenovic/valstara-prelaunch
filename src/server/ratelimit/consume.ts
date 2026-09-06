import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

/**
 * A single fixed-window counter backed by `rate_limit_bucket`.
 *
 * `consumeRateLimit` records one hit against `key` and returns the resulting
 * count for the current window. The upsert is atomic and serialises concurrent
 * callers on the bucket row, which is what lets the signup route guarantee
 * exactly one verification email under a genuine concurrent double-submit
 * (`docs/data/model.md#rate_limit_bucket`). E5-03 adds per-identity velocity
 * flags on top; the shared cleanup sweep is batch-capped and lives with the
 * retention jobs.
 */
export async function consumeRateLimit(
  database: DatabasePool,
  key: string,
  windowMs: number,
  now: Date,
): Promise<number> {
  const windowThreshold = new Date(now.getTime() - windowMs);

  return withTransaction(database, async (connection) => {
    await connection.execute({
      text: `
        INSERT INTO rate_limit_bucket (key, window_start, count)
        VALUES ($1, $2, 1)
        ON CONFLICT (key) DO UPDATE
        SET window_start = CASE
              WHEN rate_limit_bucket.window_start <= $3 THEN EXCLUDED.window_start
              ELSE rate_limit_bucket.window_start
            END,
            count = CASE
              WHEN rate_limit_bucket.window_start <= $3 THEN 1
              ELSE rate_limit_bucket.count + 1
            END
      `,
      values: [key, now, windowThreshold],
    });

    const row = await connection.readOne<{ count: number }>({
      text: 'SELECT count FROM rate_limit_bucket WHERE key = $1',
      values: [key],
    });

    if (row === null) {
      throw new Error('Rate-limit counter did not return a count.');
    }

    return row.count;
  });
}
