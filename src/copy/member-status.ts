export const memberStatusCopy = {
  authenticated: {
    body: 'This private link is ready. Your waitlist details appear here.',
    heading: 'Your waitlist status',
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
