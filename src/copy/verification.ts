export const verificationCopy = {
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
  status: {
    label: 'Your waitlist status',
    link: 'View your status',
  },
  survey: {
    categoryLabel: 'What kinds of products are you interested in?',
    categoryOptions: [
      { label: 'Apparel', value: 'apparel' },
      { label: 'Footwear', value: 'footwear' },
      { label: 'Accessories', value: 'accessories' },
      { label: 'Home', value: 'home' },
      { label: 'Beauty', value: 'beauty' },
    ],
    frequencyLabel: 'How often do you shop this kind of product?',
    frequencyOptions: [
      { label: 'Weekly', value: 'weekly' },
      { label: 'Monthly', value: 'monthly' },
      { label: 'A few times a year', value: 'a_few_times_a_year' },
      { label: 'Rarely', value: 'rarely' },
    ],
    heading: 'Help us prepare for launch',
    submit: 'Save preferences',
  },
} as const;
