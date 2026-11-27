import { randomUUID } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
import { getGiveawayEntryPeriodStart } from '../config.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import { createGiveawayOptInRepository } from '../db/giveaway-opt-in.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';
import { withTransaction } from '../db/transaction.ts';
import { createTransactionalEmailProducers } from '../email/producers.ts';
import type { FlagService } from '../flags/types.ts';
import { createVerificationService } from '../verification/service.ts';

import {
  createGiveawayAccrualServiceInTransaction,
  giveawayEntryPeriodEnd,
  type CurrentGiveawayRules,
} from './accrue.ts';
import {
  giveawayBoxPolicy,
  needsGiveawayBox,
  waitlistAgeSettings,
  type WaitlistAgeSettings,
} from './age-policy.ts';

export const giveawayEntryWindowMs = 15 * 60 * 1_000;
export const giveawayEntryIpLimit = 5;
export const giveawayEntryStrictIpLimit = 2;
export const giveawayEntrySubscriberLimit = 5;
/** Maximum confirmed edges read at once while recording a member's entry. */
export const memberEntryReferralLimit = 1_000;

/** Entries are open from the period start until the close (E11.8-05). */
export function giveawayEntriesOpen(
  now: Date,
  periodStart: Date | null,
): boolean {
  return (
    periodStart !== null &&
    now.getTime() >= periodStart.getTime() &&
    now.getTime() < giveawayEntryPeriodEnd.getTime()
  );
}

export interface GiveawayMemberEntryInput {
  readonly challengeTimedOut: boolean;
  readonly ipPrefixHash: string;
  readonly token: string;
}

/**
 * `accepted` covers a first entry, a repeat and an invalid status link alike,
 * so the response never says which. `closed` is after entries close.
 */
export type GiveawayMemberEntryOutcome =
  'accepted' | 'closed' | 'disabled' | 'rate_limited';

/** What `/me` shows about the giveaway for the bearer (E11.8-06). */
export interface GiveawayMemberEntryView {
  /**
   * The giveaway is open and the member needs the 18+ box for their entries
   * and has not ticked it: with no entries held, `/me` says "Not entered".
   */
  readonly notEntered: boolean;
  /** The `/me` box is offered: `waitlist.age_13` is on and entries are open. */
  readonly offerBox: boolean;
}

export interface GiveawayMemberEntryDependencies {
  readonly flags: Pick<FlagService, 'isEnabled'>;
  readonly currentRules: () => CurrentGiveawayRules;
  readonly periodStart?: Date | null;
  readonly clock?: () => Date;
  readonly settings?: WaitlistAgeSettings;
  readonly receipt?: (
    connection: DatabaseConnection,
    subscriberId: string,
    rulesVersion: string,
  ) => Promise<boolean>;
  readonly onEntry?: (method: 'base' | 'referral') => void;
}

export interface GiveawayMemberEntryService {
  enter(input: GiveawayMemberEntryInput): Promise<GiveawayMemberEntryOutcome>;
  view(subscriberId: string): Promise<GiveawayMemberEntryView>;
}

/**
 * Entering the giveaway later from `/me` (E11.8-06, founder 2026-11-24). It
 * follows `POST /api/me/marketing`: the route has verified Turnstile; this
 * service rate-limits, authenticates the signed status link, and records the
 * 18+ box once, audited. It only enters: the member then holds their base
 * entry and one per confirmed referral they hold at that moment, each stamped
 * with the rules revision in force, through the same accrual and box rule as
 * a tick at signup. Marketing consent and the referral record are unchanged
 * (ADR-027). A repeat changes nothing.
 */
