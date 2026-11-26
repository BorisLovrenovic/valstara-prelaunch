// E11.8-01: the Trust Ledger's interface strings. The founder's words (each
// entry's sections, "How we count", the page's title and summary) live in
// src/content/; this file names the sections and labels the figures, in the
// terms P11 defines (docs/prerequisites/p11-trust-ledger-text.md).
export const trustLedgerCopy = {
  sections: {
    introduction: 'Introduction',
    waitlist: 'Waitlist',
    buildProgress: 'Build progress',
    supplyReadiness: 'Supply readiness',
    partnerProgramme: 'Partner programme',
    policyChanges: 'Policy changes',
    corrections: 'Corrections',
    launchStatus: 'Launch status',
    whatWentWrong: 'What went wrong',
    whatWeChanged: 'What we changed',
    focusForNextMonth: 'Focus for next month',
    howWeCountChanges: 'Changes to how we count',
  },
  figure: (label: string, value: string) => `${label}: ${value}`,
  share: (part: string, whole: string) => `${part} of ${whole}`,
  datedItem: (date: string, text: string) => `${date}: ${text}`,
  waitlist: {
    countedOn: (date: string) => `Counted on ${date}.`,
    total: 'Total',
    newThisMonth: 'New this month',
    joinedThroughReferral: 'Joined through a referral',
  },
  supply: {
    evaluated: 'Suppliers evaluated',
    verified: 'Verified',
    rejected: 'Rejected',
    evaluatedThisMonth: 'Suppliers evaluated this month',
    verifiedThisMonth: 'Verified this month',
    rejectedThisMonth: 'Rejected this month',
    launchProducts: 'Launch products',
    withVerifiedSupply: 'Launch products with verified supply',
  },
  partners: {
    applicationsReceived: 'Applications received',
    approved: 'Approved',
    active: 'Active',
  },
  // The line that links /guarantee and /partners to the page, rendered only
  // once an entry is committed: P11 Part 3, as written. The footer's link is
  // in src/copy/layout.ts.
  link: {
    lead: 'We publish our real numbers every month, the bad ones included, in ',
    label: 'the Trust Ledger',
    end: '.',
  },
} as const;
