import type { FlagService } from '../flags/types.ts';

/**
 * E11.8-06: the waitlist at 13 and over, with an 18+ giveaway box.
 *
 * The age policy a member joined under is recorded on their row when it is
 * created (`subscriber.admission_age_policy`) and never changes, so switching
 * `waitlist.age_13` off later cannot remove a 13+ member's need for the box
 * (founder decision 2, D-081). The predicates below are the one rule for who
 * holds giveaway entries. Live accrual reads them in TypeScript and
 * reconciliation reads the same rule as SQL (`src/server/db/giveaway-entry.ts`);
 * a test holds the two to the same answers.
 */
export const agePolicies = ['18_plus', '13_plus'] as const;
export type AgePolicy = (typeof agePolicies)[number];

export function isAgePolicy(value: unknown): value is AgePolicy {
  return typeof value === 'string' && agePolicies.includes(value as AgePolicy);
}

/** The policy new signups join under: 13+ while `waitlist.age_13` is on. */
export function agePolicyFor(waitlistAge13: boolean): AgePolicy {
  return waitlistAge13 ? '13_plus' : '18_plus';
}

export async function currentAgePolicy(
  flags: Pick<FlagService, 'isEnabled'>,
): Promise<AgePolicy> {
  return agePolicyFor(await flags.isEnabled('waitlist.age_13'));
}

/** The two server settings this ticket ships. Changing one is a code change. */
export interface WaitlistAgeSettings {
  /**
   * True once E11.8-07 has applied the lawyer's reviewed wording (P12). Until
   * then the enable command refuses to switch `waitlist.age_13` on.
   */
  readonly reviewedWordingInPlace: boolean;
  /**
   * Whether a referral by a member who did not tick the 18+ box earns their
   * referrer an entry. Default no, the conservative choice; E11.8-07 sets it
   * from P12.
   */
  readonly referralEntryWithoutGiveawayBox: boolean;
}

const settingKeys = [
  'referralEntryWithoutGiveawayBox',
  'reviewedWordingInPlace',
] as const;

/** Refuses anything but exactly the two settings, each a boolean. */
export function validateWaitlistAgeSettings(
  value: unknown,
): WaitlistAgeSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('The waitlist age settings must be an object.');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== settingKeys.length ||
    keys.some((key, index) => key !== settingKeys[index])
  ) {
    throw new TypeError(
      `The waitlist age settings must hold exactly ${settingKeys.join(' and ')}.`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of settingKeys) {
    if (typeof record[key] !== 'boolean') {
      throw new TypeError(`The waitlist age setting ${key} must be a boolean.`);
    }
  }
  return Object.freeze({
    reviewedWordingInPlace: record.reviewedWordingInPlace as boolean,
    referralEntryWithoutGiveawayBox:
      record.referralEntryWithoutGiveawayBox as boolean,
  });
}

/**
 * The shipped values. Both stay false until E11.8-07 applies P12: the flag
 * cannot be switched on, and a referral by a member without the box earns
 * their referrer nothing.
 */
export const waitlistAgeSettings: WaitlistAgeSettings =
  validateWaitlistAgeSettings({
    reviewedWordingInPlace: false,
    referralEntryWithoutGiveawayBox: false,
  });

/** What the current state of the campaign says about the box. */
export interface GiveawayBoxPolicy {
  /**
   * Every member needs the box: `waitlist.age_13` is on, or the published
   * rules in force make the box the way to enter (E11.8-07's revision). Off,
   * only members admitted under the 13+ policy need it.
   */
  readonly boxRequiredForEveryone: boolean;
  readonly referralEntryWithoutGiveawayBox: boolean;
}

export async function giveawayBoxPolicy(
  flags: Pick<FlagService, 'isEnabled'>,
  rules: { readonly entryRequiresGiveawayBox?: boolean },
  settings: WaitlistAgeSettings = waitlistAgeSettings,
): Promise<GiveawayBoxPolicy> {
  return {
    boxRequiredForEveryone:
      (await flags.isEnabled('waitlist.age_13')) ||
      rules.entryRequiresGiveawayBox === true,
    referralEntryWithoutGiveawayBox: settings.referralEntryWithoutGiveawayBox,
  };
}

export type GiveawayOptInSource = 'signup' | 'member_status';

/** The member facts the box rule reads, from their subscriber row. */
export interface GiveawayBoxFacts {
  readonly admissionAgePolicy: AgePolicy | null;
  readonly giveawayOptInAt: Date | null;
  readonly giveawayOptInSource: GiveawayOptInSource | null;
}

/**
 * Whether the member needs the 18+ box to hold entries. A member admitted
 * under the 13+ policy always does; a member admitted under the 18+ policy
 * does while the flag is on or the rules in force require the box. An
 * unknown admission policy is treated as needing it (fail-safe).
 */
export function needsGiveawayBox(
  member: Pick<GiveawayBoxFacts, 'admissionAgePolicy'>,
  policy: GiveawayBoxPolicy,
): boolean {
  return (
    policy.boxRequiredForEveryone || member.admissionAgePolicy !== '18_plus'
  );
}

/** A member's own base and referral entries accrue only under this rule. */
export function holdsOwnEntries(
  member: GiveawayBoxFacts,
  policy: GiveawayBoxPolicy,
): boolean {
  return !needsGiveawayBox(member, policy) || member.giveawayOptInAt !== null;
}

/**
 * Whether the referred member had opted in by the time their referral was
 * confirmed (founder decision 4, D-082). A box ticked on a signup form was
 * ticked before verification, which is when the referral confirms; a box
 * ticked later on `/me` counts only if it predates the confirmation.
 */
export function optedInByConfirmation(
  referred: GiveawayBoxFacts,
  confirmedAt: Date,
): boolean {
  return (
    referred.giveawayOptInAt !== null &&
    (referred.giveawayOptInSource === 'signup' ||
      referred.giveawayOptInAt.getTime() <= confirmedAt.getTime())
  );
}

/**
 * Whether a confirmed referral earns the referrer an entry, on the referred
 * member's side. The referrer must also hold their own entries.
 */
export function referralEarnsEntry(
  referred: GiveawayBoxFacts,
  confirmedAt: Date,
  policy: GiveawayBoxPolicy,
): boolean {
  return (
    policy.referralEntryWithoutGiveawayBox ||
    !needsGiveawayBox(referred, policy) ||
    optedInByConfirmation(referred, confirmedAt)
  );
}
