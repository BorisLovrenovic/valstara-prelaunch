import { layoutCopy } from './layout.ts';

export const emailCopy = {
  senderName: 'Valstara',
  wordmark: layoutCopy.siteName,
  // The site footer's §3.4 legal line and contact address, shared verbatim.
  footer: {
    legalLine: layoutCopy.legalLine,
    supportEmail: layoutCopy.supportEmail,
  },
  seed: {
    subject: (marker: string) => `Valstara delivery seed ${marker}`,
    text: (marker: string) =>
      `Valstara delivery seed ${marker}. This mailbox is used for delivery monitoring.`,
    broadcastText: (marker: string, url: string) =>
      `Valstara broadcast seed ${marker}. Link: ${url}`,
    broadcastHtml: (marker: string, url: string) =>
      `<p>Valstara broadcast seed ${marker}.</p><a href="${url}">Valstara</a>`,
  },
  unsubscribe: 'Unsubscribe from Valstara email',
  status: 'View your waitlist status',
  referral: 'Your referral link',
  trust: 'How Valstara works',
  rules: 'Read the giveaway rules that apply to these entries',
  verify: {
    subject: 'Verify your Valstara email address',
    preheader: 'Confirm your email address to join the waitlist.',
    firstLine: 'Verify your Valstara email address.',
    body: 'Use the link below to confirm your place on the waitlist.',
    action: 'Verify email address',
  },
  reminder: {
    subject: 'Reminder: verify your Valstara email address',
    preheader: 'Confirm your address if you still want to join the waitlist.',
    firstLine: 'Your Valstara email address is still unverified.',
    body: 'Use the link below if you still want to join the waitlist.',
    action: 'Verify email address',
  },
  welcome: {
    subject: 'Welcome to the Valstara waitlist',
    preheader: 'Your status link, referral link and current details.',
    firstLine: 'Your place on the Valstara waitlist is confirmed.',
    body: 'Your current details are below. They may change as referrals verify.',
  },
  milestone: {
    subject: (tier: number) => `Referral tier ${tier} reached`,
    preheader: 'Which of your rewards are settled and which are held.',
    firstLine: (tier: number) => `You reached referral tier ${tier}.`,
    body: 'Your current rewards are below. Settled rewards are earned; held discounts require the referred person’s first order within 90 days after store launch.',
  },
  statusLink: {
    subject: 'Your Valstara waitlist status link',
    preheader: 'Your private link to view your waitlist status.',
    firstLine: 'Here is your private waitlist status link.',
    body: 'This link expires 30 days after it was issued. You can request another if it expires.',
  },
  receipt: {
    subject: 'Your Valstara giveaway entry receipt',
    preheader: 'Your entries and the rules version that governs them.',
    firstLine: 'Your giveaway entries are recorded.',
    count: (entries: number, version: string) =>
      `You have ${entries} ${entries === 1 ? 'entry' : 'entries'} under rules version ${version}.`,
  },
  winner: {
    subject: 'Response needed for your provisional giveaway award',
    preheader: 'Complete the winner checks before the response deadline.',
    firstLine: 'You are a provisional Valstara giveaway winner.',
    deadline: (date: Date) =>
      `Respond by ${date.toISOString()} to complete the winner checks in Section 9 of the giveaway rules.`,
    action: 'Respond to your provisional award',
  },
  weekly: {
    subject: 'Your weekly Valstara waitlist update',
    preheader: 'This week’s leaderboard by confirmed referrals.',
    firstLine: 'Here is this week’s Valstara waitlist update.',
    leaderboardHeading: 'Top 10 by confirmed referrals',
    snapshotAsOf: (asOf: string) => `Leaderboard as of ${asOf}.`,
    empty: 'No confirmed referrals are on the leaderboard yet.',
    entry: (rank: number, handle: string, count: number) =>
      `${rank}. ${handle}: ${count} confirmed ${count === 1 ? 'referral' : 'referrals'}`,
  },
} as const;
