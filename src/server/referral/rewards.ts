import { randomUUID } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
import type { DatabaseConnection } from '../db/pool.ts';
import { createReferralRepository } from '../db/referral.ts';
import { createPartnerAttributionRepository } from '../db/partner-attribution.ts';
import {
  createReferralCouponRepository,
  type ReferralCouponRow,
} from '../db/referral-coupon.ts';

import {
  accessWindowForReferrals,
  computeCouponLadder,
  couponLadder,
  waveOneReferralThreshold,
  type AccessWindow,
  type CouponLadder,
} from './config.ts';
import { couponTransition, type CouponState } from './reward-state.ts';

// E11.7-03: the coupon ladder and wave 1 replace ADR-025's milestone tiers.
// Both are derived state. This is their one recompute, called inside the
// transaction of every confirmation (ReferralService.confirm), every void and
// un-void (ReferralVoidService), the daily repair (recomputeCounters) and the
// handoff's recompute of every verified subscriber (exportHandoff, D-047), so
// the stored coupons and wave always equal what the current confirmed,
// non-voided count gives.

/** The figures the recompute applies: configuration, not schema. */
export interface ReferralRewardConfiguration {
  readonly ladder: CouponLadder;
  /** Confirmed, non-voided referrals that put a member in wave 1. */
  readonly waveOneReferrals: number;
}

export const referralRewardConfiguration: ReferralRewardConfiguration =
  Object.freeze({
    ladder: couponLadder,
    waveOneReferrals: waveOneReferralThreshold,
  });

export interface RecomputedCoupon {
  readonly number: number;
  readonly percent: number | null;
  readonly state: CouponState;
}

export interface ReferralRewardRecompute {
  readonly confirmedReferrals: number;
  readonly coupons: readonly RecomputedCoupon[];
  /** The access window after the recompute; null before verification. */
  readonly accessWindow: AccessWindow | null;
  /** True when any stored value differed and was rewritten. */
  readonly changed: boolean;
}

export interface ReferralRewardRecomputeOptions {
  /** Who caused the change, recorded on any wave change. */
  readonly actor: string;
  readonly now: Date;
  readonly configuration?: ReferralRewardConfiguration;
}

/**
 * Recomputes one referrer's confirmed count, tier cache, coupons and access
 * window from their confirmed, non-voided edges. The caller holds the
 * referrer's row lock in the same transaction, so concurrent confirmations and
 * voids for one referrer serialise and each recompute sees the others.
 *
 * Coupons only ever move along `couponTransitions`: a coupon is created held,
 * changes its percent, falls to void below its unlock, and returns to held. No
 * path here, or anywhere in this repository, makes one `settled` (ADR-012).
 */
export async function recomputeReferralRewards(
  connection: DatabaseConnection,
  subscriberId: string,
  options: ReferralRewardRecomputeOptions,
): Promise<ReferralRewardRecompute> {
  const configuration = options.configuration ?? referralRewardConfiguration;
  const referrals = createReferralRepository(connection);
  const coupons = createReferralCouponRepository(connection);

  const confirmedReferrals = await referrals.countConfirmedEdges(subscriberId);
  const tier = await referrals.findSettledReferralTier(subscriberId);
  let changed = await referrals.repairReferralCounterAndTier(
    subscriberId,
    confirmedReferrals,
    tier,
  );

  const target = computeCouponLadder(confirmedReferrals, configuration.ladder);
  const stored = await coupons.listCoupons(subscriberId);
  const storedByNumber = new Map<number, ReferralCouponRow>(
    stored.map((row) => [row.coupon_number, row]),
  );
  const highest = Math.max(
    configuration.ladder.unlocks.length,
    ...stored.map((row) => row.coupon_number),
  );
  const result: RecomputedCoupon[] = [];
  for (let number = 1; number <= highest; number += 1) {
    const earned = target.find((coupon) => coupon.number === number);
    const row = storedByNumber.get(number);
    if (earned !== undefined) {
      if (row === undefined) {
        couponTransition('none', 'held');
        await coupons.insertCoupon(
          randomUUID(),
          subscriberId,
          number,
          earned.percent,
          options.now,
        );
        changed = true;
      } else if (row.state !== 'held' || row.percent !== earned.percent) {
        couponTransition(row.state, 'held');
        await requireOne(
          coupons.updateCoupon(row.id, 'held', earned.percent, options.now),
        );
        changed = true;
      }
      result.push({ number, percent: earned.percent, state: 'held' });
    } else if (row !== undefined) {
      if (row.state !== 'void') {
        couponTransition(row.state, 'void');
        await requireOne(
          coupons.updateCoupon(row.id, 'void', null, options.now),
        );
        changed = true;
      }
      result.push({ number, percent: null, state: 'void' });
    }
  }

  const waves = await coupons.findWaves(subscriberId);
  if (waves === null) {
    throw new Error('A referral recompute subscriber could not be read.');
  }
  let accessWindow = waves.access_window;
  // A member with no recorded verification-order window has not verified
  // through E3-07; their window is assigned at verification, not here.
  if (waves.verification_order_window !== null) {
    const perks =
      await createPartnerAttributionRepository(connection).findPerks(
        subscriberId,
      );
    const window =
      perks?.active_partner || perks?.welcome_discount_pct != null
        ? 'wave-1'
        : accessWindowForReferrals(
            waves.verification_order_window,
            confirmedReferrals,
            configuration.waveOneReferrals,
          );
    if (window !== waves.access_window) {
      await requireOne(coupons.setAccessWindow(subscriberId, window));
      await createAuditService(connection).record({
        action: 'referral.access_window_recalculated',
        actor: options.actor,
        detail: {
          confirmedReferrals,
          fromWindow: waves.access_window,
          toWindow: window,
          verificationOrderWindow: waves.verification_order_window,
        },
        subjectId: subscriberId,
        subjectType: 'subscriber',
      });
      accessWindow = window;
      changed = true;
    }
  }

  return { accessWindow, changed, confirmedReferrals, coupons: result };
}

async function requireOne(write: Promise<number>): Promise<void> {
  if ((await write) !== 1) {
    throw new Error('A referral reward recompute write did not apply.');
  }
}
