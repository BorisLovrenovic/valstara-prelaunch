import { giveawayAwardCopy as copy } from '../../copy/giveaway-award.ts';
import type { AwardOutcome, OwnAward } from './award.ts';

export type AwardPageOutcome =
  AwardOutcome | 'challenge_failed' | 'unavailable' | null;

export type AwardIcon = 'alert' | 'check' | 'clock' | 'shield';

export type AwardCardState =
  | 'unavailable'
  | 'replaced'
  | 'checks'
  | 'substitution'
  | 'confirmed'
  | 'exhausted';

export interface AwardNotice {
  readonly message: string;
  readonly icon: AwardIcon;
  readonly tone: 'error' | 'success';
}

/**
 * The outcome of a POST to `/giveaway/award`, as the task card's notice: the
 * same message the page has always shown, with an icon and a tone, so the
 * outcome never relies on colour alone (E11.5-10). Presentation only.
 */
export function awardNotice(outcome: AwardPageOutcome): AwardNotice | null {
  switch (outcome) {
    case null:
      return null;
    case 'challenge_failed':
      return { message: copy.challengeFailed, icon: 'alert', tone: 'error' };
    case 'rate_limited':
      return { message: copy.rateLimited, icon: 'clock', tone: 'error' };
    case 'disabled':
    case 'unavailable':
      return { message: copy.paused, icon: 'clock', tone: 'error' };
    case 'invalid_input':
      return { message: copy.invalidInput, icon: 'alert', tone: 'error' };
    case 'replaced':
      return { message: copy.replaced, icon: 'alert', tone: 'error' };
    default:
      return { message: copy.saved, icon: 'check', tone: 'success' };
  }
}

/**
 * Which card the award page renders for the bearer's own award, and its icon.
 * The states and their copy are unchanged from E7-06.
 */
export function awardCardState(award: OwnAward | null): {
  readonly state: AwardCardState;
  readonly icon: AwardIcon;
} {
  if (award === null) return { state: 'unavailable', icon: 'alert' };
  if (award.state === 'replaced') return { state: 'replaced', icon: 'alert' };
  if (award.state === 'notified') return { state: 'checks', icon: 'shield' };
  if (award.state === 'confirmed' && award.substitutionState === 'offered')
    return { state: 'substitution', icon: 'shield' };
  if (award.state === 'confirmed') return { state: 'confirmed', icon: 'check' };
  return { state: 'exhausted', icon: 'alert' };
}

/** The confirmed award's line: cash, replacement or a plain confirmation. */
export function confirmedAwardMessage(award: OwnAward): string {
  if (award.state === 'replaced') return copy.replaced;
  return award.substitutionState === 'cash'
    ? copy.cash
    : award.substitutionState === 'replacement'
      ? copy.replacement
      : copy.confirmed;
}
