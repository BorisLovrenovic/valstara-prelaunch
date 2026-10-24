// Interface strings around the trust, legal and giveaway-rules prose
// (E11.5-09). The prose itself, each page's H1 and its summary line come from
// the page's content file in src/content/ and are never repeated here.
export const documentPagesCopy = {
  eyebrow: {
    trust: 'Trust',
    legal: 'Legal',
    rules: 'Giveaway rules',
  },
  contents: {
    heading: 'On this page',
    label: 'Contents',
  },
  guarantee: {
    heading: 'The Triple Guarantee',
    label: 'Guarantee summary',
    readLink: 'Read the guarantee',
  },
  joinBar: {
    label: 'Join the waitlist',
  },
} as const;
