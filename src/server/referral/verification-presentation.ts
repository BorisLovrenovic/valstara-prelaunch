import { milestoneTiers, type MilestoneTier } from './config.ts';
import type { ReferralStatus } from './status.ts';

/** Figures on the verification page stay tied to the shared status and ladder. */
export function verificationReferralFigures(
  status: ReferralStatus,
  ladder: readonly MilestoneTier[] = milestoneTiers,
) {
  const enabled = ladder.filter((tier) => tier.enabled);
  const target =
    enabled.find((tier) => status.confirmedReferrals < tier.threshold) ??
    enabled.at(-1);
  if (target === undefined) return null;

  const progress = Math.min(status.confirmedReferrals, target.threshold);
  const awards = status.rewards.filter(
    (reward) => reward.tier === target.number,
  );
  return {
    accessWindow: status.accessWindow,
    confirmedReferrals: status.confirmedReferrals,
    discountPercent: target.discountPercent,
    progress,
    rewardStates: awards.map((award) => ({
      kind: award.kind,
      state: award.state,
    })),
    threshold: target.threshold,
    tier: target.number,
  };
}
