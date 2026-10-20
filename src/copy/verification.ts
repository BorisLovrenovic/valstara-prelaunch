export const verificationCopy = {
  confirm: {
    body: 'Confirm this email address to join the Valstara waitlist.',
    submit: 'Confirm email address',
  },
  complete: 'Your email address is verified.',
  invalid: 'This verification link is not available.',
  meta: {
    description: 'Confirm your Valstara waitlist email address.',
    title: 'Verify your email',
  },
  referral: {
    label: 'Your referral link',
    link: 'Share your referral link',
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
  },
} as const;
