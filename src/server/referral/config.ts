export const accessWindows = ['wave-1', 'wave-2', 'wave-3', 'wave-4'] as const;
export type AccessWindow = (typeof accessWindows)[number];
export interface AccessWindowBand {
  readonly maximumVerificationOrder: number | null;
  readonly window: AccessWindow;
}

/**
 * The referrer coupon ladder (founder, 2026-11-17; ADR-025 as amended by
 * E11.7-03). This is configuration, not schema: changing a threshold, the step,
 * the maximum, the number of coupons or the launch date needs no migration.
 */
export interface CouponLadder {
  /** The confirmed-referral count at which each coupon unlocks, in coupon order. */
  readonly unlocks: readonly number[];
  /** Confirmed referrals between one step and the next. */
  readonly stepReferrals: number;
  /** The percent a coupon starts at, and adds at every step. */
  readonly stepPercent: number;
  readonly maximumPercent: number;
  /** The configured public-launch date, `YYYY-MM-DD` in UTC. */
  readonly publicLaunchDate: string;
  /** A coupon expires this many years after the public-launch date. */
  readonly expiryYears: number;
}

export const couponLadder: CouponLadder = Object.freeze({
  unlocks: Object.freeze([3, 21, 39]),
  stepReferrals: 3,
  stepPercent: 5,
  maximumPercent: 30,
  publicLaunchDate: '2027-10-01',
  expiryYears: 5,
});

/** One coupon the count earns: its number on the ladder and its percent. */
export interface LadderCoupon {
  readonly number: number;
  readonly percent: number;
}

/**
 * Every coupon a confirmed, non-voided referral count earns, in coupon order.
 * A coupon that has not unlocked is absent. The count is the only input, so a
 * void that lowers it lowers or removes the coupons, and an un-void restores
 * them exactly.
 */
export function computeCouponLadder(
  confirmedReferrals: number,
  ladder: CouponLadder = couponLadder,
): readonly LadderCoupon[] {
  if (!Number.isInteger(confirmedReferrals) || confirmedReferrals < 0) {
    throw new RangeError(
      'A confirmed referral count must be a non-negative integer.',
    );
  }
  assertCouponLadder(ladder);
  return ladder.unlocks.flatMap((unlock, index) => {
    if (confirmedReferrals < unlock) return [];
    const steps = Math.floor(
      (confirmedReferrals - unlock) / ladder.stepReferrals,
    );
    return [
      {
        number: index + 1,
        percent: Math.min(
          ladder.maximumPercent,
          ladder.stepPercent * (steps + 1),
        ),
      },
    ];
  });
}

/**
 * Every coupon's expiry: five years (configured) after the configured
 * public-launch date, at 00:00 UTC. The founder sets the real date in the
 * configuration at handoff, and the export carries the computed instant.
 */
export function couponExpiresAt(ladder: CouponLadder = couponLadder): Date {
  assertCouponLadder(ladder);
  const [year, month, day] = ladder.publicLaunchDate.split('-').map(Number);
  return new Date(Date.UTC(year! + ladder.expiryYears, month! - 1, day!));
}

export function assertCouponLadder(ladder: CouponLadder): void {
  if (ladder.unlocks.length === 0) {
    throw new RangeError('The coupon ladder must hold at least one coupon.');
  }
  let previous = 0;
  for (const unlock of ladder.unlocks) {
    if (!Number.isInteger(unlock) || unlock <= previous) {
      throw new RangeError(
        'Coupon unlocks must be increasing positive integers.',
      );
    }
    previous = unlock;
  }
  if (!Number.isInteger(ladder.stepReferrals) || ladder.stepReferrals < 1) {
    throw new RangeError(
      'A coupon step must be a positive whole number of referrals.',
    );
  }
  if (
    !Number.isInteger(ladder.stepPercent) ||
    !Number.isInteger(ladder.maximumPercent) ||
    ladder.stepPercent < 1 ||
    ladder.maximumPercent < ladder.stepPercent ||
    ladder.maximumPercent > 100
  ) {
    throw new RangeError(
      'Coupon percents must be whole numbers from the step up to at most 100.',
    );
  }
  if (!Number.isInteger(ladder.expiryYears) || ladder.expiryYears < 1) {
    throw new RangeError(
      'A coupon expiry must be a positive whole number of years.',
    );
  }
  const launch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(ladder.publicLaunchDate);
  if (
    launch === null ||
    new Date(`${ladder.publicLaunchDate}T00:00:00.000Z`)
      .toISOString()
      .slice(0, 10) !== ladder.publicLaunchDate
  ) {
    throw new RangeError(
      'The public-launch date must be a valid YYYY-MM-DD date.',
    );
  }
}

