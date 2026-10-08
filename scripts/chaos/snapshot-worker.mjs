import { createPool } from '../../src/server/db/pool.ts';
import {
  createSharedLeaderboardSnapshotStore,
  runSharedSnapshotRefresh,
} from '../../src/server/leaderboard/persisted.ts';
import { createRankingIntegrityService } from '../../src/server/referral/ranking.ts';

const database = createPool(process.env.DATABASE_URL);
const controller = new globalThis.AbortController();
process.once('SIGTERM', () => controller.abort());
await runSharedSnapshotRefresh(
  createSharedLeaderboardSnapshotStore(
    database,
    createRankingIntegrityService(database),
    () => new Date(process.env.CHAOS_CLOCK),
  ),
  controller.signal,
  async () => {
    throw new Error('The chaos snapshot worker failed.');
  },
);
await database.close();
