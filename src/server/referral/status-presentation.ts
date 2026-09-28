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
      },
      {
        label: memberStatusCopy.authenticated.confirmedReferrals,
        value: values.confirmedReferrals,
      },
      { label: memberStatusCopy.authenticated.rank, value: values.ownRank },
      { label: memberStatusCopy.authenticated.tier, value: values.tier },
      {
        label: memberStatusCopy.authenticated.wave,
        value: values.accessWindow,
      },
      {
        label: memberStatusCopy.authenticated.entries,
        value: values.giveawayEntries,
      },
    ],
    referralLink: status.referralLink,
    rewards: status.rewards.map((reward) => ({
      label: memberStatusCopy.rewards.kinds[reward.kind],
      tier: memberStatusCopy.rewards.tier(reward.tier),
      state: memberStatusCopy.rewards.states[reward.state],
    })),
  };
}
