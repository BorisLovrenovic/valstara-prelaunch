import type { RewardClassification } from './reward-state.ts';

export const accessWindows = ['wave-1', 'wave-2', 'wave-3', 'wave-4'] as const;
export type AccessWindow = (typeof accessWindows)[number];
export interface AccessWindowBand {
  readonly maximumVerificationOrder: number | null;
  readonly window: AccessWindow;
}
export type MilestoneRewardKind = 'discount' | 'entries' | 'wave_upgrade';
export type RewardClassifications = Readonly<
  Record<MilestoneRewardKind, RewardClassification>
>;

export interface MilestoneTier {
  readonly bonusEntries: number;
  readonly discountPercent: number;
  readonly enabled: boolean;
  readonly number: number;
  readonly threshold: number;
}

export function milestoneReachedAtConfirmation(
  confirmedReferrals: number,
  tiers: readonly MilestoneTier[] = milestoneTiers,
): MilestoneTier | null {
  return (
    tiers.find(
      (candidate) =>
        candidate.enabled && candidate.threshold === confirmedReferrals,
    ) ?? null
  );
}

/**
 * Founder-confirmed campaign values from ADR-025. Tier 2 remains present as
 * configuration but disabled until its explicit mid-campaign activation; this
 * keeps the cut-list promise without a migration or a code change.
 */
export const milestoneTiers: readonly MilestoneTier[] = Object.freeze([
  {
    bonusEntries: 5,
    discountPercent: 15,
    enabled: true,
    number: 1,
    threshold: 3,
  },
  {
    bonusEntries: 10,
    discountPercent: 25,
    enabled: false,
    number: 2,
    threshold: 5,
  },
]);

/**
 * Founder-confirmed ADR-025 values. This is campaign configuration rather
 * than schema: changing a classification requires no migration.
 */
export const milestoneRewardClassifications: RewardClassifications =
  Object.freeze({
    discount: 'high_value',
    entries: 'high_value',
    wave_upgrade: 'cheap',
  });

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

export function accessWindowForVerificationOrder(
  verificationOrder: number,
  tier = 0,
  bands: readonly AccessWindowBand[] = accessWindowBands,
): AccessWindow {
  if (!Number.isInteger(verificationOrder) || verificationOrder < 1) {
    throw new RangeError('Verification order must be a positive integer.');
  }
  if (!Number.isInteger(tier) || tier < 0) {
    throw new RangeError('Referral tier must be a non-negative integer.');
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

  return promoteAccessWindow(band.window, tier);
}

export function promoteAccessWindow(
  window: AccessWindow,
  tiers: number,
): AccessWindow {
  if (!Number.isInteger(tiers) || tiers < 0) {
    throw new RangeError('Promotion levels must be a non-negative integer.');
  }
  const current = accessWindows.indexOf(window);
  return accessWindows[Math.max(0, current - tiers)] ?? 'wave-1';
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
