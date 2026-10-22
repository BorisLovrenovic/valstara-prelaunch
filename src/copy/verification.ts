export const verificationCopy = {
  confirm: {
    body: 'Confirm your email address',
    next: 'Next, we will show your place and referral link.',
    submit: 'Confirm email address',
  },
  complete: 'Your email address is verified.',
  completeNext:
    'Your place is confirmed. Share your link to move toward your next tier.',
  completeNextNoReferral: 'Your place is confirmed.',
  invalid: 'This verification link is not available.',
  invalidHeading: 'Request a new link',
  meta: {
    description: 'Confirm your Valstara waitlist email address.',
    title: 'Verify your email',
  },
  referral: {
    label: 'Your referral link',
    link: 'Share your referral link',
    linkLabel: 'Referral link',
    copy: 'Copy link',
    copied: 'Link copied.',
    copyFailed: 'Select and copy the link instead.',
    share: 'Share link',
    progress: (count: number, threshold: number, tier: number) =>
      `${count} of ${threshold} to Tier ${tier}`,
    reward: (discount: number) => `${discount}% launch discount`,
    unlocks: (tier: number) => `Tier ${tier} unlocks`,
    waveReward: 'Earlier access wave',
    heldCondition:
      'The discount is held until a confirmed referral places a first order within 90 days after launch.',
    held: 'Held',
    settled: 'Settled',
    wave: (window: string) => `Access wave ${window.slice(-1)}`,
  },
  resend: {
    emailLabel: 'Email address',
    javaScriptRequired:
      'JavaScript is required to complete the security check and request a new link.',
    submit: 'Request a new link',
  },
  status: {
    label: 'Your waitlist status',
    link: 'View your status',
  },
  survey: {
    categoryLabel: 'What digital goods interest you?',
    categoryOptions: [
      { label: 'AI tools', value: 'ai' },
      { label: 'Streaming and subscriptions', value: 'subscriptions' },
      { label: 'Software', value: 'software' },
      { label: 'Gift cards', value: 'gift_cards' },
      { label: 'Game keys', value: 'game_keys' },
      { label: 'Game top-ups', value: 'game_top_ups' },
      { label: 'In-game currency', value: 'in_game_currency' },
    ],
    frequencyLabel: 'How often do you buy digital goods?',
    frequencyOptions: [
      { label: 'Weekly', value: 'weekly' },
      { label: 'Monthly', value: 'monthly' },
      { label: 'A few times a year', value: 'a few times a year' },
      { label: 'Rarely', value: 'rarely' },
    ],
    heading: 'Help us prepare for launch',
    submit: 'Save preferences',
    skip: 'Skip',
  },
} as const;
