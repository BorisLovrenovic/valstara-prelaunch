import { memberStatusCopy } from '../../copy/member-status.ts';

import type { ReferralStatus } from './status.ts';

/** Shared display values for the member page and transactional referral mail. */
export function presentReferralStatus(status: ReferralStatus) {
  const values = {
    subscriberStatus:
      memberStatusCopy.authenticated.statusValues[status.subscriberStatus],
    confirmedReferrals: String(status.confirmedReferrals),
    ownRank:
      status.ownRank === null
        ? memberStatusCopy.authenticated.rankUnavailable
        : String(status.ownRank),
    tier: String(status.tier),
    accessWindow:
      status.accessWindow ?? memberStatusCopy.authenticated.wavePending,
    giveawayEntries: String(status.giveawayEntries),
  };
  return {
    values,
    fields: [
      {
        label: memberStatusCopy.authenticated.status,
        value: values.subscriberStatus,
        tabular: false,
      },
      {
        label: memberStatusCopy.authenticated.confirmedReferrals,
        value: values.confirmedReferrals,
        tabular: true,
      },
      {
        label: memberStatusCopy.authenticated.rank,
        value: values.ownRank,
        tabular: true,
      },
      {
        label: memberStatusCopy.authenticated.tier,
        value: values.tier,
        tabular: true,
      },
      {
        label: memberStatusCopy.authenticated.wave,
        value: values.accessWindow,
        tabular: false,
      },
      {
        label: memberStatusCopy.authenticated.entries,
        value: values.giveawayEntries,
        tabular: true,
      },
    ],
    referralLink: status.referralLink,
    rewards: status.rewards
      .filter(
        (
          reward,
        ): reward is typeof reward & {
          kind: 'discount' | 'merch' | 'wave_upgrade';
        } => reward.kind !== 'entries',
      )
      .map((reward) => ({
        label: memberStatusCopy.rewards.kinds[reward.kind],
        tier: memberStatusCopy.rewards.tier(reward.tier),
        state: memberStatusCopy.rewards.states[reward.state],
      })),
  };
}
