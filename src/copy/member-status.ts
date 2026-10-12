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
      'Settled rewards are already earned. Held discounts require the referred person’s first order within 90 days after store launch.',
    kinds: {
      discount: 'Launch discount',
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
    challengeFailed:
      'That security check did not go through. Please try again.',
    rateLimited: 'Too many attempts — try again in a few minutes.',
    unavailable:
      'We could not save that preference right now. Please try again later.',
    javaScriptRequired:
      'JavaScript is required to complete the security check.',
  },
  leave: {
    heading: 'Leave the waitlist',
    body: 'This stops all Valstara email to this address.',
    submit: 'Leave the waitlist and stop all email',
    saved: 'You have left the waitlist. We will not email this address again.',
    invalidInput: 'This request could not be used.',
    challengeFailed:
      'That security check did not go through. Please try again.',
    rateLimited: 'Too many attempts. Please try again in a few minutes.',
    unavailable: 'Your choice was not saved. Please try again.',
    javaScriptRequired:
      'JavaScript is required to complete the security check.',
  },
  left: {
    heading: 'You have left the waitlist',
    body: 'We will not send email to this address.',
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
