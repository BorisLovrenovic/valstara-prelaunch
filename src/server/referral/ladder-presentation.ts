import { referralLadderCopy } from '../../copy/referral-ladder.ts';

import {
  accessWindowBands,
  accessWindowForReferrals,
  assertCouponLadder,
  computeCouponLadder,
  couponLadder,
  waveOneEarlyAccessMonth,
  waveOneReferralThreshold,
  type AccessWindow,
  type AccessWindowBand,
  type CouponLadder,
  type LadderCoupon,
} from './config.ts';
import type { PartnerWaveReason } from './status.ts';

/**
 * Everything the ladder copy states, as configuration (E11.7-04). Every
 * surface — the landing page, /verify, /me and the referral emails — reads its
 * figures through this, so changing the configuration changes the copy.
 */
export interface LadderPresentationConfiguration {
  readonly ladder: CouponLadder;
  readonly waveOneReferrals: number;
  readonly bands: readonly AccessWindowBand[];
  /** `YYYY-MM`. */
  readonly earlyAccessMonth: string;
}

export const ladderPresentationConfiguration: LadderPresentationConfiguration =
  Object.freeze({
    ladder: couponLadder,
    waveOneReferrals: waveOneReferralThreshold,
    bands: accessWindowBands,
    earlyAccessMonth: waveOneEarlyAccessMonth,
  });

/** "September 2027", from the configured `YYYY-MM`. */
export function earlyAccessMonthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  const date =
    match === null
      ? null
      : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  if (
    match === null ||
    date === null ||
    date.getUTCMonth() !== Number(match[2]) - 1
  ) {
    throw new RangeError('The early-access month must be a valid YYYY-MM.');
  }
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * "Sep 2027", from the configured `YYYY-MM`: the short month for the early-access
 * fact, whose box holds one line (founder, 2026-11-24). Sentences keep the full
 * month from `earlyAccessMonthLabel`.
 */