export function createGiveawayMemberEntryService(
  database: DatabasePool,
  dependencies: GiveawayMemberEntryDependencies,
): GiveawayMemberEntryService {
  const clock = dependencies.clock ?? (() => new Date());
  const periodStart =
    dependencies.periodStart === undefined
      ? getGiveawayEntryPeriodStart()
      : dependencies.periodStart;
  const settings = dependencies.settings ?? waitlistAgeSettings;
  const receipt =
    dependencies.receipt ??
    createTransactionalEmailProducers(database, clock).receipt;
  const { flags } = dependencies;

  async function boxOffered(now: Date): Promise<boolean> {
    return (
      (await flags.isEnabled('member.dashboard')) &&
      (await flags.isEnabled('waitlist.age_13')) &&
      (await flags.isEnabled('giveaway.open')) &&
      giveawayEntriesOpen(now, periodStart)
    );
  }

  return {
    async view(subscriberId) {
      const state =
        await createGiveawayOptInRepository(database).state(subscriberId);
      if (state?.status !== 'verified' || state.giveawayOptInAt !== null) {
        return { notEntered: false, offerBox: false };
      }
      const policy = await giveawayBoxPolicy(
        flags,
        dependencies.currentRules(),
        settings,
      );
      const needsBox = needsGiveawayBox(state, policy);
      return {
        notEntered: needsBox && (await flags.isEnabled('giveaway.open')),
        offerBox: needsBox && (await boxOffered(clock())),
      };
    },
    async enter(input) {
      const now = clock();
      if (
        !(await flags.isEnabled('member.dashboard')) ||
        !(await flags.isEnabled('waitlist.age_13')) ||
        !(await flags.isEnabled('giveaway.open'))
      ) {
        return 'disabled';
      }
      if (periodStart === null || !giveawayEntriesOpen(now, periodStart)) {
        return now.getTime() >= giveawayEntryPeriodEnd.getTime()
          ? 'closed'
          : 'disabled';
      }
      if (input.ipPrefixHash === '') return 'rate_limited';

      const entered = { base: 0, referral: 0 };
      const outcome = await withTransaction(database, async (connection) => {
        const windowThreshold = new Date(now.getTime() - giveawayEntryWindowMs);
        const limits = createRateLimitBucketRepository(connection);
        const ipCount = await limits.consume(
          `giveaway-entry:ip:${input.challengeTimedOut ? 'strict:' : ''}${input.ipPrefixHash}`,
          now,
          windowThreshold,
        );
        if (
          ipCount >
          (input.challengeTimedOut
            ? giveawayEntryStrictIpLimit
            : giveawayEntryIpLimit)
        ) {
          return 'rate_limited' as const;
        }

        const authentication = await createVerificationService(connection, {
          clock,
        }).consumeForPurpose(input.token, 'status');
        if (
          (authentication.outcome !== 'verified' &&
            authentication.outcome !== 'already') ||
          authentication.subscriberId === null
        ) {
          return 'accepted' as const;
        }

        const subscriberId = authentication.subscriberId;
        const subscriberCount = await limits.consume(
          `giveaway-entry:subscriber:${subscriberId}`,
          now,
          windowThreshold,
        );
        if (subscriberCount > giveawayEntrySubscriberLimit)
          return 'rate_limited' as const;

        const optIns = createGiveawayOptInRepository(connection);
        const state = await optIns.state(subscriberId, true);
        // A repeat, including a signup tick, has no member-side effects.
        if (state?.status !== 'verified' || state.giveawayOptInAt !== null)
          return 'accepted' as const;

        if (input.challengeTimedOut) {
          await createFraudFlagRepository(
            connection,
          ).insertChallengeTimeoutFlag({
            id: randomUUID(),
            subscriberId,
          });
        }
        const rules = dependencies.currentRules();
        if ((await optIns.recordMemberStatusOptIn(subscriberId, now)) !== 1) {
          throw new Error('The giveaway opt-in was not recorded.');
        }
        await createAuditService(connection).record({
          action: 'giveaway.opted_in',
          actor: 'subscriber',
          detail: { source: 'member_status' },
          subjectId: subscriberId,
          subjectType: 'subscriber',
        });

        // Keep the rules and flags checked for this opt-in for every page.
        // Referral confirmation takes the same referrer lock as state() above.
        const accrual = createGiveawayAccrualServiceInTransaction(
          connection,
          {
            isEnabled: async (key) =>
              key === 'giveaway.open' || key === 'waitlist.age_13',
          },
          () => rules,
          periodStart,
          receipt,
          settings,
        );
        if (await accrual.accrue(subscriberId, 'base')) entered.base = 1;
        let afterEdgeId: string | null = null;
        for (;;) {
          const page = await optIns.confirmedEdgesAsReferrer(
            subscriberId,
            periodStart,
            giveawayEntryPeriodEnd,
            memberEntryReferralLimit,
            afterEdgeId,
          );
          for (const edgeId of page) {
            if (await accrual.accrue(subscriberId, 'referral', edgeId))
              entered.referral += 1;
          }
          if (page.length < memberEntryReferralLimit) break;
          afterEdgeId = page[page.length - 1];
        }
        return 'accepted' as const;
      });
      for (const method of ['base', 'referral'] as const) {
        for (let index = 0; index < entered[method]; index += 1) {
          try {
            dependencies.onEntry?.(method);
          } catch {
            /* The committed entry is authoritative. */
          }
        }
      }
      return outcome;
    },
  };
}
