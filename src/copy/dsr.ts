export const dsrCopy = {
  title: 'Your data',
  description: 'Request a copy of your data or erase your waitlist record.',
  export: {
    heading: 'Download your data',
    body: 'Confirm to download the data held about your waitlist record.',
    button: 'Download my data',
    subject: 'Your data export link',
    preheader: 'Confirm your request to download your data.',
  },
  delete: {
    heading: 'Erase your data',
    body: 'Confirm to stop processing your waitlist record and request erasure. The privacy notice explains the retained award records, backups and delivery logs.',
    button: 'Request erasure',
    subject: 'Confirm your erasure request',
    preheader: 'Confirm your request to erase your waitlist record.',
  },
  emailBody:
    'Use this link to confirm your request. It is valid for 24 hours. If you did not request it, no action is needed.',
  accepted:
    'If this address has a waitlist record, we will email a confirmation link.',
  pending:
    'If your erasure request was confirmed, processing has stopped and deletion is in progress.',
  exportUsed:
    'This link has already been used. Request another link if you need a new copy.',
  invalid:
    'This link is not available. Request another link using your email address.',
  unavailable:
    'We cannot complete this request right now. Please try again shortly.',
  rateLimited: 'Too many attempts. Please try again in 15 minutes.',
  challengeFailed: 'That did not go through. Please try again.',
  request: 'Email me a confirmation link',
  email: 'Email address',
  noJavaScript: 'Enable JavaScript to request a confirmation link.',
  privacy: 'Read the privacy notice',
} as const;
