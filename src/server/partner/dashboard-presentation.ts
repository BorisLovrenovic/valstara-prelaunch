import { partnerDashboardCopy } from '../../copy/partner-dashboard.ts';
import { verificationCopy } from '../../copy/verification.ts';
import type { PartnerDashboardRow } from '../db/partner-dashboard.ts';
import {
  earlyAccess,
  ladderProgress,
} from '../referral/ladder-presentation.ts';
import { partnerWelcomeDiscount } from '../referral/partner-perks.ts';
import { siteOrigin } from '../seo.ts';

import type { DashboardRecoveryOutcome } from './dashboard-recovery.ts';

export function presentPartnerDashboard(
  row: PartnerDashboardRow,
  referralEnabled: boolean,
) {
  const copy = partnerDashboardCopy;
  const activeLink = row.status === 'active' && row.active_code;
  return {
    link: new URL(`/r/${row.code}`, siteOrigin).href,
    linkNotice: activeLink
      ? null
      : row.status === 'paused'
        ? copy.sharing.paused
        : copy.sharing.inactive,
    counts: [
      { label: copy.stats.confirmed, count: row.confirmed },
      { label: copy.stats.pending, count: row.pending },
      { label: copy.stats.voided, count: row.voided },
    ],
    categories: verificationCopy.survey.categoryOptions.map(
      ({ label, value }) => ({
        label,
        count: row.categories[value] ?? 0,
      }),
    ),
    rewards: referralEnabled
      ? {
          ladder: ladderProgress(row.confirmed),
          wave: earlyAccess({
            accessWindow: row.access_window,
            verificationOrderWindow: row.verification_order_window,
            confirmedReferrals: row.confirmed,
            partnerWaveReason: activeLink
              ? 'active_partner'
              : row.partner_referral
                ? 'partner_referral'
                : undefined,
          }),
          welcome: activeLink
            ? copy.rewards.welcome(
                partnerWelcomeDiscount(row.confirmed, row.partner_type),
              )
            : null,
        }
      : null,
  };
}

export function presentDashboardRecovery(
  outcome: DashboardRecoveryOutcome | null,
) {
  const copy = partnerDashboardCopy;
  switch (outcome) {
    case null:
      return { status: 200, form: true, line: copy.recovery.line };
    case 'accepted':
      return { status: 200, form: false, line: copy.recovery.accepted };
    case 'paused':
      return { status: 503, form: false, line: copy.paused };
    case 'challenge_failed':
      return { status: 400, form: true, line: copy.recovery.challenge };
    case 'invalid_email':
      return { status: 400, form: true, line: copy.recovery.invalid };
    case 'rate_limited':
      return { status: 429, form: false, line: copy.recovery.limited };
    case 'unavailable':
      return { status: 503, form: false, line: copy.recovery.unavailable };
  }
}
