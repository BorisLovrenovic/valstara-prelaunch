import type {
  PurgeJobKey,
  PurgeJobRunRepository,
} from '../db/purge-job-run.ts';

export interface PurgeJob {
  run(limit: number): Promise<number>;
}

export function createRecordedPurgeJob(
  job: PurgeJob,
  repository: Pick<PurgeJobRunRepository, 'start' | 'finish'>,
  jobKey: PurgeJobKey,
  clock: () => Date,
): PurgeJob {
  const record = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch {
      // The purge and its existing failure alert remain authoritative.
    }
  };
  return {
    async run(limit) {
      const startedAt = clock();
      await record(() => repository.start(jobKey, startedAt));
      try {
        const rowsPurged = await job.run(limit);
        await record(() =>
          repository.finish({
            jobKey,
            startedAt,
            finishedAt: clock(),
            outcome: 'succeeded',
            rowsPurged,
            errorCode: null,
          }),
        );
        return rowsPurged;
      } catch (error) {
        await record(() =>
          repository.finish({
            jobKey,
            startedAt,
            finishedAt: clock(),
            outcome: 'failed',
            rowsPurged: 0,
            errorCode: 'purge_failed',
          }),
        );
        throw error;
      }
    },
  };
}
