import { randomUUID } from 'node:crypto';

import { marketingOptInSixteenCopy } from '../../copy/marketing.ts';
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
  /** The wording version the 18+ page shows; the 16+ one replaces it while `waitlist.age_13` is on. */
  readonly version: string;
  /** E11.8-06: the /me form's "I'm 16 or over" box was ticked. */
  readonly ageAffirmed?: boolean;
}

/**
 * `affirmation_required`: a grant while `waitlist.age_13` is on without the
 * 16+ affirmation. `grant_paused`: a grant for a member admitted under the
 * 13+ policy while the flag is off (E11.8-06, D-082). Withdrawal is never
 * refused.
 */
export type MarketingChangeOutcome =
  | 'accepted'
  | 'affirmation_required'
  | 'disabled'
  | 'grant_paused'
  | 'rate_limited';

/**
 * What turning marketing email on asks of the member on `/me` (E11.8-06):
 * nothing more, the 16+ affirmation while `waitlist.age_13` is on, or nothing
 * at all because new grants are paused for a member admitted under the 13+
 * policy while the flag is off.
 */
export type MarketingGrantRequirement =
  'none' | 'sixteen_affirmation' | 'paused';

export interface MarketingService {
  change(input: MarketingChangeInput): Promise<MarketingChangeOutcome>;
  preference(subscriberId: string): Promise<boolean>;
  grantRequirement(subscriberId: string): Promise<MarketingGrantRequirement>;
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
    async grantRequirement(subscriberId) {
      if (await dependencies.flags.isEnabled('waitlist.age_13'))
        return 'sixteen_affirmation';
      const row =
        await createMarketingRepository(database).findPreference(subscriberId);
      return row?.admission_age_policy === '13_plus' ? 'paused' : 'none';
    },
    async change(input) {
      if (!(await dependencies.flags.isEnabled('member.dashboard')))
        return 'disabled';
      // E11.8-06: while the waitlist is open at 13, a new grant needs the
      // 16+ affirmation and records the 16+ wording version (D-082 Q1).
      const ageThirteen = await dependencies.flags.isEnabled('waitlist.age_13');
      if (input.marketing === 'on' && ageThirteen && input.ageAffirmed !== true)
        return 'affirmation_required';
      const grantVersion = ageThirteen
        ? marketingOptInSixteenCopy.version
        : input.version;
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
        // A member admitted under the 13+ policy takes no new grant while the
        // waitlist is 18 and over; turning it off stays available.
        if (
          input.marketing === 'on' &&
          !ageThirteen &&
          preference.admission_age_policy === '13_plus'
        )
          return 'grant_paused';

        const audit = createAuditService(connection);
        if (input.marketing === 'on') {
          await marketing.grant(subscriberId, grantVersion, now);
          await audit.record({
            action: 'consent.marketing_granted',
            actor: 'subscriber',
            detail: { source: 'member_status', version: grantVersion },
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
