import {
  purgeJobKeys,
  type PurgeJobKey,
  type PurgeJobRunRow,
  type PurgeOutcome,
} from '../db/purge-job-run.ts';

const dailyScheduleMs = 24 * 60 * 60 * 1_000;

export interface PurgeJobHealth {
  readonly jobKey: PurgeJobKey;
  readonly lastSucceededAt: Date | null;
  readonly lastOutcome: PurgeOutcome | null;
  readonly rowsPurged: number;
  readonly stale: boolean;
}

export function purgeJobHealth(
  rows: readonly PurgeJobRunRow[],
  now: Date,
): readonly PurgeJobHealth[] {
  return purgeJobKeys.map((jobKey) => {
    const row = rows.find((candidate) => candidate.job_key === jobKey);
    const lastSucceededAt = row?.last_succeeded_at ?? null;
    return {
      jobKey,
      lastSucceededAt,
      lastOutcome: row?.last_outcome ?? null,
      rowsPurged: row?.rows_purged ?? 0,
      stale:
        lastSucceededAt === null ||
        now.getTime() - lastSucceededAt.getTime() > 2 * dailyScheduleMs,
    };
  });
}
