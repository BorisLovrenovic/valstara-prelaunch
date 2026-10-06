import type { DatabaseConnection } from './pool.ts';

interface CountRow {
  readonly count: string;
}

interface SnapshotRow {
  readonly as_of: Date;
}

export interface AdminHealthCounts {
  readonly latestSnapshotAt: Date | null;
  readonly queuedEmails: number;
  readonly openFlags: number;
}

export function createAdminHealthRepository(database: DatabaseConnection) {
  return {
    async counts(): Promise<AdminHealthCounts> {
      const [snapshot, email, flags] = await Promise.all([
        database.readOne<SnapshotRow>({
          text: `SELECT as_of FROM leaderboard_snapshot
            ORDER BY as_of DESC, id DESC`,
        }),
        database.readOne<CountRow>({
          text: `SELECT COUNT(*)::text AS count FROM email_send
            WHERE state = 'queued'`,
        }),
        database.readOne<CountRow>({
          text: `SELECT COUNT(*)::text AS count FROM fraud_flag
            WHERE state = 'open'`,
        }),
      ]);
      return {
        latestSnapshotAt: snapshot?.as_of ?? null,
        queuedEmails: Number(email?.count ?? 0),
        openFlags: Number(flags?.count ?? 0),
      };
    },
  };
}
