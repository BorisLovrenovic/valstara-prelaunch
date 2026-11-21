export const adminCopy = {
  authenticationRequired: 'Authentication required.',
  invalidRequest: 'The request could not be processed.',
  temporarilyUnavailable: 'The review queue is temporarily unavailable.',
  exportUnavailable: 'The export is temporarily unavailable.',
  healthUnavailable: 'The health view is temporarily unavailable.',
  // E11.7-02: voiding and un-voiding a referral.
  referralVoidInvalid:
    'Send a subscriber id and a reason: one line of 1 to 200 characters, with no email or IP address.',
  referralNotFound: 'No referral exists for that subscriber.',
  referralAlreadyVoided: 'That referral is already voided.',
  referralNotVoided: 'That referral is not voided.',
  referralNotChangeable:
    'That referral cannot be changed: it was rejected, or its referrer is disqualified, being erased or erased.',
  referralVoidUnavailable: 'The referral command is temporarily unavailable.',
} as const;
