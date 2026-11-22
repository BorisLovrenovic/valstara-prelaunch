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
  // E11.7-06: the partner review, contract and lifecycle commands.
  partnerInput: {
    partnerId: 'Name the partner by its id.',
    actor: 'A human actor is required.',
    date: 'Write the date as YYYY-MM-DD, using a real calendar date.',
    contractVersion:
      'A contract version is 1 to 50 letters, digits, dots, dashes or underscores, starting with a letter or digit.',
    contractReference:
      'A contract reference is one line of 1 to 200 characters, with no email or IP address.',
    signedInFuture: 'A contract cannot be signed in the future.',
    signedBeforeSent: 'A contract cannot be signed before it was sent.',
    status:
      'A status is one of applied, approved, contract_sent, active, paused, terminated or rejected.',
    type: 'A type is one of standard, student_ambassador or creator.',
    university:
      'A student ambassador needs a university: one line of 1 to 200 characters, with no email or IP address.',
    universityNotAllowed: 'Only a student ambassador takes a university.',
    notes: 'Notes are 1 to 2,000 characters, with no email or IP address.',
  },
  partnerListInvalid:
    'Filter by status, type, since (YYYY-MM-DD), stale=true or after, each at most once.',
  partnerBodyInvalid: 'The request body does not match this partner command.',
  partnerNotFound: 'No partner application exists with that id.',
  partnerPurged:
    'That application’s personal data has been purged, so it cannot change.',
  partnerWrongStatus: (status: string) =>
    `That command does not apply to a partner whose status is ${status}.`,
  partnerCodeRefusal: {
    format: 'That code is not 4 to 16 letters and digits.',
    blocked: 'That code is on the blocklist.',
    taken: 'That code is already registered.',
  },
  partnerCodeAlternatives: (alternatives: readonly string[]) =>
    alternatives.length === 0
      ? 'No alternative is available.'
      : `Available instead: ${alternatives.join(', ')}.`,
  partnerUnavailable: 'The partner command is temporarily unavailable.',
  partnerExportUnavailable: 'The partners export is temporarily unavailable.',
  partnerBrevoUnavailable:
    'The partner sync to Brevo is temporarily unavailable.',
} as const;
