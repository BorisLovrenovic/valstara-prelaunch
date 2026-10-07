import type { DatabaseConnection } from './pool.ts';

export interface RateLimitBucketRepository {
  consume(key: string, now: Date, windowThreshold: Date): Promise<number>;
  consumeWithWindow(
    key: string,
    now: Date,
    windowThreshold: Date,
  ): Promise<{ count: number; windowStart: Date }>;
  purgeOlderThan(before: Date, limit: number): Promise<number>;
}

/**
 * The data layer for the fixed-window counter in `rate_limit_bucket`. The SQL
 * lives here — `src/server/db` is the only place it may (`docs/architecture/
 * modules.md`). The upsert is atomic and serialises concurrent callers on the
 * bucket row, and the caller runs both statements inside one transaction so the
 * read reflects this caller's own increment.
 */
export function createRateLimitBucketRepository(
  database: DatabaseConnection,
): RateLimitBucketRepository {
  async function consumeWithWindow(
    key: string,
    now: Date,
    windowThreshold: Date,
  ): Promise<{ count: number; windowStart: Date }> {
    await database.execute({
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

    const row = await database.readOne<{
      count: number;
      window_start: Date;
    }>({
      text: 'SELECT count, window_start FROM rate_limit_bucket WHERE key = $1',
      values: [key],
    });

    if (row === null) {
      throw new Error('Rate-limit counter did not return a count.');
    }

    return { count: row.count, windowStart: row.window_start };
  }

  return {
    async consume(key, now, windowThreshold) {
      return (await consumeWithWindow(key, now, windowThreshold)).count;
    },
    consumeWithWindow,
    async purgeOlderThan(before, limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('A rate-limit retention limit must be positive.');
      }

      return database.execute({
        text: `
          DELETE FROM rate_limit_bucket
          WHERE key IN (
            SELECT key
            FROM rate_limit_bucket
            WHERE window_start < $1
            ORDER BY window_start, key
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
        `,
        values: [before, limit],
      });
    },
  };
}
