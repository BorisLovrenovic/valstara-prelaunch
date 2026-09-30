import {
  getDatabaseUrl,
  getEmailWebhookConfiguration,
  getBrevoConfiguration,
  getDrandConfiguration,
  getP1AlertConfiguration,
  getResendDispatchConfiguration,
  getSeedTestConfiguration,
  getVerificationRateConfiguration,
  getWeeklySendConfiguration,
  getEmailQuotaConfiguration,
} from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createSeedTestRepository } from '../db/seed-test.ts';
import { checkDomainAuthenticationAtStartup } from '../email/domain-authentication.ts';
import {
  createImapSeedMailbox,
  createResendSeedSender,
} from '../email/seed-adapters.ts';
import {
  createSeedTestAlert,
  createSeedTestService,
} from '../email/seed-test.ts';
import { createResendProvider } from '../email/providers/resend.ts';
import { createBrevoProvider } from '../email/providers/brevo.ts';
import { createEmailReconciliationJob } from '../email/reconcile.ts';
import {
  createBrevoContactSyncJob,
  runBrevoContactSync,
} from '../email/brevo-sync.ts';
import {
  createBroadcastSeedSender,
  createBroadcastSeedTest,
} from '../email/broadcast-seed.ts';
import {
  createResendDispatcher,
  runResendDispatch,
} from '../email/resend-dispatch.ts';
import { createRateLimitRetentionJob } from '../ratelimit/retention.ts';
import { createIpPrefixRetentionJob } from '../fraud/retention.ts';
import { createStrandedReferralReconciliationJob } from '../referral/reconcile-stranded.ts';
import { createReferralCounterRepairJob } from '../referral/counter-repair.ts';
import { createAlertWebhookTransport } from '../verification-rate/p1-webhook.ts';
import { createVerificationRateMonitor } from '../verification-rate/service.ts';
import { createVerificationTokenRetentionJob } from '../verification/retention.ts';
import { createFlagService } from '../flags/service.ts';
import { createGiveawayEntryReconciliationJob } from '../giveaway/reconcile.ts';
import { currentRulesFromFiles } from '../giveaway/current-rules-file.ts';
import { createDrawService } from '../giveaway/draw.ts';
import { createDrawWorker } from '../giveaway/draw-worker.ts';
import { createAwardService } from '../giveaway/award.ts';
import { createRankingIntegrityService } from '../referral/ranking.ts';
import {
  createSharedLeaderboardSnapshotStore,
  runSharedSnapshotRefresh,
} from '../leaderboard/persisted.ts';
import { createWeeklyCampaignJob } from '../email/weekly-campaign.ts';
import { createEmailQueue } from '../email/queue.ts';
import { createEmailQuotaService } from '../email/quota.ts';

import { createUnverifiedExpiryJob } from './expiry.ts';
import {
  createMaintenanceFailureReporter,
  createVerificationMaintenanceScheduler,
} from './maintenance.ts';
import { createVerificationReminderJob } from './reminder.ts';

const database = createPool(getDatabaseUrl());
const clock = (): Date => new Date();
const alerts = createAlertWebhookTransport(getP1AlertConfiguration());
const reportFailure = createMaintenanceFailureReporter(alerts, { clock });
const resendConfiguration = getResendDispatchConfiguration();
const brevoConfiguration = getBrevoConfiguration();
const webhookConfiguration = getEmailWebhookConfiguration();
const brevoProvider =
  brevoConfiguration === null
    ? null
    : createBrevoProvider(
        brevoConfiguration.apiKey,
        brevoConfiguration.sendingDomain,
        brevoConfiguration.listId,
      );
const broadcastFlags = createFlagService(database);
const sharedSnapshot = createSharedLeaderboardSnapshotStore(
  database,
  createRankingIntegrityService(database),
  clock,
);
const seedConfiguration = getSeedTestConfiguration();
const seedTest =
  seedConfiguration === null
    ? undefined
    : createSeedTestService(
        createSeedTestRepository(database),
        createResendSeedSender(
          createResendProvider(
            resendConfiguration.resendApiKey,
            resendConfiguration.resendSendingDomain,
          ),
          seedConfiguration,
        ),
        createImapSeedMailbox(seedConfiguration),
        createSeedTestAlert(alerts),
        clock,
      );
