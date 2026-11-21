import type { AccessWindow } from './config.ts';

const referralLandingUrl = 'https://valstara.com/';

export interface ReferralStatus {
  readonly accessWindow: AccessWindow | null;
  readonly confirmedReferrals: number;
  readonly giveawayEntries: number;
  readonly ownRank: number | null;
  readonly referralLink: string;
  readonly subscriberStatus: 'verified';
  /**
   * The window the member's verification order gave them, written once
   * (E11.7-03). Wave 1 here is the first-1,000 place, which no void removes.
   */
  readonly verificationOrderWindow: AccessWindow | null;
}

export interface ReferralStatusDetails {
  readonly accessWindow: AccessWindow | null;
  readonly giveawayEntries: number;
  readonly ownRank: number | null;
  readonly verificationOrderWindow: AccessWindow | null;
}

/**
 * The member's own referral status. The coupon ladder and wave 1 are shown
 * from the confirmed count and the configuration (E11.7-04,
 * `ladder-presentation.ts`); the retired milestone tiers are not read.
 */
export function computeReferralStatus(
  confirmedReferrals: number,
  referralCode: string,
  details: ReferralStatusDetails,
): ReferralStatus {
  const referralLink = new URL(referralLandingUrl);
  referralLink.searchParams.set('ref', referralCode);

  return {
    accessWindow: details.accessWindow,
    confirmedReferrals,
    giveawayEntries: details.giveawayEntries,
    ownRank: details.ownRank,
    referralLink: referralLink.toString(),
    subscriberStatus: 'verified',
    verificationOrderWindow: details.verificationOrderWindow,
  };
}