/**
 * Confirmed, non-voided referrals that put a member in wave 1 (founder,
 * 2026-11-17). Configuration, like the ladder.
 */
export const waveOneReferralThreshold = 3;

/**
 * When wave 1's early access opens, `YYYY-MM` (founder, 2026-11-22: 1 September
 * 2027, replacing early July 2027). Every surface that promises early access
 * reads it from here.
 */
export const waveOneEarlyAccessMonth = '2027-09';

/**
 * A member's access window: wave 1 when their verification-order window is
 * wave 1 (the first 1,000, which no void removes) or their confirmed,
 * non-voided referrals reach the threshold; otherwise the window their
 * verification order gave them. Partner-based wave 1 is added by E11.7-07.
 */
export function accessWindowForReferrals(
  verificationOrderWindow: AccessWindow,
  confirmedReferrals: number,
  threshold: number = waveOneReferralThreshold,
): AccessWindow {
  if (!Number.isInteger(confirmedReferrals) || confirmedReferrals < 0) {
    throw new RangeError(
      'A confirmed referral count must be a non-negative integer.',
    );
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError('The wave-1 threshold must be a positive integer.');
  }
  return confirmedReferrals >= threshold ? 'wave-1' : verificationOrderWindow;
}

export const referralCodeAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const referralCodeLength = 12;

/**
 * Founder-confirmed ADR-025 distribution. The final band has no upper bound.
 * Keeping the thresholds as data makes campaign tuning a configuration-only
 * change while the handoff values remain closed by AccessWindow.
 */
export const accessWindowBands: readonly AccessWindowBand[] = Object.freeze([
  { maximumVerificationOrder: 1_000, window: 'wave-1' },
  { maximumVerificationOrder: 5_000, window: 'wave-2' },
  { maximumVerificationOrder: 15_000, window: 'wave-3' },
  { maximumVerificationOrder: null, window: 'wave-4' },
]);

/**
 * The window a member's verification order gives them, assigned once at
 * verification and never changed (ADR-025's bands; founder D1, 2026-11-17).
 */
export function accessWindowForVerificationOrder(
  verificationOrder: number,
  bands: readonly AccessWindowBand[] = accessWindowBands,
): AccessWindow {
  if (!Number.isInteger(verificationOrder) || verificationOrder < 1) {
    throw new RangeError('Verification order must be a positive integer.');
  }
  assertAccessWindowBands(bands);

  const band = bands.find(
    ({ maximumVerificationOrder }) =>
      maximumVerificationOrder === null ||
      verificationOrder <= maximumVerificationOrder,
  );
  if (band === undefined) {
    throw new RangeError('Access-window configuration must cover every order.');
  }

  return band.window;
}

function assertAccessWindowBands(bands: readonly AccessWindowBand[]): void {
  if (
    bands.length !== accessWindows.length ||
    bands.some((band, index) => band.window !== accessWindows[index])
  ) {
    throw new RangeError(
      'Access-window configuration must contain each handoff wave in order.',
    );
  }

  let previousMaximum = 0;
  for (const [index, band] of bands.entries()) {
    if (band.maximumVerificationOrder === null) {
      if (index !== bands.length - 1) {
        throw new RangeError(
          'Only the final access-window band may be unbounded.',
        );
      }
      continue;
    }
    if (
      !Number.isInteger(band.maximumVerificationOrder) ||
      band.maximumVerificationOrder <= previousMaximum
    ) {
      throw new RangeError(
        'Access-window thresholds must be increasing positive integers.',
      );
    }
    previousMaximum = band.maximumVerificationOrder;
  }
}