const broadcastSeedTest =
  seedConfiguration === null || brevoProvider === null
    ? undefined
    : createBroadcastSeedTest(
        database,
        createBroadcastSeedSender(
          brevoProvider,
          {
            gmail: seedConfiguration.gmail.address,
            outlook: seedConfiguration.outlook.address,
            gmx: seedConfiguration.gmx.address,
            web_de: seedConfiguration.web_de.address,
          },
          resendConfiguration.emailBaseUrl,
        ),
        createImapSeedMailbox(seedConfiguration),
        alerts,
        clock,
      );

async function reportVerificationRateCollapse(alert: {
  readonly baselineRate: number;
  readonly currentRate: number;
  readonly measuredAt: Date;
  readonly relativeDrop: number;
  readonly severity: 'P1';
}): Promise<void> {
  await alerts.send({
    detail: {
      baseline_rate: alert.baselineRate,
      current_rate: alert.currentRate,
      relative_drop: alert.relativeDrop,
    },
    event: 'verification_rate_collapsed',
    occurredAt: alert.measuredAt,
    severity: alert.severity,
  });
}

const scheduler = createVerificationMaintenanceScheduler(
  {
    giveawayEntryReconciliation: createGiveawayEntryReconciliationJob(
      database,
      createFlagService(database),
      currentRulesFromFiles,
    ),
    expiry: createUnverifiedExpiryJob(database, { clock }),
    ipPrefixRetention: createIpPrefixRetentionJob(database, { clock }),
    rateLimitRetention: createRateLimitRetentionJob(database, { clock }),
    referralCounterRepair: createReferralCounterRepairJob(database, {
      alert: (alert) => alerts.send(alert),
    }),
    reminder: createVerificationReminderJob(database, { clock }),
    strandedReferral: createStrandedReferralReconciliationJob(database, {
      clock,
    }),
    verificationRate: createVerificationRateMonitor(
      database,
      getVerificationRateConfiguration(),
      { alert: reportVerificationRateCollapse, clock },
    ),
    verificationTokenRetention: createVerificationTokenRetentionJob(database, {
      clock,
    }),
    seedTest,
    broadcastSeedTest,
    emailReconciliation: createEmailReconciliationJob(
      database,
      brevoProvider,
      alerts,
      clock,
      webhookConfiguration.resendWebhookGapMinutes,
    ),
    weeklyCampaign: createWeeklyCampaignJob({
      database,
      flags: broadcastFlags,
      snapshot: sharedSnapshot,
      email: createEmailQueue(database, clock),
      alerts,
      clock,
      tokenSecret: resendConfiguration.emailTokenSecret,
      schedule: getWeeklySendConfiguration(),
    }),
    emailQuota: createEmailQuotaService(
      database,
      getEmailQuotaConfiguration(),
      alerts,
      clock,
    ),
    leaderboardSnapshotPurge: {
      async run(limit) {
        let removed = 0;
        for (let batch = 0; batch < 1_000; batch += 1) {
          const count = await sharedSnapshot.purge(limit);
          removed += count;
          if (count < limit) break;
        }
        return removed;
      },
    },
  },
  { clock, reportFailure },
);

const shutdown = new AbortController();
const stop = (): void => shutdown.abort();

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const drawWorker = createDrawWorker(
  createDrawService(database, createFlagService(database), alerts, {
    config: getDrandConfiguration(),
  }),
  alerts,
  clock,
  createAwardService(database, { flags: createFlagService(database), clock }),
);

const running = [
  runSharedSnapshotRefresh(sharedSnapshot, shutdown.signal, () =>
    reportFailure('leaderboard_snapshot'),
  ),
  checkDomainAuthenticationAtStartup({
    alerts,
    clock,
    configuration: {
      ...resendConfiguration.resendDomainAuthentication,
      sendingDomain: resendConfiguration.resendSendingDomain,
    },
    writeLog: (line) => process.stderr.write(line),
  }),
  scheduler.run(undefined, shutdown.signal),
  drawWorker.run(shutdown.signal),
  runResendDispatch(
    createResendDispatcher(
      database,
      resendConfiguration,
      alerts,
      clock,
      undefined,
      {
        provider: brevoProvider,
        isEnabled: () => broadcastFlags.isEnabled('email.broadcast'),
      },
    ),
    alerts,
    clock,
    shutdown.signal,
  ),
  runBrevoContactSync(
    createBrevoContactSyncJob(database, broadcastFlags, brevoProvider, clock),
    alerts,
    clock,
    shutdown.signal,
  ),
];

try {
  await Promise.all(running);
} finally {
  shutdown.abort();
  await Promise.allSettled(running);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await database.close();
}
