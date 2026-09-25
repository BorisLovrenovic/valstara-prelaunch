/** Keep every rendered signup wording here so an open form can submit after a deployment. */
export const marketingOptInWordingByVersion = {
  v1: 'Yes, email me weekly updates and product news from Valstara. I can switch this off at any time.',
} as const;

/** Version of the wording displayed wherever marketing consent is requested. */
export const marketingOptInCopy = {
  version: 'v1',
  wording: marketingOptInWordingByVersion.v1,
} as const;
