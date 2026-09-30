import type { DatabaseConnection, DatabasePool } from './pool.ts';
import { withTransaction } from './transaction.ts';

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

export async function withLeaderboardPublicationLock<Result>(
  database: DatabasePool,
  operation: (connection: DatabaseConnection) => Promise<Result>,
): Promise<Result> {
  return withTransaction(database, async (connection) => {
    await connection.readOne({
      text: "SELECT pg_advisory_xact_lock(hashtext('valstara:leaderboard-publication'))",
    });
    return operation(connection);
  });
}

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
    served(): Promise<PersistedLeaderboardSnapshot | null> {
      return db.readOne({
        text: `SELECT s.id, s.as_of, s.entries FROM leaderboard_served_snapshot p
          JOIN leaderboard_snapshot s ON s.id = p.snapshot_id WHERE p.singleton`,
      });
    },
    forSite(
      isoWeek: string | null,
    ): Promise<PersistedLeaderboardSnapshot | null> {
      return db.readOne({
        text: `SELECT s.id, s.as_of, s.entries FROM leaderboard_snapshot s
          WHERE s.id = COALESCE(
            (SELECT r.snapshot_id FROM weekly_campaign_run r
              WHERE r.iso_week = $1 AND r.state IN ('started', 'completed')),
            (SELECT p.snapshot_id FROM leaderboard_served_snapshot p
              WHERE p.singleton AND $1::text IS NOT NULL),
            (SELECT latest.id FROM leaderboard_snapshot latest
              ORDER BY latest.as_of DESC, latest.id DESC LIMIT 1))`,
        values: [isoWeek],
      });
    },
    async publishServed(id: string): Promise<void> {
      await db.execute({
        text: `INSERT INTO leaderboard_served_snapshot (singleton, snapshot_id)
          VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE
          SET snapshot_id = EXCLUDED.snapshot_id`,
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
