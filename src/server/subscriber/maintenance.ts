import { setTimeout as systemSleep } from 'node:timers/promises';

const HOUR_MS = 60 * 60 * 1_000;

export const verificationMaintenanceBatchLimit = 1_000;

export interface MaintenanceJob {
  run(limit: number): Promise<unknown>;
}

export interface VerificationRateJob {
  run(): Promise<unknown>;
}

export interface VerificationMaintenanceJobs {
  readonly expiry: MaintenanceJob;
  readonly reminder: MaintenanceJob;
  readonly verificationRate: VerificationRateJob;
}

export interface VerificationMaintenanceDependencies {
  readonly clock?: () => Date;
  readonly reportFailure?: (
    job: 'expiry' | 'reminder' | 'verification_rate',
  ) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface VerificationMaintenanceScheduler {
  run(cycles?: number): Promise<void>;
  runCycle(): Promise<void>;
}

export function createVerificationMaintenanceScheduler(
  jobs: VerificationMaintenanceJobs,
  dependencies: VerificationMaintenanceDependencies = {},
): VerificationMaintenanceScheduler {
  const clock = dependencies.clock ?? (() => new Date());
  const reportFailure = dependencies.reportFailure ?? (() => undefined);
  const sleep = dependencies.sleep ?? systemSleep;
  let expiryDay: string | null = null;

  async function runJob(
    name: 'expiry' | 'reminder',
    job: MaintenanceJob,
  ): Promise<boolean> {
    try {
      await job.run(verificationMaintenanceBatchLimit);
      return true;
    } catch {
      reportFailure(name);
      return false;
    }
  }

  async function runVerificationRateJob(): Promise<void> {
    try {
      await jobs.verificationRate.run();
    } catch {
      reportFailure('verification_rate');
    }
  }

  async function runCycle(): Promise<void> {
    const now = clock();
    await runJob('reminder', jobs.reminder);
    await runVerificationRateJob();

    const day = now.toISOString().slice(0, 10);
    if (expiryDay !== day && (await runJob('expiry', jobs.expiry))) {
      expiryDay = day;
    }
  }

  return {
    async run(cycles = Number.POSITIVE_INFINITY) {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        await runCycle();
        if (cycle + 1 < cycles) {
          await sleep(HOUR_MS);
        }
      }
    },
    runCycle,
  };
}
