import { randomUUID } from 'node:crypto';
import { setTimeout as systemSleep } from 'node:timers/promises';

import {
  createLeaderboardSnapshotRepository,
  withLeaderboardPublicationLock,
} from '../db/leaderboard-snapshot.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
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
    withPublication<Result>(
      operation: (connection: DatabaseConnection) => Promise<Result>,
    ): Promise<Result> {
      return withLeaderboardPublicationLock(database, operation);
    },
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
    async latest(
      connection: DatabaseConnection = database,
    ): Promise<SharedLeaderboardSnapshot | null> {
      return fromStored(
        await createLeaderboardSnapshotRepository(connection).latest(),
      );
    },
    async served(
      connection: DatabaseConnection = database,
    ): Promise<SharedLeaderboardSnapshot | null> {
      return fromStored(
        await createLeaderboardSnapshotRepository(connection).served(),
      );
    },
    async publishServed(
      id: string,
      connection: DatabaseConnection = database,
    ): Promise<void> {
      await createLeaderboardSnapshotRepository(connection).publishServed(id);
    },
    async forSite(
      isoWeek: string | null,
      connection: DatabaseConnection = database,
    ): Promise<SharedLeaderboardSnapshot | null> {
      return fromStored(
        await createLeaderboardSnapshotRepository(connection).forSite(isoWeek),
      );
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
  load: (
    connection: DatabaseConnection,
  ) => Promise<SharedLeaderboardSnapshot | null>,
  publish: (id: string, connection: DatabaseConnection) => Promise<void>,
  serialize: <Result>(
    operation: (connection: DatabaseConnection) => Promise<Result>,
  ) => Promise<Result>,
  schedule: (
    callback: () => void,
    milliseconds: number,
  ) => { clear(): void; unref?(): void } = (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    return { clear: () => clearInterval(timer), unref: () => timer.unref() };
  },
) {
  let current: SharedLeaderboardSnapshot | null = null;
  const refresh = (): Promise<SharedLeaderboardSnapshot | null> =>
    serialize(async (connection) => {
      const loaded = await load(connection);
      if (loaded !== null) {
        await publish(loaded.id, connection);
        current = loaded;
      }
      return current;
    });
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
