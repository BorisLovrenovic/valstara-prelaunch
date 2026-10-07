import type { AppConfig } from '../config.ts';
import {
  createAdminHealthRepository,
  type AdminHealthCounts,
} from '../db/admin-health.ts';
import type { DatabasePool } from '../db/pool.ts';
import {
  createPurgeJobRunRepository,
  type PurgeJobRunRow,
} from '../db/purge-job-run.ts';
import { createSeedTestRepository } from '../db/seed-test.ts';
import {
  domainAuthenticationHealth,
  type SendingDomainAuthenticationHealth,
} from '../email/domain-authentication.ts';
import { quotaHealth, type EmailQuotaHealth } from '../email/quota.ts';
import { seedTestHealth, type SeedTestHealth } from '../email/seed-test.ts';
import type { ReferralAttributionHealth } from '../referral/attribution-health.ts';
import { createReferralService } from '../referral/service.ts';
import {
  createVerificationRateMonitor,
  type VerificationRateHealth,
} from '../verification-rate/service.ts';

import { purgeJobHealth } from './purge-status.ts';

export function createAdminHealthService(
  database: DatabasePool,
  configuration: AppConfig,
  clock: () => Date = () => new Date(),
  domainHealth: (
    clock: () => Date,
  ) => Promise<readonly SendingDomainAuthenticationHealth[]> = (fixedClock) =>
    domainAuthenticationHealth({
      clock: fixedClock,
      configuration: {
        ...configuration.resendDomainAuthentication,
        sendingDomain: configuration.resendSendingDomain,
      },
    }),
) {
  const counts = createAdminHealthRepository(database);
  const purgeRuns = createPurgeJobRunRepository(database);
  const seeds = createSeedTestRepository(database);
  return createAdminHealthServiceWithSources(
    (fixedClock) => ({
      verification: () =>
        createVerificationRateMonitor(
          database,
          configuration.verificationRate,
          {
            clock: fixedClock,
          },
        ).health(),
      attribution: () =>
        createReferralService(database, {
          attributionConfiguration: configuration.referralAttribution,
          clock: fixedClock,
        }).attributionHealth(),
      counts: () => counts.counts(),
      domains: () => domainHealth(fixedClock),
      seedTest: () => seedTestHealth(seeds, fixedClock),
      quota: () => quotaHealth(database, configuration.emailQuota, fixedClock),
      purges: () => purgeRuns.list(),
    }),
    clock,
  );
}

export interface AdminHealthSources {
  readonly verification: () => Promise<VerificationRateHealth>;
  readonly attribution: () => Promise<ReferralAttributionHealth>;
  readonly counts: () => Promise<AdminHealthCounts>;
  readonly domains: () => Promise<readonly SendingDomainAuthenticationHealth[]>;
  readonly seedTest: () => Promise<SeedTestHealth>;
  readonly quota: () => Promise<EmailQuotaHealth>;
  readonly purges: () => Promise<readonly PurgeJobRunRow[]>;
}

export function createAdminHealthServiceWithSources(
  sources: (clock: () => Date) => AdminHealthSources,
  clock: () => Date,
) {
  return {
    async health() {
      const measuredAt = clock();
      const fixedClock = (): Date => measuredAt;
      const source = sources(fixedClock);
      const [
        verification,
        attribution,
        databaseCounts,
        domains,
        seedTest,
        quota,
        purgeRows,
      ] = await Promise.all([
        source.verification(),
        source.attribution(),
        source.counts(),
        source.domains(),
        source.seedTest(),
        source.quota(),
        source.purges(),
      ]);
      const snapshotAt = databaseCounts.latestSnapshotAt;
      return {
        measuredAt,
        verification: {
          state: verification.state,
          measuredAt: verification.measuredAt,
          baseline: {
            rate: verification.baseline.rate,
            signups: verification.baseline.signups,
            verified: verification.baseline.verified,
          },
          current: {
            rate: verification.current.rate,
            signups: verification.current.signups,
            verified: verification.current.verified,
          },
          providers: verification.providers.map((provider) => ({
            provider: provider.provider,
            rate: provider.rate,
            signups: provider.signups,
            verified: provider.verified,
          })),
        },
        attribution: {
          state: attribution.state,
          measuredAt: attribution.measuredAt,
          baseline:
            attribution.baseline === null
              ? null
              : {
                  share: attribution.baseline.share,
                  signups: attribution.baseline.signups,
                  attributed: attribution.baseline.attributed,
                },
          current:
            attribution.current === null
              ? null
              : {
                  share: attribution.current.share,
                  signups: attribution.current.signups,
                  attributed: attribution.current.attributed,
                },
        },
        snapshot: {
          asOf: snapshotAt,
          ageSeconds:
            snapshotAt === null
              ? null
              : Math.max(
                  0,
                  (measuredAt.getTime() - snapshotAt.getTime()) / 1_000,
                ),
        },
        emailQueue: { queued: databaseCounts.queuedEmails },
        domainAuthentication: domains.map((domain) => ({
          domain: domain.domain,
          checkedAt: domain.checkedAt,
          spf: { passed: domain.spf.passed, reason: domain.spf.reason },
          dkim: { passed: domain.dkim.passed, reason: domain.dkim.reason },
          dmarc: {
            passed: domain.dmarc.passed,
            reason: domain.dmarc.reason,
            policy: domain.dmarc.policy,
          },
        })),
        seedTest: {
          weekStart: seedTest.weekStart,
          checkedAt: seedTest.checkedAt,
          state: seedTest.state,
          providers: seedTest.providers.map((provider) => ({
            provider: provider.provider,
            placement: provider.placement,
            sentAt: provider.sentAt,
            checkedAt: provider.checkedAt,
          })),
        },
        quota: {
          checkedAt: quota.checkedAt,
          providers: quota.providers.map((provider) => ({
            provider: provider.provider,
            tier: provider.tier,
            cap: provider.cap,
            dailyConsumption: provider.dailyConsumption.map((day) => ({
              day: day.day,
              accepted: day.accepted,
            })),
            todayConsumption: provider.todayConsumption,
            forecast: provider.forecast,
            alertState: provider.alertState,
          })),
        },
        purges: purgeJobHealth(purgeRows, measuredAt),
        openFlags: databaseCounts.openFlags,
      };
    },
  };
}
