import { createHash } from 'node:crypto';

import type { RankingIntegrityService } from '../referral/ranking.ts';

export const leaderboardSnapshotSize = 10;
export const leaderboardRefreshIntervalMilliseconds = 5 * 60 * 1_000;

export interface LeaderboardSnapshotEntry {
  readonly confirmedReferrals: number;
  readonly displayHandle: string;
  readonly rank: number;
}

export interface LeaderboardSnapshot {
  readonly asOf: string;
  readonly entries: readonly LeaderboardSnapshotEntry[];
}

export interface LeaderboardSnapshotClock {
  now(): Date;
}

export interface LeaderboardSnapshotCache {
  read(): LeaderboardSnapshot | null;
  refresh(): Promise<LeaderboardSnapshot>;
}

const systemClock: LeaderboardSnapshotClock = { now: () => new Date() };

/**
 * The UUID is never retained in the snapshot. Its SHA-256-derived handle is
 * deterministic for a subscriber but cannot be reversed into a subscriber ID
 * at the public boundary.
 */
function displayHandle(subscriberId: string): string {
  return createHash('sha256')
    .update(subscriberId)
    .digest('base64url')
    .slice(0, 12);
}

export function createLeaderboardSnapshotCache(
  ranking: Pick<RankingIntegrityService, 'leaderboardCandidates'>,
  clock: LeaderboardSnapshotClock = systemClock,
): LeaderboardSnapshotCache {
  let snapshot: LeaderboardSnapshot | null = null;

  return {
    read: () => snapshot,
    async refresh() {
      const candidates = await ranking.leaderboardCandidates(
        leaderboardSnapshotSize,
      );
      const next = Object.freeze({
        asOf: clock.now().toISOString(),
        entries: Object.freeze(
          candidates.map(({ confirmedReferrals, rank, subscriberId }) =>
            Object.freeze({
              confirmedReferrals,
              displayHandle: displayHandle(subscriberId),
              rank,
            }),
          ),
        ),
      });
      snapshot = next;
      return next;
    },
  };
}

export interface LeaderboardSnapshotScheduler {
  stop(): void;
}

export interface LeaderboardSnapshotSchedulerDependencies {
  readonly schedule?: (
    callback: () => void,
    milliseconds: number,
  ) => ScheduledRefresh;
}

interface ScheduledRefresh {
  readonly clear: () => void;
  readonly unref?: () => void;
}

/** Refresh failures deliberately preserve the previous good snapshot. */
export function startLeaderboardSnapshotScheduler(
  cache: LeaderboardSnapshotCache,
  dependencies: LeaderboardSnapshotSchedulerDependencies = {},
): LeaderboardSnapshotScheduler {
  const schedule =
    dependencies.schedule ??
    ((callback, milliseconds): ScheduledRefresh => {
      const timer = setInterval(callback, milliseconds);
      return {
        clear: () => clearInterval(timer),
        unref: () => timer.unref(),
      };
    });
  const refresh = (): void => {
    void cache.refresh().catch(() => undefined);
  };

  refresh();
  const timer = schedule(refresh, leaderboardRefreshIntervalMilliseconds);
  timer.unref?.();

  return { stop: () => timer.clear() };
}
