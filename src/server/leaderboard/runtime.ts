import { getConfig, getWeeklySendConfiguration } from '../config.ts';
import { createPool, type DatabasePool } from '../db/pool.ts';
import { weeklyWindow } from '../email/weekly-campaign.ts';
import { createRankingIntegrityService } from '../referral/ranking.ts';

import {
  createPersistedSnapshotCache,
  createSharedLeaderboardSnapshotStore,
} from './persisted.ts';

let database: DatabasePool | undefined;
let snapshot: ReturnType<typeof createPersistedSnapshotCache> | undefined;
let started = false;
let store: ReturnType<typeof createSharedLeaderboardSnapshotStore> | undefined;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

export function getLeaderboardSnapshot(): ReturnType<
  typeof createPersistedSnapshotCache
> {
  store ??= createSharedLeaderboardSnapshotStore(
    getDatabase(),
    createRankingIntegrityService(getDatabase()),
    () => new Date(),
  );
  snapshot ??= createPersistedSnapshotCache(
    () => {
      const now = new Date();
      const window = weeklyWindow(now, getWeeklySendConfiguration());
      return store!.forSite(
        now >= window.startsAt && now < window.endsAt ? window.isoWeek : null,
      );
    },
    (id) => store!.publishServed(id),
  );
  if (!started) {
    snapshot.start();
    started = true;
  }
  return snapshot;
}
