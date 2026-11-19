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
} as const);

export type FlagKey = keyof typeof campaignFlagRegistry;

export const campaignFlagKeys = Object.freeze(
  Object.keys(campaignFlagRegistry) as FlagKey[],
);

export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(campaignFlagRegistry, key);
}
