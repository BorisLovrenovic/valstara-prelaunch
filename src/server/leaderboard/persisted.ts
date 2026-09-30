import { randomUUID } from 'node:crypto';
import { setTimeout as systemSleep } from 'node:timers/promises';

import { createLeaderboardSnapshotRepository } from '../db/leaderboard-snapshot.ts';
import type { DatabasePool } from '../db/pool.ts';
import type { RankingIntegrityService } from '../referral/ranking.ts';

import {
  createLeaderboardSnapshotCache,
  leaderboardRefreshIntervalMilliseconds,
  type LeaderboardSnapshot,
} from './snapshot.ts';

export interface SharedLeaderboardSnapshot extends LeaderboardSnapshot {
  readonly id: string;
}

function fromStored(
  row: Awaited<
    ReturnType<ReturnType<typeof createLeaderboardSnapshotRepository>['latest']>
  >,
): SharedLeaderboardSnapshot | null {
  if (row === null) return null;
  return {
    id: row.id,
    asOf: row.as_of.toISOString(),
    entries: row.entries.map((entry) => ({
      rank: entry.rank,
      displayHandle: entry.display_handle,
      confirmedReferrals: entry.confirmed_referrals,
    })),
  };
}

export function createSharedLeaderboardSnapshotStore(
  database: DatabasePool,
  ranking: Pick<RankingIntegrityService, 'leaderboardCandidates'>,
  clock: () => Date,
) {
  const repository = createLeaderboardSnapshotRepository(database);
  const computation = createLeaderboardSnapshotCache(ranking, { now: clock });
  return {
    async refresh(): Promise<SharedLeaderboardSnapshot> {
      const computed = await computation.refresh();
      const id = randomUUID();
      const row = {
        id,
        as_of: new Date(computed.asOf),
        entries: computed.entries.map((entry) => ({
          rank: entry.rank,
          display_handle: entry.displayHandle,
          confirmed_referrals: entry.confirmedReferrals,
        })),
      };
      await repository.insert(row);
      return { ...computed, id };
    },
    async latest(): Promise<SharedLeaderboardSnapshot | null> {
      return fromStored(await repository.latest());
    },
    async served(): Promise<SharedLeaderboardSnapshot | null> {
      return fromStored(await repository.served());
    },
    async publishServed(id: string): Promise<void> {
      await repository.publishServed(id);
    },
    async forSite(
      isoWeek: string | null,
    ): Promise<SharedLeaderboardSnapshot | null> {
      return fromStored(await repository.forSite(isoWeek));
    },
    async byId(id: string): Promise<SharedLeaderboardSnapshot | null> {
      return fromStored(await repository.byId(id));
    },
    async purge(limit: number): Promise<number> {
      const before = new Date(clock().getTime() - 14 * 24 * 60 * 60 * 1_000);
      return repository.purge(before, limit);
    },
  };
}

export function createPersistedSnapshotCache(
  load: () => Promise<SharedLeaderboardSnapshot | null>,
  publish: (id: string) => Promise<void>,
  schedule: (
    callback: () => void,
    milliseconds: number,
  ) => { clear(): void; unref?(): void } = (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    return { clear: () => clearInterval(timer), unref: () => timer.unref() };
  },
) {
  let current: SharedLeaderboardSnapshot | null = null;
  const refresh = async (): Promise<SharedLeaderboardSnapshot | null> => {
    const loaded = await load();
    if (loaded !== null) {
      await publish(loaded.id);
      current = loaded;
    }
    return current;
  };
  const start = () => {
    void refresh().catch(() => undefined);
    const timer = schedule(() => {
      void refresh().catch(() => undefined);
    }, leaderboardRefreshIntervalMilliseconds);
    timer.unref?.();
    return { stop: () => timer.clear() };
  };
  return { read: () => current, refresh, start };
}

export async function runSharedSnapshotRefresh(
  store: Pick<
    ReturnType<typeof createSharedLeaderboardSnapshotStore>,
    'refresh'
  >,
  signal: AbortSignal,
  reportFailure: () => Promise<void>,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, abort) =>
    systemSleep(ms, undefined, { signal: abort }),
): Promise<void> {
  while (!signal.aborted) {
    try {
      await store.refresh();
    } catch {
      try {
        await reportFailure();
      } catch {
        process.stderr.write(
          `${JSON.stringify({ event: 'leaderboard_snapshot_alert_failed', code: 'alert_unavailable' })}\n`,
        );
      }
    }
    try {
      await sleep(leaderboardRefreshIntervalMilliseconds, signal);
    } catch {
      return;
    }
  }
}
