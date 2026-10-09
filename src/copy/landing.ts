export const landingCopy = {
  meta: {
    title: 'Valstara waitlist',
    description:
      'Join the waitlist for Valstara — a direct seller of digital goods, well below list price and backed by a guarantee.',
  },
  hero: {
    eyebrow: 'Digital goods you know are real.',
    heading: 'Join the waitlist for the Valstara launch.',
    body: 'Add your email to be first in line when we open. We send one link to confirm it — nothing counts until you verify.',
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
  whatIs: {
    heading: 'What Valstara is',
    body: 'Valstara is a direct seller of digital goods — subscriptions, software licences, gift cards, game keys and in-game currency — at prices well below list. We are the seller, not a listing board, so when something goes wrong there is no third party to point at.',
    tagline: 'Premium for less.',
  },
  trust: {
    heading: 'The guarantee behind every order',
    intro: 'Every order at launch is covered by the Triple Guarantee.',
    promises: [
      { numeral: 'I', title: 'Delivered within 24 hours' },
      { numeral: 'II', title: 'Protected, start to finish' },
      { numeral: 'III', title: 'Resolved, replaced, or refunded' },
    ],
    note: 'No countdown and no invented scarcity. The waitlist has no deadline, and the count you earn is the real one.',
  },
  faq: {
    heading: 'Common questions',
    label: 'Common questions',
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
          "We're in pre-launch. Join the waitlist and we'll email you the moment it's ready — we won't promise a date we can't hold.",
      },
      {
        question: 'Can I leave the waitlist?',
        answer:
          'Yes. Every email we send carries a one-click unsubscribe, as easy as signing up was.',
      },
    ],
  },
} as const;
