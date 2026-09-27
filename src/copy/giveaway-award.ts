export const giveawayAwardCopy = {
  meta: {
    title: 'Giveaway award',
    description: 'Respond to your provisional Valstara giveaway award.',
  },
  heading: 'Your giveaway award',
  unavailable:
    'This award link is not available. Please check the link in your email.',
  paused: 'Award responses are unavailable right now. Please try again later.',
  challengeFailed: 'That security check did not go through. Please try again.',
  rateLimited: 'Too many attempts — try again in a few minutes.',
  invalidInput: 'Please check your response and try again.',
  saved: 'Your response has been recorded.',
  replaced: 'You are not eligible for this prize under the published rules.',
  checks: {
    heading: 'Confirm your eligibility',
    country: 'Country of residence (two-letter country code)',
    age: 'I confirm that I am 18 or older.',
    skill: 'If you live in Canada: what is (8 × 7) − 6?',
    publicity:
      'I separately permit use of a photograph or testimonial I provide.',
    submit: 'Send my response',
  },
  substitution: {
    heading: 'Choose a replacement',
    body: 'A product in your bundle is unavailable. Choose replacement goods so your bundle keeps at least its stated retail value, or decline replacements to receive the unavailable product’s retail value in cash.',
    replacement: 'Choose these replacement goods',
    decline:
      'I do not want replacement goods; pay the unavailable product’s retail value in cash.',
    deadline: (at: Date) =>
      `Choose by ${at.toISOString()}. If you do not choose, the cash option applies.`,
    product: (name: string, cents: number) =>
      `${name} — €${(cents / 100).toFixed(2)}`,
  },
  confirmed: 'Your award is confirmed.',
  cash: 'The cash substitution has been recorded for this award.',
  replacement: 'Your replacement choice has been recorded.',
  exhausted: 'No reserve remains for this prize.',
  javaScriptRequired: 'JavaScript is required to complete the security check.',
} as const;
