import type { DatabaseConnection } from './pool.ts';

export interface PersistedLeaderboardSnapshot {
  readonly id: string;
  readonly as_of: Date;
  readonly entries: readonly {
    readonly rank: number;
    readonly display_handle: string;
    readonly confirmed_referrals: number;
  }[];
}

export const maxSnapshotPurgeBatch = 100;

export function createLeaderboardSnapshotRepository(db: DatabaseConnection) {
  return {
    latest(): Promise<PersistedLeaderboardSnapshot | null> {
      return db.readOne({
        text: 'SELECT id, as_of, entries FROM leaderboard_snapshot ORDER BY as_of DESC, id DESC',
      });
    },
    byId(id: string): Promise<PersistedLeaderboardSnapshot | null> {
      return db.readOne({
        text: 'SELECT id, as_of, entries FROM leaderboard_snapshot WHERE id = $1',
        values: [id],
      });
    },
    async insert(row: PersistedLeaderboardSnapshot): Promise<void> {
      await db.execute({
        text: 'INSERT INTO leaderboard_snapshot (id, as_of, entries) VALUES ($1, $2, $3::jsonb)',
        values: [row.id, row.as_of, JSON.stringify(row.entries)],
      });
    },
    async purge(before: Date, limit: number): Promise<number> {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > maxSnapshotPurgeBatch
      )
        throw new RangeError('Snapshot purge batch is out of range.');
      return db.execute({
        text: `DELETE FROM leaderboard_snapshot WHERE id IN (
          SELECT id FROM leaderboard_snapshot WHERE as_of < $1
          ORDER BY as_of, id LIMIT $2
        )`,
        values: [before, limit],
      });
    },
  };
}
