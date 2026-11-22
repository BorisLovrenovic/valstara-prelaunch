import { memberStatusCopy } from '../../copy/member-status.ts';
import { referralLadderCopy } from '../../copy/referral-ladder.ts';

import {
  earlyAccess,
  ladderPresentationConfiguration,
  ladderProgress,
  type LadderPresentationConfiguration,
} from './ladder-presentation.ts';
import type { ReferralStatus } from './status.ts';

/** Shared display values for the member page and transactional referral mail. */
export function presentReferralStatus(
  status: ReferralStatus,
  configuration: LadderPresentationConfiguration = ladderPresentationConfiguration,
) {
  const values = {
    subscriberStatus:
      memberStatusCopy.authenticated.statusValues[status.subscriberStatus],
    confirmedReferrals: String(status.confirmedReferrals),
    ownRank:
      status.ownRank === null
        ? memberStatusCopy.authenticated.rankUnavailable
        : String(status.ownRank),
    accessWindow:
      status.accessWindow ?? memberStatusCopy.authenticated.wavePending,
    giveawayEntries: String(status.giveawayEntries),
  };
  const ladder = ladderProgress(status.confirmedReferrals, configuration);
  const access = earlyAccess(status, configuration);
  // In wave 1 the fact is the month early access opens.
  const earlyAccessValue = access.inWaveOne
    ? access.month
    : memberStatusCopy.authenticated.earlyAccessNotYet;
  return {
    values,
    // Each field keeps its key so /me can place it on its own card; the email
    // surfaces print label and value only.
    fields: [
      {
        key: 'subscriberStatus' as const,
        label: memberStatusCopy.authenticated.status,
        value: values.subscriberStatus,
        tabular: false,
      },
      {
        key: 'confirmedReferrals' as const,
        label: memberStatusCopy.authenticated.confirmedReferrals,
        value: values.confirmedReferrals,
        tabular: true,
      },
      {
        key: 'ownRank' as const,
        label: memberStatusCopy.authenticated.rank,
        value: values.ownRank,
        tabular: true,
      },
      {
        key: 'earlyAccess' as const,
        label: memberStatusCopy.authenticated.earlyAccess,
        value: earlyAccessValue,
        tabular: false,
      },
      {
        key: 'accessWindow' as const,
        label: memberStatusCopy.authenticated.wave,
        value: values.accessWindow,
        tabular: false,
      },
      {
        key: 'giveawayEntries' as const,
        label: memberStatusCopy.authenticated.entries,
        value: values.giveawayEntries,
        tabular: true,
      },
    ],
    referralLink: status.referralLink,
    earlyAccess: access,
    ladder,
    // Every coupon the count earns. Each is held: the main platform makes it
    // usable once one of the member's referred friends places a first order
    // (ADR-012), so each row carries that condition.
    coupons: ladder.coupons.map(({ number, percent }) => ({
      number,
      label: referralLadderCopy.couponName(number),
      percent: referralLadderCopy.percent(percent),
      state: referralLadderCopy.heldState,
      condition: referralLadderCopy.heldShort,
    })),
  };
}
