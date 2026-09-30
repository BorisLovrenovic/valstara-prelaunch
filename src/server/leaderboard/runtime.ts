import { getConfig } from '../config.ts';
import { createPool, type DatabasePool } from '../db/pool.ts';
import { createRankingIntegrityService } from '../referral/ranking.ts';

import {
  createPersistedSnapshotCache,
  createSharedLeaderboardSnapshotStore,
} from './persisted.ts';

let database: DatabasePool | undefined;
let snapshot: ReturnType<typeof createPersistedSnapshotCache> | undefined;
let started = false;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

export function getLeaderboardSnapshot(): ReturnType<
  typeof createPersistedSnapshotCache
> {
  snapshot ??= createPersistedSnapshotCache(() =>
    createSharedLeaderboardSnapshotStore(
      getDatabase(),
      createRankingIntegrityService(getDatabase()),
      () => new Date(),
    ).latest(),
  );
  if (!started) {
    snapshot.start();
    started = true;
  }
  return snapshot;
}
