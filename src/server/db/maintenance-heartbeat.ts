import type { DatabaseConnection } from './pool.ts';

export const maintenanceLoopKeys = [
  'scheduler_cycle',
  'email_dispatch',
] as const;

export type MaintenanceLoopKey = (typeof maintenanceLoopKeys)[number];

export interface MaintenanceHeartbeatRow {
  readonly loop_key: MaintenanceLoopKey;
  readonly last_beat_at: Date | null;
  readonly stale_alerted_at: Date | null;
}

export interface MaintenanceHeartbeatRepository {
  /** The worker's beat: records the pass and clears any stale-alert stamp. */
  beat(loopKey: MaintenanceLoopKey, at: Date): Promise<void>;
  /**
   * Stamps `stale_alerted_at` if the loop is still stale (never beaten, or
   * last beaten before `staleBefore`) and not already alerted. Returns true
   * only for the one caller that made the stamp.
   */
  claimStale(
    loopKey: MaintenanceLoopKey,
    staleBefore: Date,
    at: Date,
  ): Promise<boolean>;
  /** Undoes a claim whose alert could not be sent, so the next run retries. */
  releaseClaim(loopKey: MaintenanceLoopKey, claimedAt: Date): Promise<void>;
  list(): Promise<readonly MaintenanceHeartbeatRow[]>;
}

export function createMaintenanceHeartbeatRepository(
  database: DatabaseConnection,
): MaintenanceHeartbeatRepository {
  return {
    async beat(loopKey, at) {
      await database.execute({
        text: `INSERT INTO maintenance_heartbeat (loop_key, last_beat_at)
          VALUES ($1, $2)
          ON CONFLICT (loop_key) DO UPDATE
          SET last_beat_at = EXCLUDED.last_beat_at,
            stale_alerted_at = NULL
          WHERE maintenance_heartbeat.last_beat_at IS NULL
            OR maintenance_heartbeat.last_beat_at <= EXCLUDED.last_beat_at`,
        values: [loopKey, at],
      });
    },
    async claimStale(loopKey, staleBefore, at) {
      await database.execute({
        text: `INSERT INTO maintenance_heartbeat (loop_key)
          VALUES ($1) ON CONFLICT (loop_key) DO NOTHING`,
        values: [loopKey],
      });
      const claimed = await database.execute({
        text: `UPDATE maintenance_heartbeat SET stale_alerted_at = $3
          WHERE loop_key = $1 AND stale_alerted_at IS NULL
            AND (last_beat_at IS NULL OR last_beat_at < $2)`,
        values: [loopKey, staleBefore, at],
      });
      return claimed === 1;
    },
    async releaseClaim(loopKey, claimedAt) {
      await database.execute({
        text: `UPDATE maintenance_heartbeat SET stale_alerted_at = NULL
          WHERE loop_key = $1 AND stale_alerted_at = $2`,
        values: [loopKey, claimedAt],
      });
    },
    list() {
      return database.list<MaintenanceHeartbeatRow>(
        {
          text: `SELECT loop_key, last_beat_at, stale_alerted_at
            FROM maintenance_heartbeat ORDER BY loop_key`,
        },
        maintenanceLoopKeys.length,
      );
    },
  };
}
