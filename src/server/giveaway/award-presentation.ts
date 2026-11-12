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

/**
 * The final-design tile for each card state (E11.5-11t, Task.dc.html): the
 * gift on the accent tile while the bearer has something to do, the check on
 * a success tile once confirmed, and a neutral tile when the award is closed
 * or the link is not available.
 */
export function awardTile(state: AwardCardState): {
  readonly icon: 'gift' | 'check-circle' | 'link';
  readonly tone: 'accent' | 'neutral' | 'success';
} {
  switch (state) {
    case 'checks':
    case 'substitution':
      return { icon: 'gift', tone: 'accent' };
    case 'confirmed':
      return { icon: 'check-circle', tone: 'success' };
    case 'unavailable':
      return { icon: 'link', tone: 'neutral' };
    case 'replaced':
    case 'exhausted':
      return { icon: 'gift', tone: 'neutral' };
  }
}

/**
 * The final-design notice kind for a POST outcome (E11.5-11t): an error rule
 * for a failed check or input, the clock for a wait, an info notice when
 * responses are paused or the award has passed on, success when recorded.
 */
export function awardNoticeTone(
  outcome: Exclude<AwardPageOutcome, null>,
): 'error' | 'wait' | 'info' | 'success' {
  switch (outcome) {
    case 'challenge_failed':
    case 'invalid_input':
      return 'error';
    case 'rate_limited':
      return 'wait';
    case 'disabled':
    case 'unavailable':
    case 'replaced':
      return 'info';
    default:
      return 'success';
  }
}
