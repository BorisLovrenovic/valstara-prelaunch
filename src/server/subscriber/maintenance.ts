import { setTimeout as systemSleep } from 'node:timers/promises';

import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

const HOUR_MS = 60 * 60 * 1_000;

export const verificationMaintenanceBatchLimit = 1_000;

export type MaintenanceJobName =
  | 'expiry'
  | 'ip_prefix_retention'
  | 'rate_limit_retention'
  | 'reminder'
  | 'referral_counter_repair'
  | 'stranded_referral'
  | 'verification_rate'
  | 'verification_token_retention'
  | 'giveaway_entry_reconciliation'
  | 'seed_test';

export interface MaintenanceJob {
  run(limit: number): Promise<unknown>;
}

export interface VerificationRateJob {
  run(): Promise<unknown>;
}

export interface VerificationMaintenanceJobs {
  readonly giveawayEntryReconciliation?: MaintenanceJob;
  readonly expiry: MaintenanceJob;
  readonly ipPrefixRetention?: MaintenanceJob;
  readonly rateLimitRetention: MaintenanceJob;
  readonly referralCounterRepair: MaintenanceJob;
  readonly reminder: MaintenanceJob;
  readonly strandedReferral: MaintenanceJob;
  readonly verificationRate: VerificationRateJob;
  readonly verificationTokenRetention: MaintenanceJob;
  readonly seedTest?: VerificationRateJob;
}

export interface VerificationMaintenanceDependencies {
  readonly clock?: () => Date;
  readonly reportFailure?: (job: MaintenanceJobName) => Promise<void> | void;
  readonly sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface MaintenanceFailureReporterDependencies {
  readonly clock?: () => Date;
  readonly writeStderr?: (message: string) => void;
}

export function createMaintenanceFailureReporter(
  alerts: AlertTransport,
  dependencies: MaintenanceFailureReporterDependencies = {},
): (job: MaintenanceJobName) => Promise<void> {
  const clock = dependencies.clock ?? (() => new Date());
  const writeStderr =
    dependencies.writeStderr ??
    ((message: string) => process.stderr.write(message));

  return async (job) => {
    const severity =
      job === 'referral_counter_repair' ||
      job === 'giveaway_entry_reconciliation'
        ? 'P2'
        : job === 'verification_rate' ||
            job === 'rate_limit_retention' ||
            job === 'ip_prefix_retention' ||
            job === 'verification_token_retention' ||
            job === 'seed_test'
          ? 'P1'
          : 'P3';
    if (severity === 'P1' || severity === 'P2') {
      await alerts.send({
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
  run(cycles?: number, signal?: AbortSignal): Promise<void>;
  runCycle(): Promise<void>;
}

export function createVerificationMaintenanceScheduler(
  jobs: VerificationMaintenanceJobs,
  dependencies: VerificationMaintenanceDependencies = {},
): VerificationMaintenanceScheduler {
  const clock = dependencies.clock ?? (() => new Date());
  const reportFailure = dependencies.reportFailure ?? (() => undefined);
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number, signal?: AbortSignal) =>
      systemSleep(milliseconds, undefined, { signal }));
  let expiryDay: string | null = null;
  let ipPrefixRetentionDay: string | null = null;
  let rateLimitRetentionDay: string | null = null;
  let referralCounterRepairDay: string | null = null;
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
    if (jobs.giveawayEntryReconciliation !== undefined) {
      await runJob(
        'giveaway_entry_reconciliation',
        jobs.giveawayEntryReconciliation,
      );
    }
    await runVerificationRateJob();
    if (jobs.seedTest !== undefined) {
      try {
        await jobs.seedTest.run();
      } catch {
        await reportFailure('seed_test');
      }
    }

    const day = now.toISOString().slice(0, 10);
    if (expiryDay !== day && (await runJob('expiry', jobs.expiry))) {
      expiryDay = day;
    }
    if (
      ipPrefixRetentionDay !== day &&
      jobs.ipPrefixRetention !== undefined &&
      (await runJob('ip_prefix_retention', jobs.ipPrefixRetention))
    ) {
      ipPrefixRetentionDay = day;
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
    if (
      referralCounterRepairDay !== day &&
      (await runJob('referral_counter_repair', jobs.referralCounterRepair))
    ) {
      referralCounterRepairDay = day;
    }
  }

  return {
    async run(cycles = Number.POSITIVE_INFINITY, signal?: AbortSignal) {
      for (let cycle = 0; cycle < cycles && !signal?.aborted; cycle += 1) {
        await runCycle();
        if (cycle + 1 < cycles && !signal?.aborted) {
          try {
            await sleep(HOUR_MS, signal);
          } catch (error) {
            if (
              !signal?.aborted ||
              !(error instanceof Error) ||
              error.name !== 'AbortError'
            ) {
              throw error;
            }
          }
        }
      }
    },
    runCycle,
  };
}
