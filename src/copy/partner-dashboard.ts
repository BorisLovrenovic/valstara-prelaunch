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
  kit: {
    heading: 'Your asset kit',
    line: 'Share your link with a QR code, a printed flyer or a ready-made message. Each one carries your own link and code.',
    qrHeading: 'QR code',
    qrLabel: (link: string) => `QR code for ${link}`,
    downloadPng: 'Download the QR code as PNG',
    downloadSvg: 'Download the QR code as SVG',
    flyerHeading: 'Print flyer',
    flyerLine:
      'A one-page flyer with your QR code, code and welcome offer, for A4 or US Letter paper.',
    flyerAction: 'Open your print flyer',
    messagesHeading: 'Message templates',
    messagesLine:
      'Copy a message and post it wherever you share. Your link and code are already filled in.',
    downloadsHeading: 'Files and videos',
    fileKind: { image: 'Image', pdf: 'PDF' },
    video: 'Video',
  },
  flyer: {
    title: 'Partner flyer',
    description: 'Print your Valstara partner flyer.',
    heading: 'Join the Valstara waitlist',
    line: 'Valstara is a direct seller of digital goods backed by the Triple Guarantee.',
    scan: 'Scan the code or visit',
    code: 'Referral code',
    // A printed flyer outlives the ladder stage it was printed at, so it
    // states the guaranteed floor, never the current value (D-069).
    perk: (month: string, percent: number) =>
      `Join with this code and confirm your email for early access from ${month} and at least ${percent}% off your first order.`,
    printHeading: 'Print this flyer',
    printLine:
      'Print this page on A4 or US Letter paper. The flyer fits on one page, and nothing else on this page is printed.',
    back: 'Back to your dashboard',
  },
  welcome: {
    subject: 'Your Valstara partnership is active',
    preheader: 'Your dashboard, link, code and asset kit.',
    firstLine:
      'Your Valstara partnership is active, and your link and code now credit new signups.',
    dashboard:
      'Your private dashboard shows your confirmed signups, your asset kit and your settings. This link is valid for 30 days, and you can request a new one from the dashboard at any time.',
    checklist: 'Three steps to get started:',
    steps: [
      '1. Get your code: it is below and on your dashboard.',
      '2. Share it once: post a message from your asset kit, or print your flyer.',
      '3. See your first confirmed signup: it shows on your dashboard once your friend confirms their email.',
    ],
    kitFiles: 'Your dashboard also has files and videos to share.',
    code: (code: string) => `Code: ${code}`,
    link: (link: string) => `Link: ${link}`,
    action: 'Open your partner dashboard',
    flyer: 'Open your print flyer',
  },
  mail: {
    subject: 'Your new Valstara partner dashboard link',
    preheader: 'Open your private partner dashboard.',
    body: 'This private link is valid for 30 days. It replaces your previous dashboard link.',
    action: 'Open your partner dashboard',
  },
} as const;
