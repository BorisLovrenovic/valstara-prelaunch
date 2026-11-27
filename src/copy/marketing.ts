/** Keep every rendered signup wording here so an open form can submit after a deployment. */
export const marketingOptInWordingByVersion = {
  v1: 'Yes, email me weekly updates and product news from Valstara. I can switch this off at any time.',
  // E11.8-06: the 16+ box shown while `waitlist.age_13` is on. Draft wording;
  // E11.8-07 replaces it with P12's reviewed wording as a new version.
  v2: "Yes, email me weekly updates and product news from Valstara. I'm 16 or over, and I can switch this off at any time.",
} as const;

export type MarketingOptInVersion = keyof typeof marketingOptInWordingByVersion;

/**
 * The versions each age policy's form shows (E11.8-06, D-083). A retained
 * version stays accepted within its own policy, so a form left open across a
 * wording deployment still submits; a version from the other policy is a form
 * from before an age-policy change, and the visitor loads the current form.
 */
export const marketingOptInVersionsByAgePolicy = {
  '18_plus': ['v1'],
  '13_plus': ['v2'],
} as const satisfies Record<'18_plus' | '13_plus', MarketingOptInVersion[]>;

/** Version of the wording displayed wherever marketing consent is requested. */
export const marketingOptInCopy = {
  version: 'v1',
  wording: marketingOptInWordingByVersion.v1,
} as const;

/**
 * The 16+ wording (E11.8-06), displayed and recorded instead of the above
 * while `waitlist.age_13` is on: at signup, and for a grant on `/me`.
 */
export const marketingOptInSixteenCopy = {
  version: 'v2',
  wording: marketingOptInWordingByVersion.v2,
} as const;

/** The current wording for an age policy. */
export function marketingOptInCopyFor(
  agePolicy: '18_plus' | '13_plus',
): typeof marketingOptInCopy | typeof marketingOptInSixteenCopy {
  return agePolicy === '13_plus'
    ? marketingOptInSixteenCopy
    : marketingOptInCopy;
}
