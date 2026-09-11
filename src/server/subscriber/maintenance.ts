import { setTimeout as systemSleep } from 'node:timers/promises';

import type { P1AlertTransport } from '../verification-rate/p1-webhook.ts';

const HOUR_MS = 60 * 60 * 1_000;

export const verificationMaintenanceBatchLimit = 1_000;

export type MaintenanceJobName =
  | 'expiry'
  | 'rate_limit_retention'
  | 'reminder'
  | 'stranded_referral'
  | 'verification_rate'
  | 'verification_token_retention';

export interface MaintenanceJob {
  run(limit: number): Promise<unknown>;
}

export interface VerificationRateJob {
  run(): Promise<unknown>;
}

export interface VerificationMaintenanceJobs {
  readonly expiry: MaintenanceJob;
  readonly rateLimitRetention: MaintenanceJob;
  readonly reminder: MaintenanceJob;
  readonly strandedReferral: MaintenanceJob;
  readonly verificationRate: VerificationRateJob;
  readonly verificationTokenRetention: MaintenanceJob;
}

export interface VerificationMaintenanceDependencies {
  readonly clock?: () => Date;
  readonly reportFailure?: (job: MaintenanceJobName) => Promise<void> | void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface MaintenanceFailureReporterDependencies {
  readonly clock?: () => Date;
  readonly writeStderr?: (message: string) => void;
}

export function createMaintenanceFailureReporter(
  p1Alerts: P1AlertTransport,
  dependencies: MaintenanceFailureReporterDependencies = {},
): (job: MaintenanceJobName) => Promise<void> {
  const clock = dependencies.clock ?? (() => new Date());
  const writeStderr =
    dependencies.writeStderr ??
    ((message: string) => process.stderr.write(message));

  return async (job) => {
    const severity =
      job === 'verification_rate' ||
      job === 'rate_limit_retention' ||
      job === 'verification_token_retention'
        ? 'P1'
        : 'P3';
    if (severity === 'P1') {
      await p1Alerts.send({
        detail: { job },
        event: 'verification_maintenance_failed',
        occurredAt: clock(),
        severity,
      });
      return;
    }
    writeStderr(
      `${JSON.stringify({ event: 'verification_maintenance_failed', job, severity })}\n`,
    );
  };
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
  let rateLimitRetentionDay: string | null = null;
  let strandedReferralDay: string | null = null;
  let verificationTokenRetentionDay: string | null = null;

  async function runJob(
    name: Exclude<MaintenanceJobName, 'verification_rate'>,
    job: MaintenanceJob,
  ): Promise<boolean> {
    try {
      await job.run(verificationMaintenanceBatchLimit);
      return true;
    } catch {
      await reportFailure(name);
      return false;
    }
  }

  async function runVerificationRateJob(): Promise<void> {
    try {
      await jobs.verificationRate.run();
    } catch {
      await reportFailure('verification_rate');
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
    if (
      rateLimitRetentionDay !== day &&
      (await runJob('rate_limit_retention', jobs.rateLimitRetention))
    ) {
      rateLimitRetentionDay = day;
    }
    if (
      verificationTokenRetentionDay !== day &&
      (await runJob(
        'verification_token_retention',
        jobs.verificationTokenRetention,
      ))
    ) {
      verificationTokenRetentionDay = day;
    }
    if (
      strandedReferralDay !== day &&
      (await runJob('stranded_referral', jobs.strandedReferral))
    ) {
      strandedReferralDay = day;
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
