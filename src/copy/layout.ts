export const layoutCopy = {
  skipToContent: 'Skip to content',
  siteName: 'Valstara',
  headerNavLabel: 'Page sections',
  // Anchors on the landing page. Every other page prefixes them with "/".
  headerLinks: [
    { anchor: '#how', label: 'How it works' },
    { anchor: '#rewards', label: 'What you get' },
    { anchor: '#guarantee', label: 'Guarantee' },
    { anchor: '#faq', label: 'FAQ' },
  ],
  joinAnchor: '#join',
  joinLabel: 'Join the waitlist',
  footerNavLabel: 'Company and legal',
  footerGroups: [
    { id: 'company', heading: 'Company' },
    { id: 'legal', heading: 'Legal' },
  ],
  footerLinks: [
    { group: 'company', href: '/about', label: 'About' },
    { group: 'company', href: '/legit', label: 'Legit' },
    { group: 'company', href: '/guarantee', label: 'Guarantee' },
    { group: 'legal', href: '/terms', label: 'Terms' },
    { group: 'legal', href: '/privacy', label: 'Privacy' },
    { group: 'legal', href: '/privacy/storage', label: 'Storage inventory' },
    { group: 'legal', href: '/giveaway/rules', label: 'Giveaway rules' },
  ],
  contactHeading: 'Contact',
  supportEmail: 'support@valstara.com',
  // identity-guidelines §3.4, the legal footer. LOCKED wording.
  legalLine:
    'Valstara is a trading brand of 3NITY Digital Limited, registered in Hong Kong.',
} as const;
