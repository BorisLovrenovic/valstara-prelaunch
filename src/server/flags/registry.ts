export const campaignFlagRegistry = Object.freeze({
  'signup.enabled': true,
  'referral.enabled': true,
  'leaderboard.public': true,
  'giveaway.open': false,
  'survey.enabled': true,
  'member.dashboard': true,
  'email.broadcast': false,
  // E11.6-10: every price route; off answers 503 (docs/features/price-index.md).
  'prices.pages': true,
  // E11.6-11: the Valstara price on the price pages. Off until the founder
  // turns it on, because a Valstara price shown is a public price commitment.
  'prices.valstara_comparison': false,
  // The partner programme incident lever. Off pauses applications and
  // defers activation effects (docs/features/partner-programme.md#feature-flag).
  'partners.enabled': true,
} as const);

export type FlagKey = keyof typeof campaignFlagRegistry;

export const campaignFlagKeys = Object.freeze(
  Object.keys(campaignFlagRegistry) as FlagKey[],
);

export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(campaignFlagRegistry, key);
}
