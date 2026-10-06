import type { DatabaseConnection } from './pool.ts';

export interface AttributionCounts {
  readonly signups: number;
  readonly attributed: number;
}

interface AttributionCountsRow {
  readonly current_signups: string;
  readonly current_attributed: string;
  readonly baseline_signups: string;
  readonly baseline_attributed: string;
}

export interface ReferralAttributionHealthRepository {
  counts(
    baselineFrom: Date,
    currentFrom: Date,
    until: Date,
  ): Promise<{
    readonly baseline: AttributionCounts;
    readonly current: AttributionCounts;
  }>;
}

export function createReferralAttributionHealthRepository(
  database: DatabaseConnection,
): ReferralAttributionHealthRepository {
  return {
    async counts(baselineFrom, currentFrom, until) {
      const row = await database.readOne<AttributionCountsRow>({
        text: `SELECT
          COUNT(*) FILTER (WHERE s.created_at >= $2)::text AS current_signups,
          COUNT(e.id) FILTER (WHERE s.created_at >= $2)::text AS current_attributed,
          COUNT(*) FILTER (WHERE s.created_at < $2)::text AS baseline_signups,
          COUNT(e.id) FILTER (WHERE s.created_at < $2)::text AS baseline_attributed
          FROM subscriber s
          LEFT JOIN referral_edge e ON e.referred_id = s.id
          WHERE s.created_at >= $1 AND s.created_at < $3`,
        values: [baselineFrom, currentFrom, until],
      });
      return {
        baseline: {
          signups: Number(row?.baseline_signups ?? 0),
          attributed: Number(row?.baseline_attributed ?? 0),
        },
        current: {
          signups: Number(row?.current_signups ?? 0),
          attributed: Number(row?.current_attributed ?? 0),
        },
      };
    },
  };
}
