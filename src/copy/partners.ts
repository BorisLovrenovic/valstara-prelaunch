import { signupCopy, signupFormCopy } from './signup.ts';

// E11.7-05: the partner programme's customer-visible copy. Partner-facing copy
// is sentence case, with no exclamation marks, and never uses the brief's
// banned words, which the forbidden-copy scan refuses (copy-rules.md).
export const partnersCopy = {
  programme: {
    eyebrow: 'Partner programme',
    cardHeading: 'Apply to be a partner',
    cardBody:
      'Tell us where you would share Valstara. The founder reviews every application by hand.',
    apply: 'Apply to the partner programme',
  },
  apply: {
    title: 'Apply to the partner programme',
    description:
      'Apply to promote the Valstara pre-launch campaign with your own link and code.',
    heading: 'Apply to the partner programme',
    line: 'Tell us how you would share Valstara. The founder reviews every application by hand.',
    noJavaScript:
      'Enable JavaScript to complete the security check and send your application.',
    summaryLink: 'Read about the partner programme',
    fields: {
      fullName: 'Full name',
      emailAddress: 'Email address',
      emailAddressDescription: 'We send a confirmation link to this address.',
      country: 'Country of residence',
      countryPrompt: 'Choose your country',
      countryDescription: 'Used for the partner contract only.',
      partnerType: 'Partner type',
      typePrompt: 'Choose a type',
      types: {
        standard: 'Standard',
        student_ambassador: 'Student ambassador',
        creator: 'Creator',
      },
      channels: 'Main promotion channels',
      channelOptions: {
        tiktok: 'TikTok',
        youtube: 'YouTube',
        instagram: 'Instagram',
        x: 'X',
        discord: 'Discord',
        telegram_whatsapp: 'Telegram or WhatsApp groups',
        newsletter_blog: 'Newsletter or blog',
        campus_offline: 'Campus or offline',
        other: 'Other',
      },
      handles: 'Handles or links',
      handlesDescription:
        'At least one. Separate several with commas or spaces.',
      audienceSize: 'Approximate audience size',
      audiencePrompt: 'Choose a range',
      audienceOptions: {
        under_1k: 'Under 1,000',
        '1k_10k': '1,000 to 10,000',
        '10k_50k': '10,000 to 50,000',
        '50k_150k': '50,000 to 150,000',
        '150k_plus': '150,000 or more',
      },
      promotionPlan: 'How will you promote Valstara?',
      promotionPlanDescription: 'Up to 500 characters.',
      requestedCode: 'Preferred code',
      requestedCodeDescription:
        '4 to 16 letters and numbers. The founder may change it at approval.',
      university: 'University or college',
      universityDescription: 'Required for student ambassadors.',
      studentEmail: 'Student email',
      studentEmailDescription: 'Optional, for student ambassadors.',
      companyName: 'Company name',
      companyNameDescription: 'Optional, if you are applying as a business.',
      age: 'I am 18 or older.',
      terms: 'I agree to the partner programme summary and the privacy policy.',
      privacyLink: 'Read the privacy policy',
    },
    // D-050 Q2: a member created by an application is a waitlist member.
    // The giveaway half is said only while the giveaway is open, as the
    // signup form says it, so every claim matches the rules page.
    membership: {
      waitlist: 'Confirming your application also joins the Valstara waitlist.',
      waitlistAndGiveaway:
        'Confirming your application also joins the Valstara waitlist and enters you in the giveaway.',
      // E11.8-06 (D-080): while the waitlist is open at 13, confirming joins
      // the waitlist only; the member enters the giveaway from /me with the
      // separate 18+ box. Draft wording; E11.8-07 replaces it with P12's.
      waitlistThenGiveaway:
        'Confirming your application also joins the Valstara waitlist. It does not enter you in the giveaway, which is for people aged 18 and over: once you have confirmed, you can enter it from your status page.',
    },
    ageStatement: signupFormCopy.ageStatement,
    freeEntryDisclosure: signupFormCopy.freeEntryDisclosure,
    giveawayRulesLink: signupFormCopy.giveawayRulesLink,
    giveawayRulesLinkEnd: signupFormCopy.giveawayRulesLinkEnd,
    submit: 'Send application',
    errors: {
      required: 'Complete this field.',
      too_long: 'This is longer than the form allows.',
      invalid: 'Check this field.',
      blocked_domain: signupCopy.blockedDomain,
      format: 'Use 4 to 16 letters and numbers, with no spaces.',
      blocked: 'This code cannot be used.',
      taken: 'This code is already in use.',
    },
    alternatives: 'These codes are available:',
    refused: 'Check the marked fields and send your application again.',
    challengeFailed: "We couldn't confirm that request. Please try again.",
    rateLimited:
      'Too many applications from this connection. Please wait a few minutes and try again.',
    unavailable:
      "We can't take applications right now. Please try again in a few minutes.",
    paused:
      'Applications to the partner programme are paused. Please check back later.',
    pausedHeading: 'Applications are paused',
    accepted: {
      heading: 'Check your email',
      line: 'If this address can apply, we have sent it a confirmation link. Your application counts once you confirm it.',
    },
    confirm: {
      heading: 'Confirm your application',
      line: 'Confirm to send your application to the founder for review.',
      button: 'Confirm application',
    },
    confirmed: {
      heading: 'Application received',
      line: 'Thank you. The founder reviews every application by hand and replies by email.',
    },
    invalid: {
      heading: 'This link is not available',
      line: 'Apply again for a new confirmation link.',
      apply: 'Apply again',
    },
  },
  email: {
    confirm: {
      subject: 'Confirm your Valstara partner application',
      preheader: 'Confirm your email address to send your application.',
      firstLine: 'Confirm your Valstara partner application.',
      body: 'Use the link below to confirm your email address. Your application counts once you do, and confirming also joins the Valstara waitlist. If you did not apply, ignore this email.',
      action: 'Confirm application',
    },
    received: {
      subject: 'Your Valstara partner application is received',
      preheader: 'The founder reviews every application by hand.',
      firstLine: 'We have your partner application.',
      body: 'The founder reviews every application by hand and replies by email. Nothing more is needed from you for now.',
      action: 'Read about the partner programme',
    },
    // E11.7-06: the founder's review outcome (brief §3.9).
    approved: {
      subject: 'Your Valstara partner application is approved',
      preheader: 'Your partner contract is the next step.',
      firstLine: 'Your partner application is approved.',
      body: 'Your contract will arrive by email from signfree.io shortly. Your code and link go live once your signed contract is recorded, and we will email you when they do.',
      action: 'Read about the partner programme',
    },
    rejected: {
      subject: 'Your Valstara partner application',
      preheader: 'Thank you for applying to the partner programme.',
      firstLine: 'Thank you for applying to the Valstara partner programme.',
      body: 'We are not able to offer you a partnership this time. Your waitlist place is unchanged, and you are welcome to apply again later.',
    },
    // E11.7-12: the auto-invite, a marketing message (ADR-027). The count
    // comes from configuration.
    invite: {
      subject: 'An invitation to apply to the Valstara partner programme',
      preheader: 'You can apply to promote Valstara with your own code.',
      firstLine: (threshold: number) =>
        `${threshold} people you referred have confirmed their place on the Valstara waitlist.`,
      body: 'You are invited to apply to the Valstara partner programme. Partners promote Valstara with their own link and code, and can earn a commission once early access opens. The programme page sets out the terms.',
      review:
        'The application link fills in your email address. The founder reviews every application by hand.',
      action: 'Apply to the partner programme',
      programme: 'Read about the partner programme',
    },
    // E11.7-12: the partner's first confirmed partner signup. It names no one.
    firstSignup: {
      subject: 'Your first confirmed partner signup',
      preheader: 'Someone you referred has confirmed their email address.',
      firstLine: 'Your first confirmed partner signup is in.',
      body: 'Someone who signed up through your partner link or code has confirmed their email address, so they now count in your confirmed signups.',
      dashboard:
        'Your private dashboard shows your counts, at the link in your partner welcome email. If you no longer have that link, you can ask for a new one.',
      action: 'Ask for a new dashboard link',
    },
    // E11.7-13: the partner digest, optional programme mail (D-071). It
    // reports the period that has just ended, names no one, and carries the
    // founder's note from src/content/partner-digest-note.json.
    digest: {
      subject: (period: string) => `Your Valstara partner digest for ${period}`,
      preheader:
        'Your confirmed signups, your rank and the waitlist’s growth, with a note from the founder.',
      firstLine: (period: string) =>
        `Here is your Valstara partner digest for ${period}.`,
      monthLabel: (month: string, year: number) => `${month} ${year}`,
      weekLabel: (week: number, year: number) => `week ${week} of ${year}`,
      months: [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ],
      noteHeading: 'A note from the founder:',
      // E11.7-15 (D-074): counts are grouped as /me groups figures, "1,830".
      confirmedInPeriod: (period: string, count: number) =>
        `Confirmed signups in ${period}: ${count.toLocaleString('en-US')}`,
      confirmedTotal: (count: number) =>
        `Confirmed signups in total: ${count.toLocaleString('en-US')}`,
      // asOf arrives formatted for people (formatSnapshotTimestamp).
      rank: (rank: number, asOf: string) =>
        `Your partner leaderboard rank: ${rank} (as of ${asOf})`,
      unranked: (asOf: string) =>
        `You do not have a rank in the partner leaderboard (as of ${asOf}).`,
      rankUnavailable: 'The partner leaderboard is currently unavailable.',
      categories: 'Survey categories among your confirmed signups:',
      category: (label: string, count: number) =>
        `${label}: ${count.toLocaleString('en-US')}`,
      waitlistInPeriod: (period: string, count: number) =>
        `People who confirmed their place on the waitlist in ${period}: ${count.toLocaleString('en-US')}`,
      waitlistTotal: (count: number) =>
        `People with a confirmed place on the waitlist: ${count.toLocaleString('en-US')}`,
      dashboard:
        'Your private dashboard shows your counts, at the link in your partner welcome email. If you no longer have that link, you can ask for a new one.',
      choice:
        'You receive this digest because you chose optional partner programme emails. Unsubscribing from it turns off only that choice: your partnership, your waitlist place and your other partner emails are unchanged.',
      action: 'Ask for a new dashboard link',
    },
    // E11.7-16: a partner announcement, optional programme mail on the
    // digest's audience. The subject and text come from the founder's content
    // file in src/content/partner-announcements/; it names no one.
    announcement: {
      preheader: 'An announcement from the Valstara partner programme.',
      dashboard:
        'Your private dashboard shows your counts, at the link in your partner welcome email. If you no longer have that link, you can ask for a new one.',
      choice:
        'You receive this announcement because you chose optional partner programme emails. Unsubscribing from it turns off only that choice: your partnership, your waitlist place and your other partner emails are unchanged.',
      action: 'Ask for a new dashboard link',
    },
  },
} as const;
