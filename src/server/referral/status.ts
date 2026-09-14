const referralLandingUrl = 'https://valstara.com/';

export type ReferralStatusRewardKind =
  'discount' | 'entries' | 'merch' | 'wave_upgrade';

export interface ReferralStatusSourceAward {
  readonly reward_kind: ReferralStatusRewardKind;
  readonly state: 'held' | 'settled';
  readonly tier: number;
}

export interface ReferralStatusReward {
  readonly kind: ReferralStatusRewardKind;
  readonly state: 'held' | 'settled';
  readonly tier: number;
}

export interface ReferralStatus {
  readonly confirmedReferrals: number;
  readonly referralLink: string;
  readonly rewards: readonly ReferralStatusReward[];
  readonly tier: number;
}

export function computeReferralStatus(
  confirmedReferrals: number,
  referralCode: string,
  awards: readonly ReferralStatusSourceAward[],
): ReferralStatus {
  const rewards = awards.map<ReferralStatusReward>((award) => ({
    kind: award.reward_kind,
    state: award.state,
    tier: award.tier,
  }));
  const tier = rewards.reduce(
    (highest, reward) =>
      reward.state === 'settled' ? Math.max(highest, reward.tier) : highest,
    0,
  );
  const referralLink = new URL(referralLandingUrl);
  referralLink.searchParams.set('ref', referralCode);

  return {
    confirmedReferrals,
    referralLink: referralLink.toString(),
    rewards,
    tier,
  };
}