export function earlyAccessMonthShortLabel(month: string): string {
  // Validates the month exactly as the full label does.
  earlyAccessMonthLabel(month);
  const [year, monthNumber] = month.split('-').map(Number);
  // en-US, because en-GB abbreviates September as "Sept".
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

/** Every count at which the ladder changes, ascending. */
function ladderMarks(ladder: CouponLadder): readonly number[] {
  assertCouponLadder(ladder);
  const levels = Math.ceil(ladder.maximumPercent / ladder.stepPercent);
  const marks = ladder.unlocks.flatMap((unlock) =>
    Array.from(
      { length: levels },
      (_, level) => unlock + level * ladder.stepReferrals,
    ),
  );
  return [...new Set(marks)].sort((left, right) => left - right);
}

export interface LadderNextStep {
  /** The count the meter starts from: the last step reached, or 0. */
  readonly from: number;
  /** The count of the next step. */
  readonly target: number;
  readonly remaining: number;
  readonly coupon: LadderCoupon;
  /** True when the next step unlocks a coupon rather than raising one. */
  readonly unlocksCoupon: boolean;
}

export interface LadderProgress {
  readonly confirmedReferrals: number;
  readonly coupons: readonly LadderCoupon[];
  readonly next: LadderNextStep | null;
  /** The founder's form: "Coupon 1: 30% · Coupon 2: 10% · 2 more confirmed referrals to 15%." */
  readonly line: string;
  readonly held: string;
}

export function ladderProgress(
  confirmedReferrals: number,
  configuration: LadderPresentationConfiguration = ladderPresentationConfiguration,
): LadderProgress {
  const { ladder } = configuration;
  const coupons = computeCouponLadder(confirmedReferrals, ladder);
  const marks = ladderMarks(ladder);
  const target = marks.find((mark) => mark > confirmedReferrals);
  let next: LadderNextStep | null = null;
  if (target !== undefined) {
    const reached = computeCouponLadder(target, ladder);
    const coupon = reached.find(
      (candidate) =>
        coupons.find(({ number }) => number === candidate.number)?.percent !==
        candidate.percent,
    );
    if (coupon === undefined) {
      throw new Error('A ladder step must change one coupon.');
    }
    next = {
      from: marks.filter((mark) => mark <= confirmedReferrals).at(-1) ?? 0,
      target,
      remaining: target - confirmedReferrals,
      coupon,
      unlocksCoupon: !coupons.some(({ number }) => number === coupon.number),
    };
  }
  const parts = [
    ...coupons.map(({ number, percent }) =>
      referralLadderCopy.coupon(number, percent),
    ),
    next === null
      ? referralLadderCopy.complete
      : next.unlocksCoupon
        ? referralLadderCopy.nextCoupon(
            next.remaining,
            next.coupon.number,
            next.coupon.percent,
          )
        : referralLadderCopy.nextPercent(next.remaining, next.coupon.percent),
  ];
  return {
    confirmedReferrals,
    coupons,
    next,
    line: `${parts.join(referralLadderCopy.separator)}.`,
    held: referralLadderCopy.held(ladder.expiryYears),
  };
}

export type WaveOneReason =
  'first_members' | 'referrals' | PartnerWaveReason | null;

export interface EarlyAccess {
  readonly inWaveOne: boolean;
  readonly reason: WaveOneReason;
  /** Confirmed referrals still needed; 0 in wave 1. */
  readonly remaining: number;
  readonly month: string;
  readonly line: string;
}

/**
 * Whether the member gets early access, and why or what earns it (founder,
 * 2026-11-17). It applies the recompute's own rule to the member's state.
 */
export function earlyAccess(
  state: {
    readonly accessWindow: AccessWindow | null;
    readonly partnerWaveReason?: PartnerWaveReason | undefined;
    readonly verificationOrderWindow: AccessWindow | null;
    readonly confirmedReferrals: number;
  },
  configuration: LadderPresentationConfiguration = ladderPresentationConfiguration,
): EarlyAccess {
  const month = earlyAccessMonthLabel(configuration.earlyAccessMonth);
  const threshold = configuration.waveOneReferrals;
  const inWaveOne =
    state.partnerWaveReason !== undefined ||
    (state.verificationOrderWindow === null
      ? state.accessWindow === 'wave-1' || state.confirmedReferrals >= threshold
      : accessWindowForReferrals(
          state.verificationOrderWindow,
          state.confirmedReferrals,
          threshold,
        ) === 'wave-1');
  if (!inWaveOne) {
    const remaining = threshold - state.confirmedReferrals;
    return {
      inWaveOne,
      reason: null,
      remaining,
      month,
      line: referralLadderCopy.waveOne.notYet(month, remaining),
    };
  }
  const reason: WaveOneReason =
    state.verificationOrderWindow === 'wave-1'
      ? 'first_members'
      : state.confirmedReferrals >= threshold
        ? 'referrals'
        : (state.partnerWaveReason ?? null);
  const firstMembers =
    configuration.bands.find(({ window }) => window === 'wave-1')
      ?.maximumVerificationOrder ?? null;
  return {
    inWaveOne,
    reason,
    remaining: 0,
    month,
    line:
      reason === 'first_members' && firstMembers !== null
        ? referralLadderCopy.waveOne.firstMembers(
            month,
            firstMembers.toLocaleString('en-US'),
          )
        : reason === 'referrals'
          ? referralLadderCopy.waveOne.referrals(month, threshold)
          : reason === 'active_partner'
            ? referralLadderCopy.waveOne.activePartner(month)
            : reason === 'partner_referral'
              ? referralLadderCopy.waveOne.partnerReferral(month)
              : referralLadderCopy.waveOne.other(month),
  };
}

export interface LandingLadder {
  readonly threshold: number;
  readonly percent: number;
  /** Set when the first coupon's unlock also puts a member in wave 1. */
  readonly earlyAccessMonth: string | null;
  readonly sentence: string;
  readonly steps: string;
  readonly moreCoupons: string | null;
  /**
   * When early access opens or, when wave 1's threshold differs from the
   * first unlock, what earns it.
   */
  readonly waveOne: string;
  readonly held: string;
}

/** The landing page's referral card, from configuration alone. */
export function landingLadder(
  configuration: LadderPresentationConfiguration = ladderPresentationConfiguration,
): LandingLadder {
  const { ladder } = configuration;
  assertCouponLadder(ladder);
  const [threshold, ...later] = ladder.unlocks as [number, ...number[]];
  const month = earlyAccessMonthLabel(configuration.earlyAccessMonth);
  const together = configuration.waveOneReferrals === threshold;
  const earlyAccessMonth = together ? month : null;
  return {
    threshold,
    percent: ladder.stepPercent,
    earlyAccessMonth,
    sentence: referralLadderCopy.landing.sentence(
      threshold,
      ladder.stepPercent,
      earlyAccessMonth,
    ),
    steps: referralLadderCopy.landing.steps(
      ladder.stepPercent,
      ladder.stepReferrals,
      ladder.maximumPercent,
    ),
    moreCoupons:
      later.length === 0
        ? null
        : referralLadderCopy.landing.moreCoupons(
            later.map((_, index) => index + 2),
            later,
          ),
    waveOne: together
      ? referralLadderCopy.landing.earlyAccessOpens(month)
      : referralLadderCopy.landing.waveOne(
          configuration.waveOneReferrals,
          month,
        ),
    held: referralLadderCopy.landing.held(ladder.expiryYears),
  };
}
