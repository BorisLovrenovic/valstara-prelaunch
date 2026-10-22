import { milestoneTiers, type MilestoneTier } from './config.ts';
import type { ReferralStatus } from './status.ts';

/**
 * Figures on the verification page stay tied to the shared status and ladder.
 * The access wave comes from status alone, so it survives a ladder with no
 * enabled tier; the ladder figures are null then, and no tier is promised.
 */
export function verificationReferralFigures(
  status: ReferralStatus,
  ladder: readonly MilestoneTier[] = milestoneTiers,
) {
  const enabled = ladder.filter((tier) => tier.enabled);
  const target =
    enabled.find((tier) => status.confirmedReferrals < tier.threshold) ??
    enabled.at(-1);
  if (target === undefined)
    return { accessWindow: status.accessWindow, ladder: null };

  const progress = Math.min(status.confirmedReferrals, target.threshold);
  const awards = status.rewards.filter(
    (reward) => reward.tier === target.number,
  );
  return {
    accessWindow: status.accessWindow,
    ladder: {
      confirmedReferrals: status.confirmedReferrals,
      discountPercent: target.discountPercent,
      progress,
      rewardStates: awards.map((award) => ({
        kind: award.kind,
        state: award.state,
      })),
      threshold: target.threshold,
      tier: target.number,
    },
  };
}
