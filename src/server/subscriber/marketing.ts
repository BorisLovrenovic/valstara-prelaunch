import { randomUUID } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import { createMarketingRepository } from '../db/marketing.ts';
import type { DatabasePool } from '../db/pool.ts';
import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';
import { withTransaction } from '../db/transaction.ts';
import type { FlagService } from '../flags/types.ts';
import { createVerificationService } from '../verification/service.ts';

export const marketingWindowMs = 15 * 60 * 1_000;
export const marketingIpLimit = 5;
export const marketingStrictIpLimit = 2;
export const marketingSubscriberLimit = 5;

export interface MarketingChangeInput {
  readonly challengeTimedOut: boolean;
  readonly ipPrefixHash: string;
  readonly marketing: 'on' | 'off';
  readonly token: string;
  readonly version: string;
}

export type MarketingChangeOutcome = 'accepted' | 'disabled' | 'rate_limited';

export interface MarketingService {
  change(input: MarketingChangeInput): Promise<MarketingChangeOutcome>;
  preference(subscriberId: string): Promise<boolean>;
}

export function createMarketingService(
  database: DatabasePool,
  dependencies: {
    readonly flags: Pick<FlagService, 'isEnabled'>;
    readonly clock?: () => Date;
    readonly onWithdrawal?: () => void;
  },
): MarketingService {
  const clock = dependencies.clock ?? (() => new Date());
  return {
    async preference(subscriberId) {
      const row =
        await createMarketingRepository(database).findPreference(subscriberId);
      return row?.status === 'verified' && row.marketing_consent_at !== null;
    },
    async change(input) {
      if (!(await dependencies.flags.isEnabled('member.dashboard')))
        return 'disabled';
      if (input.ipPrefixHash === '') return 'rate_limited';

      let withdrawn = false;
      const outcome = await withTransaction(database, async (connection) => {
        const now = clock();
        const windowThreshold = new Date(now.getTime() - marketingWindowMs);
        const limits = createRateLimitBucketRepository(connection);
        const ipCount = await limits.consume(
          `marketing:ip:${input.challengeTimedOut ? 'strict:' : ''}${input.ipPrefixHash}`,
          now,
          windowThreshold,
        );
        if (
          ipCount >
          (input.challengeTimedOut ? marketingStrictIpLimit : marketingIpLimit)
        ) {
          return 'rate_limited';
        }

        const authentication = await createVerificationService(connection, {
          clock,
        }).consumeForPurpose(input.token, 'status');
        if (
          (authentication.outcome !== 'verified' &&
            authentication.outcome !== 'already') ||
          authentication.subscriberId === null
        ) {
          return 'accepted';
        }

        const subscriberId = authentication.subscriberId;
        const subscriberCount = await limits.consume(
          `marketing:subscriber:${subscriberId}`,
          now,
          windowThreshold,
        );
        if (subscriberCount > marketingSubscriberLimit) return 'rate_limited';

        const marketing = createMarketingRepository(connection);
        const preference = await marketing.findPreference(subscriberId, true);
        if (preference?.status !== 'verified') return 'accepted';

        if (input.challengeTimedOut) {
          await createFraudFlagRepository(
            connection,
          ).insertChallengeTimeoutFlag({
            id: randomUUID(),
            subscriberId,
          });
        }

        const currentlyOn = preference.marketing_consent_at !== null;
        if ((input.marketing === 'on') === currentlyOn) return 'accepted';

        const audit = createAuditService(connection);
        if (input.marketing === 'on') {
          await marketing.grant(subscriberId, input.version, now);
          await audit.record({
            action: 'consent.marketing_granted',
            actor: 'subscriber',
            detail: { source: 'member_status', version: input.version },
            subjectId: subscriberId,
            subjectType: 'subscriber',
          });
        } else {
          await marketing.withdraw(subscriberId, now);
          await audit.record({
            action: 'consent.marketing_withdrawn',
            actor: 'subscriber',
            detail: { source: 'member_status' },
            subjectId: subscriberId,
            subjectType: 'subscriber',
          });
          withdrawn = true;
        }
        return 'accepted';
      });
      if (withdrawn) {
        try {
          dependencies.onWithdrawal?.();
        } catch {
          // A committed preference cannot fail because telemetry is unavailable.
        }
      }
      return outcome;
    },
  };
}
