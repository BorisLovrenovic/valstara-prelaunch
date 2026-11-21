import {
  earlyAccess,
  ladderPresentationConfiguration,
  ladderProgress,
  type LadderPresentationConfiguration,
} from './ladder-presentation.ts';
import type { ReferralStatus } from './status.ts';

/**
 * The referral meter on /verify and /me: progress from the last ladder step
 * reached to the next, and what that next step brings. Every figure comes from
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
              span: next.target - next.from,
              target: next.target,
              coupon: next.coupon,
              // Reaching the next step also opens early access.
              earlyAccessMonth:
                !access.inWaveOne &&
                next.target >= configuration.waveOneReferrals
                  ? access.month
                  : null,
            },
    },
  };
}
