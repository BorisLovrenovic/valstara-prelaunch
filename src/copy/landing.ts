import type { MilestoneTier } from '../server/referral/config.ts';
import type { RulesRevision } from '../server/giveaway/rules.ts';

export const landingCopy = {
  meta: {
    title: 'Valstara waitlist',
    description:
      'Join the waitlist for Valstara, a direct seller of digital goods backed by the Triple Guarantee.',
  },
  hero: {
    eyebrow: 'Digital goods you know are real.',
    heading: 'Premium digital goods, for less.',
    body: 'Join the waitlist for earlier access to Valstara, a direct seller of digital goods backed by the Triple Guarantee.',
    facts: [
      { icon: 'check', text: 'Free to join' },
      { icon: 'link', text: 'One-click unsubscribe' },
      { icon: 'shield', text: 'Your data is never sold' },
    ],
  },
  form: {
    label: 'Email address',
    hint: "We'll email you a link to confirm your address.",
    placeholder: 'you@example.com',
    submit: 'Join the waitlist',
  },
  paused: {
    heading: 'Signups are paused',
    body: "We're not taking new signups right now. Check back in a little while — the waitlist will reopen soon.",
  },
  catalogue: {
    heading: "What you'll find",
    body: 'AI tools, subscriptions, software and in-game currency from confirmed launch providers.',
  },
  how: {
    heading: 'How it works',
    steps: [
      'Join with your email',
      'Confirm the link we send',
      'Share your link, if you like',
    ],
  },
  rewards: {
    heading: 'What you get',
    accessHeading: 'Earlier access',
    accessBody: 'Earlier confirmed signups get earlier access.',
    waveLabel: (wave: number) => `Wave ${wave}`,
    waveAxis: { earlier: 'earlier', later: 'later' },
    referralHeading: 'Referral rewards',
    // Read by assistive technology; the equation below it is aria-hidden.
    tier: (tier: MilestoneTier) =>
      `${tier.threshold} confirmed referrals → move up an access wave and ${tier.discountPercent}% off at launch`,
    tierReferrals: 'confirmed referrals',
    tierWave: 'Up one access wave',
    tierPlus: '+',
    tierDiscount: (tier: Pick<MilestoneTier, 'discountPercent'>) =>
      `${tier.discountPercent}%`,
    tierDiscountLabel: 'off at launch',
    held: 'Discount unlocks when a referred person places a first order within 90 days after launch.',
    verifiedOnly: 'Only confirmed, verified referrals count.',
    giveawayHeading: 'The giveaway',
    // Read by assistive technology; the prize figures below it are aria-hidden.
    prize: (
      rules: Pick<RulesRevision, 'prizeCount' | 'prizeApproxRetailValueEur'>,
    ) =>
      `${rules.prizeCount} prizes, approximately €${rules.prizeApproxRetailValueEur.toLocaleString('en-US')} each`,
    prizeCountLabel: 'prizes, approximately',
    prizeValue: (rules: Pick<RulesRevision, 'prizeApproxRetailValueEur'>) =>
      `€${rules.prizeApproxRetailValueEur.toLocaleString('en-US')}`,
    prizeEach: 'each',
    freeEntry: 'No purchase necessary',
    age: '18 and over',
    rulesLink: 'Read the giveaway rules',
    leaderboardLink: 'See the leaderboard',
  },
  trust: {
    heading: 'The Triple Guarantee',
    intro: 'Every order at launch is covered by three promises.',
    promises: [
      {
        numeral: 'I',
        title: 'Delivered within 24 hours.',
        line: 'Every order is fulfilled by hand, Monday to Friday, within 24 hours of purchase.',
      },
      {
        numeral: 'II',
        title: 'Protected, start to finish.',
        line: '256-bit encryption throughout. PCI-compliant payment handling. Your data is never sold.',
      },
      {
        numeral: 'III',
        title: 'Resolved, replaced, or refunded.',
        line: 'If it cannot be resolved, we replace it. If it cannot be replaced, we refund you.',
      },
    ],
    // Read before each title by assistive technology; the drawn numeral is
    // aria-hidden.
    prefix: (numeral: string) => `${numeral}. `,
    link: 'Read the guarantee',
  },
  trustLinks: {
    heading: 'Get to know Valstara',
    items: [
      {
        href: '/legit',
        icon: 'search-check',
        heading: 'Is Valstara legit?',
        line: 'See the evidence before you join.',
      },
      {
        href: '/about',
        icon: 'office',
        heading: 'Who we are',
        line: 'Meet the company behind the store.',
      },
      {
        href: 'mailto:support@valstara.com',
        icon: 'mail',
        heading: 'Contact us',
        line: 'Email support@valstara.com.',
      },
    ],
  },
  faq: {
    heading: 'Common questions',
    items: [
      {
        question: 'What happens when I sign up?',
        answer:
          'We send one verification link. Click it to confirm your place. Nothing counts until you verify.',
      },
      {
        question: 'What do you do with my email?',
        answer:
          'We store it to run your waitlist place and send your verification link and launch updates. Our email providers process it to deliver those messages. Our privacy notice explains how we use and keep it.',
      },
      {
        question: 'When does Valstara launch?',
        answer:
          "We're in pre-launch. Join the waitlist and we'll email you when it's ready — we won't promise a date we can't hold.",
      },
      {
        question: 'Can I leave the waitlist?',
        answer: 'Yes. Every email we send carries a one-click unsubscribe.',
      },
    ],
  },
  final: {
    heading: 'Ready when you are',
    action: 'Join the waitlist',
  },
} as const;
