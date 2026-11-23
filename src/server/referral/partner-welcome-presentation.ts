import { referralLadderCopy } from '../../copy/referral-ladder.ts';

import { waveOneEarlyAccessMonth } from './config.ts';
import { earlyAccessMonthLabel } from './ladder-presentation.ts';
import type { PartnerWelcomePerk } from './status.ts';

export function presentPartnerWelcomePerk(
  perk: PartnerWelcomePerk | undefined,
) {
  if (perk === undefined) return null;
  const month = earlyAccessMonthLabel(waveOneEarlyAccessMonth);
  const copy = referralLadderCopy.partnerWelcome;
  return perk.code === null
    ? { lead: copy.retained(month, perk.discount), code: null, benefits: '' }
    : {
        lead: copy.named,
        code: perk.code,
        benefits: copy.namedBenefits(month, perk.discount),
      };
}
