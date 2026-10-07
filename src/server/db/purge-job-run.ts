import type { DatabaseConnection } from './pool.ts';

export const purgeJobKeys = [
  'ip_prefix_retention',
  'rate_limit_retention',
  'verification_token_retention',
  'leaderboard_snapshot_purge',
] as const;

export type PurgeJobKey = (typeof purgeJobKeys)[number];
export type PurgeOutcome = 'succeeded' | 'failed';

export interface PurgeJobRunRow {
  readonly job_key: PurgeJobKey;
  readonly last_started_at: Date;
  readonly last_finished_at: Date | null;
  readonly last_succeeded_at: Date | null;
  readonly last_outcome: PurgeOutcome | null;
  readonly rows_purged: number;
  readonly last_error_code: string | null;
}

export interface PurgeJobRunRepository {
  start(jobKey: PurgeJobKey, startedAt: Date): Promise<void>;
  finish(input: {
    readonly jobKey: PurgeJobKey;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly outcome: PurgeOutcome;
    readonly rowsPurged: number;
    readonly errorCode: string | null;
  }): Promise<void>;
  list(): Promise<readonly PurgeJobRunRow[]>;
}

export function createPurgeJobRunRepository(
  database: DatabaseConnection,
): PurgeJobRunRepository {
  return {
    async start(jobKey, startedAt) {
      await database.execute({
        text: `INSERT INTO purge_job_run (job_key, last_started_at)
          VALUES ($1, $2)
          ON CONFLICT (job_key) DO UPDATE
          SET last_started_at = EXCLUDED.last_started_at
          WHERE purge_job_run.last_started_at <= EXCLUDED.last_started_at`,
        values: [jobKey, startedAt],
      });
    },
    async finish(input) {
      await database.execute({
        text: `INSERT INTO purge_job_run (
            job_key, last_started_at, last_finished_at, last_succeeded_at,
            last_outcome, rows_purged, last_error_code
          ) VALUES ($1, $2, $3,
            CASE WHEN $4 = 'succeeded' THEN $3::timestamptz ELSE NULL END,
            $4, $5, $6)
          ON CONFLICT (job_key) DO UPDATE SET
            last_started_at = EXCLUDED.last_started_at,
            last_finished_at = EXCLUDED.last_finished_at,
            last_succeeded_at = CASE WHEN EXCLUDED.last_outcome = 'succeeded'
              THEN EXCLUDED.last_succeeded_at
              ELSE purge_job_run.last_succeeded_at END,
            last_outcome = EXCLUDED.last_outcome,
            rows_purged = EXCLUDED.rows_purged,
            last_error_code = EXCLUDED.last_error_code
          WHERE purge_job_run.last_started_at <= EXCLUDED.last_started_at`,
        values: [
          input.jobKey,
          input.startedAt,
          input.finishedAt,
          input.outcome,
          input.rowsPurged,
          input.errorCode,
        ],
      });
    },
    list() {
      return database.list<PurgeJobRunRow>(
        {
          text: `SELECT job_key, last_started_at, last_finished_at,
            last_succeeded_at, last_outcome, rows_purged, last_error_code
            FROM purge_job_run ORDER BY job_key`,
        },
        purgeJobKeys.length,
      );
    },
  };
}
