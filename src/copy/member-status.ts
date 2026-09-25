import { marketingOptInCopy } from './marketing.ts';

export const memberStatusCopy = {
  authenticated: {
    body: 'This private page shows the waitlist details attached to this link.',
    confirmedReferrals: 'Confirmed referrals',
    entries: 'Giveaway entries',
    heading: 'Your waitlist status',
    rank: 'Your rank',
    rankUnavailable: 'Not currently ranked',
    status: 'Status',
    statusValues: {
      verified: 'Verified',
    },
    tier: 'Referral tier',
    wave: 'Access wave',
    wavePending: 'Not assigned yet',
  },
  referral: {
    copied: 'Referral link copied.',
    copy: 'Copy referral link',
    copyFailed: 'Copy failed. Select and copy the link instead.',
    heading: 'Your referral link',
    linkLabel: 'Referral link',
  },
  rewards: {
    empty: 'No referral rewards yet.',
    heading: 'Referral rewards',
    intro:
      'Settled rewards are already earned. Held rewards wait for a qualifying first order after launch.',
    kinds: {
      discount: 'Launch discount',
      entries: 'Bonus entries',
      merch: 'Merchandise',
      wave_upgrade: 'Access-wave upgrade',
    },
    states: {
      held: 'Held',
      settled: 'Settled',
    },
    tier: (tier: number) => `Tier ${tier}`,
  },
  survey: {
    heading: 'Update your launch preferences',
    submit: 'Save updated preferences',
  },
  marketing: {
    heading: 'Marketing email',
    enabled: 'On',
    disabled: 'Off',
    wording: marketingOptInCopy.wording,
    turnOn: 'Turn on marketing email',
    turnOff: 'Turn off marketing email',
    saved: 'Your marketing email preference is updated.',
    paused: 'This preference is unavailable right now. Please try again later.',
    invalidInput: 'Choose an email preference and try again.',
    challengeFailed: 'That security check did not go through. Please try again.',
    rateLimited: 'Too many attempts — try again in a few minutes.',
    unavailable: 'We could not save that preference right now. Please try again later.',
    javaScriptRequired: 'JavaScript is required to complete the security check.',
  },
  unsubscribe: {
    body: 'You can stop waitlist emails at any time.',
    heading: 'Email preferences',
    link: 'Unsubscribe from waitlist emails',
  },
  disabled: {
    body: 'The member page is unavailable right now. Your waitlist place is unchanged.',
    heading: 'Member page unavailable',
  },
  meta: {
    description: 'View your Valstara waitlist status.',
    title: 'Your waitlist status',
  },
  recovery: {
    body: 'Request a new private link by email.',
    challengeFailed:
      'That security check did not go through. Please try again.',
    heading: 'Request a new status link',
    javaScriptRequired:
      'JavaScript is required to complete the security check.',
    sent: 'If this link can be renewed, a new one will arrive by email.',
    submit: 'Email me a new link',
  },
} as const;
