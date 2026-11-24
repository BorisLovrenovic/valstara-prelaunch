import { setTimeout as systemSleep } from 'node:timers/promises';

import type { ReferralAttributionConfiguration } from '../config.ts';
import type { DatabasePool } from '../db/pool.ts';
import type { FlagService } from '../flags/types.ts';
import { partnerActivationBatchLimit } from '../partner/activation.ts';
import { createReferralAttributionMaintenanceJob } from '../referral/attribution-maintenance.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

import { maintenanceLoopIntervalMs } from './heartbeat-file.ts';

export const verificationMaintenanceBatchLimit = 1_000;

export type MaintenanceJobName =
  | 'expiry'
  | 'ip_prefix_retention'
  | 'rate_limit_retention'
  | 'reminder'
  | 'referral_counter_repair'
  | 'stranded_referral'
  | 'verification_rate'
  | 'referral_attribution'
  | 'verification_token_retention'
  | 'giveaway_entry_reconciliation'
  | 'seed_test'
  | 'broadcast_seed_test'
  | 'email_reconciliation'
  | 'weekly_campaign'
  | 'leaderboard_snapshot'
  | 'leaderboard_snapshot_purge'
  | 'partner_leaderboard_snapshot'
  | 'partner_activation'
  | 'partner_application_purge'
  | 'email_quota';

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
  readonly referralAttribution?: VerificationRateJob;
  readonly verificationTokenRetention: MaintenanceJob;
  readonly seedTest?: VerificationRateJob;
  readonly broadcastSeedTest?: VerificationRateJob;
  readonly emailReconciliation?: MaintenanceJob;
  readonly weeklyCampaign?: MaintenanceJob;
  readonly leaderboardSnapshotPurge?: MaintenanceJob;
  readonly partnerApplicationPurge?: MaintenanceJob;
  readonly partnerActivation?: MaintenanceJob;
  readonly partnerLeaderboard?: MaintenanceJob;
  readonly emailQuota?: VerificationRateJob;
}

export interface VerificationMaintenanceDependencies {
  readonly clock?: () => Date;
  readonly reportFailure?: (job: MaintenanceJobName) => Promise<void> | void;
  /** Called after each completed cycle: the worker's heartbeat (G7-1-I2). */
  readonly onCycleComplete?: () => Promise<void>;
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
      job === 'giveaway_entry_reconciliation' ||
      job === 'email_reconciliation' ||
      job === 'weekly_campaign' ||
      job === 'leaderboard_snapshot' ||
      job === 'leaderboard_snapshot_purge' ||
      job === 'partner_leaderboard_snapshot'
        ? 'P2'
        : job === 'verification_rate' ||
            job === 'referral_attribution' ||
            job === 'rate_limit_retention' ||
            job === 'ip_prefix_retention' ||
            job === 'verification_token_retention' ||
            job === 'partner_application_purge' ||
            job === 'seed_test' ||
            job === 'broadcast_seed_test' ||
            job === 'email_quota'
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

export function createReferralAttributionMaintenanceScheduler(
  jobs: Omit<VerificationMaintenanceJobs, 'referralAttribution'>,
  dependencies: VerificationMaintenanceDependencies & {
    readonly database: DatabasePool;
    readonly flags: Pick<FlagService, 'isEnabled'>;
    readonly configuration: ReferralAttributionConfiguration;
    readonly alerts: AlertTransport;
    readonly clock: () => Date;
  },
): VerificationMaintenanceScheduler {
  return createVerificationMaintenanceScheduler(
    {
      ...jobs,
      referralAttribution: createReferralAttributionMaintenanceJob(
        dependencies.database,
        dependencies.flags,
        dependencies.configuration,
        dependencies.alerts,
        dependencies.clock,
      ),
    },
    dependencies,
  );
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
  let leaderboardSnapshotPurgeDay: string | null = null;
  let partnerApplicationPurgeDay: string | null = null;
  let emailQuotaDay: string | null = null;

  async function runJob(
    name: Exclude<MaintenanceJobName, 'verification_rate'>,
    job: MaintenanceJob,
    limit = verificationMaintenanceBatchLimit,
  ): Promise<boolean> {
    try {
      await job.run(limit);
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
    if (jobs.partnerActivation !== undefined) {
      await runJob(
        'partner_activation',
        jobs.partnerActivation,
        partnerActivationBatchLimit,
      );
    }
    if (jobs.partnerLeaderboard !== undefined) {
      await runJob('partner_leaderboard_snapshot', jobs.partnerLeaderboard);
    }
    if (jobs.giveawayEntryReconciliation !== undefined) {
      await runJob(
        'giveaway_entry_reconciliation',
        jobs.giveawayEntryReconciliation,
      );
    }
    await runVerificationRateJob();
    if (jobs.referralAttribution !== undefined) {
      try {
        await jobs.referralAttribution.run();
      } catch {
        await reportFailure('referral_attribution');
      }
    }
    if (jobs.seedTest !== undefined) {
      try {
        await jobs.seedTest.run();
      } catch {
        await reportFailure('seed_test');
      }
    }
    if (jobs.broadcastSeedTest !== undefined) {
      try {
        await jobs.broadcastSeedTest.run();
      } catch {
        await reportFailure('broadcast_seed_test');
      }
    }
    if (jobs.emailReconciliation !== undefined) {
      await runJob('email_reconciliation', jobs.emailReconciliation);
    }
    if (jobs.weeklyCampaign !== undefined) {
      await runJob('weekly_campaign', jobs.weeklyCampaign, 100);
    }

    const day = now.toISOString().slice(0, 10);
    if (emailQuotaDay !== day && jobs.emailQuota !== undefined) {
      try {
        await jobs.emailQuota.run();
        emailQuotaDay = day;
      } catch {
        await reportFailure('email_quota');
      }
    }
    if (
      leaderboardSnapshotPurgeDay !== day &&
      jobs.leaderboardSnapshotPurge !== undefined &&
      (await runJob(
        'leaderboard_snapshot_purge',
        jobs.leaderboardSnapshotPurge,
        100,
      ))
    ) {
      leaderboardSnapshotPurgeDay = day;
    }
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
      partnerApplicationPurgeDay !== day &&
      jobs.partnerApplicationPurge !== undefined &&
      (await runJob('partner_application_purge', jobs.partnerApplicationPurge))
    ) {
      partnerApplicationPurgeDay = day;
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
        try {
          await dependencies.onCycleComplete?.();
        } catch {
          // A heartbeat failure never fails the cycle.
        }
        if (cycle + 1 < cycles && !signal?.aborted) {
          try {
            await sleep(maintenanceLoopIntervalMs.scheduler_cycle, signal);
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
