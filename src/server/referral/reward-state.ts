/**
 * The only reward transitions the pre-launch application can perform.
 * A qualifying first-order transition belongs to the storefront after handoff.
 */
export type PrelaunchRewardState = 'none' | 'settled' | 'held' | 'void';
export type RewardClassification = 'cheap' | 'high_value';
export type RewardTransitionSource = 'confirmation';

export interface PrelaunchRewardTransition {
  readonly classification: RewardClassification;
  readonly from: PrelaunchRewardState;
  readonly source: RewardTransitionSource;
  readonly to: PrelaunchRewardState;
}

export const prelaunchRewardTransitions: readonly PrelaunchRewardTransition[] =
  Object.freeze([
    {
      classification: 'cheap',
      from: 'none',
      source: 'confirmation',
      to: 'settled',
    },
    {
      classification: 'high_value',
      from: 'none',
      source: 'confirmation',
      to: 'held',
    },
  ]);

export type ConfirmationRewardState = 'held' | 'settled';
export type MilestoneAwardState = Exclude<PrelaunchRewardState, 'none'>;

export function rewardStateAtConfirmation(
  classification: RewardClassification,
): ConfirmationRewardState {
  return transitionFor(classification, 'none', 'confirmation')
    .to as ConfirmationRewardState;
}

function transitionFor(
  classification: RewardClassification,
  from: PrelaunchRewardState,
  source: RewardTransitionSource,
): PrelaunchRewardTransition {
  const transition = prelaunchRewardTransitions.find(
    (candidate) =>
      candidate.classification === classification &&
      candidate.from === from &&
      candidate.source === source,
  );
  if (transition === undefined) {
    throw new Error('The configured reward transition is not allowed.');
  }
  return transition;
}
