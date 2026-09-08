export type AccessWindow = 'wave-1' | 'wave-2' | 'wave-3' | 'wave-4';

export interface MilestoneTier {
  readonly bonusEntries: number;
  readonly discountPercent: number;
  readonly enabled: boolean;
  readonly number: number;
  readonly threshold: number;
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

export const referralCodeAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const referralCodeLength = 12;

export function accessWindowForVerificationOrder(
  verificationOrder: number,
): AccessWindow {
  if (verificationOrder <= 1_000) {
    return 'wave-1';
  }
  if (verificationOrder <= 5_000) {
    return 'wave-2';
  }
  if (verificationOrder <= 15_000) {
    return 'wave-3';
  }
  return 'wave-4';
}

export function promoteAccessWindow(
  window: AccessWindow,
  tiers: number,
): AccessWindow {
  const windows: readonly AccessWindow[] = [
    'wave-1',
    'wave-2',
    'wave-3',
    'wave-4',
  ];
  const current = windows.indexOf(window);
  return windows[Math.max(0, current - tiers)] ?? 'wave-1';
}

export function tierForConfirmedReferrals(confirmedReferrals: number): number {
  return milestoneTiers.reduce(
    (tier, candidate) =>
      candidate.enabled && confirmedReferrals >= candidate.threshold
        ? candidate.number
        : tier,
    0,
  );
}
