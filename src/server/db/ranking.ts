import type { DatabaseConnection } from './pool.ts';

export interface RankedCandidateRow {
  readonly rank: number;
  readonly score: number;
  readonly subscriber_id: string;
}

export interface RankingRepository {
  listLeaderboardCandidates(
    limit: number,
  ): Promise<readonly RankedCandidateRow[]>;
  listPrizeCandidates(limit: number): Promise<readonly RankedCandidateRow[]>;
}

export function createRankingRepository(
  database: DatabaseConnection,
): RankingRepository {
  return {
    listLeaderboardCandidates(limit) {
      return database.list<RankedCandidateRow>(
        {
          text: `
            WITH eligible AS (
              SELECT
                subscriber.id,
                subscriber.confirmed_referrals AS score,
                subscriber.verified_at
              FROM subscriber
              WHERE subscriber.status = 'verified'
                AND NOT EXISTS (
                  SELECT 1
                  FROM fraud_flag
                  WHERE fraud_flag.subscriber_id = subscriber.id
                    AND fraud_flag.state <> 'dismissed'
                )
            ), ranked AS (
              SELECT
                id::text AS subscriber_id,
                score,
                (ROW_NUMBER() OVER (
                  ORDER BY score DESC, verified_at ASC NULLS LAST, id ASC
                ))::integer AS rank
              FROM eligible
            )
            SELECT subscriber_id, score, rank
            FROM ranked
            ORDER BY rank
          `,
        },
        limit,
      );
    },

    listPrizeCandidates(limit) {
      return database.list<RankedCandidateRow>(
        {
          text: `
            WITH eligible AS (
              SELECT
                subscriber.id,
                subscriber.verified_at,
                SUM(giveaway_entry.entries)::integer AS score
              FROM subscriber
              JOIN giveaway_entry
                ON giveaway_entry.subscriber_id = subscriber.id
               AND giveaway_entry.voided_at IS NULL
              WHERE subscriber.status = 'verified'
                AND NOT EXISTS (
                  SELECT 1
                  FROM fraud_flag
                  WHERE fraud_flag.subscriber_id = subscriber.id
                    AND fraud_flag.state <> 'dismissed'
                )
              GROUP BY subscriber.id, subscriber.verified_at
            ), ranked AS (
              SELECT
                id::text AS subscriber_id,
                score,
                (ROW_NUMBER() OVER (
                  ORDER BY score DESC, verified_at ASC NULLS LAST, id ASC
                ))::integer AS rank
              FROM eligible
            )
            SELECT subscriber_id, score, rank
            FROM ranked
            ORDER BY rank
          `,
        },
        limit,
      );
    },
  };
}
