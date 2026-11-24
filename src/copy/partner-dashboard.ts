export const partnerDashboardCopy = {
  title: 'Partner dashboard',
  description: 'View your Valstara partner referrals, terms and settings.',
  recoveryLink: 'Send me a new link',
  invalid:
    'This dashboard link is unavailable. Request a new one using the email address on your partnership.',
  paused: 'The partner programme is paused.',
  unavailable:
    'We can’t open the dashboard right now. Please try again in a few minutes.',
  invalidSettings:
    'This settings form has expired. Open your dashboard link again to get a fresh form.',
  limitedSettings:
    'Too many attempts. Please wait a few minutes, then open your dashboard link again.',
  badName:
    'Enter a display name of up to 200 characters to show your name. Leave out email addresses and IP addresses.',
  saved: 'Your partner settings are saved.',
  sharing: {
    heading: 'Your referral link and code',
    link: 'Referral link',
    code: 'Referral code',
    paused:
      'Your partner link is paused and won’t credit new signups while your partnership is paused.',
    inactive: 'Your partner link is currently unavailable for new referrals.',
  },
  stats: {
    heading: 'Your referrals',
    confirmed: 'Confirmed',
    pending: 'Pending confirmation',
    voided: 'Voided',
    weekly: 'Confirmed signups per week',
    week: 'Week starting (UTC)',
    signups: 'Signups',
    noWeeks: 'You have no confirmed signups yet.',
    survey: 'Survey categories among confirmed referrals',
    category: 'Category',
    responses: 'Responses',
  },
  leaderboard: {
    heading: 'Partner leaderboard',
    rank: 'Rank',
    partner: 'Partner',
    confirmed: 'Confirmed signups',
    genericName: 'Partner',
    asOf: 'As of',
    ownRank: 'Your rank',
    unranked: 'You do not have a rank in this snapshot.',
    empty: 'No partner ranks are available in this snapshot.',
    unavailable: 'The leaderboard is currently unavailable.',
  },
  rewards: {
    heading: 'Your referral rewards',
    welcome: (discount: number) =>
      `Friends you refer now get ${discount}% off their first order.`,
  },
  terms: {
    heading: 'Your partner terms',
    commission:
      'You earn 10% of order value on all products from customers you refer during the pre-launch campaign. The rate applies to their orders from early access until one year after public launch.',
    level:
      'Commission is one level and applies to customers you refer directly.',
    lock: 'Your founding rate is locked for that one year.',
    timing: 'Earnings start with early access in September 2027.',
    date: 'Contract signed',
    version: 'Contract version',
  },
  settings: {
    heading: 'Settings',
    displayName: 'Display name',
    nameDisclosure:
      'Saving a display name lets other partners see your initials on the leaderboard. They see your full display name only if you choose to share it. Clear the name and save to hide both.',
    confirmName: 'Use this name for leaderboard sharing',
    showOnLeaderboard: 'Show my display name on the partner leaderboard',
    nonessentialMail: 'Send me optional partner programme emails',
    save: 'Save settings',
  },
  recovery: {
    title: 'Request a new partner dashboard link',
    description:
      'Request a replacement for your private Valstara partner dashboard link.',
    line: 'Enter the email address you used for your partnership.',
    address: 'Email address',
    submit: 'Send me a new link',
    accepted:
      'If we can match your address to an eligible partnership, we’ll email you a new dashboard link.',
    challenge: 'We couldn’t confirm that request. Please try again.',
    invalid: 'Enter a valid email address.',
    limited: 'Too many requests. Please try again in a few minutes.',
    unavailable:
      'We can’t take link requests right now. Please try again in a few minutes.',
  },
  mail: {
    subject: 'Your new Valstara partner dashboard link',
    preheader: 'Open your private partner dashboard.',
    body: 'This private link is valid for 30 days. It replaces your previous dashboard link.',
    action: 'Open your partner dashboard',
  },
} as const;
