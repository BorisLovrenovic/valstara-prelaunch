// E11.7-05: the partner application's configuration. Changing a value here
// needs no migration, except the closed value sets, which the `partner`
// table's checks mirror (migration 0062).

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The partner types (brief §1). The type only affects the welcome perk and reporting. */
export const partnerTypes = [
  'standard',
  'student_ambassador',
  'creator',
] as const;
export type PartnerType = (typeof partnerTypes)[number];

/** Main promotion channels, a multi-select (brief §3.2). */
export const partnerChannels = [
  'tiktok',
  'youtube',
  'instagram',
  'x',
  'discord',
  'telegram_whatsapp',
  'newsletter_blog',
  'campus_offline',
  'other',
] as const;
export type PartnerChannel = (typeof partnerChannels)[number];

/** Approximate audience size ranges (brief §3.2). */
export const partnerAudienceSizes = [
  'under_1k',
  '1k_10k',
  '10k_50k',
  '50k_150k',
  '150k_plus',
] as const;
export type PartnerAudienceSize = (typeof partnerAudienceSizes)[number];

export const partnerApplicationLimits = Object.freeze({
  fullName: 200,
  email: 254,
  // The brief's "short text, max 500 characters".
  promotionPlan: 500,
  // At least one handle or URL, and a bounded list.
  handles: 10,
  handleLength: 200,
  university: 200,
  companyName: 200,
});

/**
 * Rejected and unconfirmed applications have their personal fields purged
 * this long after they reached that state (the planning default, E11.7-05).
 */
export const partnerApplicationRetentionMs = 90 * DAY_MS;

/** Submissions per hashed IP prefix per window, as signup allows. */
export const partnerApplicationIpWindowMs = 15 * 60 * 1_000;
export const partnerApplicationIpLimit = 5;
/** The stricter limit when Turnstile could not be confirmed (ADR-006). */
export const partnerApplicationStrictIpLimit = 2;
/** One confirmation link per address per window, as signup sends one. */
export const partnerApplicationMailWindowMs = 15 * 60 * 1_000;
export const partnerApplicationMailLimit = 1;
/** Confirmation attempts per hashed IP prefix per window, as `/dsr` allows. */
export const partnerConfirmationIpLimit = 5;

/**
 * `partners list --stale` shows partners in `applied`, `approved` or
 * `contract_sent` for longer than this (the planning default, E11.7-06).
 * Nothing changes automatically.
 */
export const partnerStaleAfterMs = 14 * DAY_MS;

/** The founder's review fields (E11.7-06, D-052), mirrored by migration 0063's checks. */
export const partnerReviewLimits = Object.freeze({
  // One notes field, replaced whole (D-052 Q4e).
  notes: 2_000,
  // An optional signfree reference or link.
  contractReference: 200,
});

/** A contract version is a label such as `v1` or `2026-11`, never free text. */
export const partnerContractVersionPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/u;
