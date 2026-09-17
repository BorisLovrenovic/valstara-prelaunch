import type { DatabasePool } from '../db/pool.ts';
import { createRankingRepository } from '../db/ranking.ts';

export const rankingBatchMaximum = 1_000;

export interface LeaderboardRankedCandidate {
  readonly confirmedReferrals: number;
  readonly rank: number;
  readonly subscriberId: string;
}

export interface PrizeRankedCandidate {
  readonly entries: number;
  readonly rank: number;
  readonly subscriberId: string;
}

export interface RankingIntegrityService {
  leaderboardCandidates(
    limit: number,
  ): Promise<readonly LeaderboardRankedCandidate[]>;
  prizeCandidates(limit: number): Promise<readonly PrizeRankedCandidate[]>;
}

function assertRankingLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > rankingBatchMaximum) {
    throw new RangeError(
      `A ranking limit must be between 1 and ${rankingBatchMaximum}.`,
    );
  }
}

export function createRankingIntegrityService(
  database: DatabasePool,
): RankingIntegrityService {
  const repository = createRankingRepository(database);

  return {
    async leaderboardCandidates(limit) {
      assertRankingLimit(limit);
      const candidates = await repository.listLeaderboardCandidates(limit);
      return candidates.map((candidate) => ({
        confirmedReferrals: candidate.score,
        rank: candidate.rank,
        subscriberId: candidate.subscriber_id,
      }));
    },

    async prizeCandidates(limit) {
      assertRankingLimit(limit);
      const candidates = await repository.listPrizeCandidates(limit);
      return candidates.map((candidate) => ({
        entries: candidate.score,
        rank: candidate.rank,
        subscriberId: candidate.subscriber_id,
      }));
    },
  };
}
