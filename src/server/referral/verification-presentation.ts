import {
  earlyAccess,
  ladderPresentationConfiguration,
  ladderProgress,
  type LadderPresentationConfiguration,
} from './ladder-presentation.ts';
import type { ReferralStatus } from './status.ts';

/**
 * The referral meter on /verify and /me: progress from the last ladder step
 * reached to the next, or to wave 1's threshold when that comes first, and
 * what that point brings. Every figure comes from
 * the shared status and the ladder configuration. A complete ladder has no
 * meter.
 */
export function verificationReferralFigures(
  status: ReferralStatus,
  configuration: LadderPresentationConfiguration = ladderPresentationConfiguration,
) {
  const progress = ladderProgress(status.confirmedReferrals, configuration);
  const access = earlyAccess(status, configuration);
  const next = progress.next;
  const threshold = configuration.waveOneReferrals;
  // Wave 1's threshold can fall before the next ladder step; the meter then
  // ends there, and that point brings early access and no coupon.
  const accessFirst =
    next !== null && !access.inWaveOne && threshold < next.target;
  return {
    accessWindow: status.accessWindow,
    ladder: {
      line: progress.line,
      held: progress.held,
      meter:
        next === null
          ? null
          : {
              progress: status.confirmedReferrals - next.from,
              span: (accessFirst ? threshold : next.target) - next.from,
              target: accessFirst ? threshold : next.target,
              coupon: accessFirst ? null : next.coupon,
              // Reaching wave 1's threshold opens early access.
              earlyAccessMonth:
                !access.inWaveOne && next.target >= threshold
                  ? access.month
                  : null,
            },
    },
  };
}
