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

/**
 * The coupon ladder's states (E11.7-03). A coupon is an entitlement the main
 * platform makes usable once one of its holder's confirmed referred friends
 * places a first order (ADR-012), so this repository only ever holds it, or
 * voids it when the confirmed count falls below its unlock. There is no
 * `settled` state here, and the database refuses one.
 */
export type CouponState = 'held' | 'void';
/** Every coupon write is the recompute from the non-voided confirmed count. */
export type CouponTransitionSource = 'recompute';

export interface CouponTransition {
  readonly from: 'none' | CouponState;
  readonly source: CouponTransitionSource;
  readonly to: CouponState;
}

/** Every transition a coupon can make in this repository, and no other. */
export const couponTransitions: readonly CouponTransition[] = Object.freeze([
  // The count reaches the coupon's unlock for the first time.
  { from: 'none', source: 'recompute', to: 'held' },
  // A confirmation, void or un-void moves its percent up or down a step.
  { from: 'held', source: 'recompute', to: 'held' },
  // A void takes the count below the coupon's unlock.
  { from: 'held', source: 'recompute', to: 'void' },
  // An un-void, or later confirmations, unlock it again.
  { from: 'void', source: 'recompute', to: 'held' },
]);

/** The listed transition, or an error: the recompute's only gate. */
export function couponTransition(
  from: 'none' | CouponState,
  to: string,
): CouponTransition {
  const transition = couponTransitions.find(
    (candidate) => candidate.from === from && candidate.to === to,
  );
  if (transition === undefined) {
    throw new Error('The coupon transition is not allowed.');
  }
  return transition;
}
