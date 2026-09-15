import type { DatabaseConnection } from './pool.ts';

export interface DuplicateIdentityMatch {
  readonly id: string;
  readonly local_part: string;
  readonly match_count: string;
}

export interface DuplicateIdentityLookup {
  readonly limit: number;
  readonly subscriberId: string;
}

/**
 * Finds only the bounded evidence needed by the fraud review queue. The window
 * count reports the complete number of matches while `list()` and the SQL
 * limit cap the identifiers returned to application memory.
 */
export async function findDuplicateIdentityMatches(
  database: DatabaseConnection,
  input: DuplicateIdentityLookup,
): Promise<readonly DuplicateIdentityMatch[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new RangeError('A duplicate-identity lookup limit must be positive.');
  }

  return database.list<DuplicateIdentityMatch>(
    {
      text: `
        WITH subject AS (
          SELECT
            id,
            email_domain,
            split_part(email_normalised, '@', 1) AS local_part
          FROM subscriber
          WHERE id = $1
        )
        SELECT
          candidate.id::text,
          subject.local_part,
          COUNT(*) OVER ()::text AS match_count
        FROM subscriber candidate
        CROSS JOIN subject
        WHERE split_part(candidate.email_normalised, '@', 1) = subject.local_part
          AND candidate.email_domain <> subject.email_domain
          AND candidate.id <> subject.id
        ORDER BY candidate.created_at, candidate.id
      `,
      values: [input.subscriberId],
    },
    input.limit,
  );
}
