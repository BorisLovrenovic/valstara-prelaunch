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
  // E11.7-13: the partner digest. Off until the founder turns it on; off, no
  // digest is queued or sent (docs/features/partner-programme.md#feature-flag).
  'partners.digest': false,
  // E11.7-16: partner announcements. Off until the founder turns it on; off,
  // nothing is queued or sent and the command refuses
  // (docs/features/partner-programme.md#partner-announcements).
  'partners.announcements': false,
  // E11.8-01: the Trust Ledger page and its child sitemap. Off until the
  // founder turns it on after the first entry is merged; off, /trust-ledger
  // answers 404 and /sitemaps/trust-ledger.xml lists nothing
  // (docs/features/trust-ledger.md#feature-flag).
  'trust_ledger.page': false,
  // E11.8-03: the founder note in the weekly update. Off until the founder
  // turns it on; off, no run records a note and the weekly update is exactly
  // as before (docs/features/email-campaign.md#the-founder-note-e118-03).
  'email.weekly_note': false,
  // E11.8-04: the "a friend invited you" line in the welcome email. Off until
  // the founder turns it on; off, the welcome email is exactly as before
  // (docs/features/email-campaign.md#the-referral-reminder-e118-04).
  'email.referred_welcome_line': false,
  // E11.8-06: the waitlist at 13 and over, with an 18+ giveaway box. Off, the
  // site says "Open to people aged 18 and over" and entries accrue as before.
  // The enable command refuses until E11.8-07 records the lawyer's reviewed
  // wording (docs/features/signup.md#the-waitlist-at-13-and-over-e118-06).
  'waitlist.age_13': false,
} as const);

export type FlagKey = keyof typeof campaignFlagRegistry;

export const campaignFlagKeys = Object.freeze(
  Object.keys(campaignFlagRegistry) as FlagKey[],
);

export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(campaignFlagRegistry, key);
}
