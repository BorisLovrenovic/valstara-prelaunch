import { getConfig } from '../config.ts';
import { createPool, type DatabasePool } from '../db/pool.ts';
import { createRankingIntegrityService } from '../referral/ranking.ts';

import {
  createLeaderboardSnapshotCache,
  startLeaderboardSnapshotScheduler,
  type LeaderboardSnapshotCache,
} from './snapshot.ts';

let database: DatabasePool | undefined;
let snapshot: LeaderboardSnapshotCache | undefined;
let started = false;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

export function getLeaderboardSnapshot(): LeaderboardSnapshotCache {
  snapshot ??= createLeaderboardSnapshotCache(
    createRankingIntegrityService(getDatabase()),
  );
  if (!started) {
    startLeaderboardSnapshotScheduler(snapshot);
    started = true;
  }
  return snapshot;
}
