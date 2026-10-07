import type { ReferralAttributionConfiguration } from '../config.ts';
import type { DatabasePool } from '../db/pool.ts';
import type { FlagService } from '../flags/types.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';
import { runReferralAttributionCheck } from './attribution-health.ts';
import { createReferralService } from './service.ts';

export function createReferralAttributionMaintenanceJob(
  database: DatabasePool,
  flags: Pick<FlagService, 'isEnabled'>,
  configuration: ReferralAttributionConfiguration,
  alerts: AlertTransport,
  clock: () => Date,
): { run(): Promise<void> } {
  return {
    async run() {
      await runReferralAttributionCheck(
        createReferralService(database, {
          attributionConfiguration: configuration,
          isReferralEnabled: () => flags.isEnabled('referral.enabled'),
          clock,
        }).attributionHealth,
        (result) =>
          alerts.send({
            detail: {
              baseline_share: result.baselineShare,
              current_share: result.currentShare,
              relative_drop: result.relativeDrop,
            },
            event: 'referral_attribution_collapsed',
            occurredAt: result.measuredAt,
            severity: result.severity,
          }),
      );
    },
  };
}
