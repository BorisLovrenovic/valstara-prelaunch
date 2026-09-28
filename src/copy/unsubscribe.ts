export const unsubscribeCopy = {
  meta: {
    title: 'Email preferences',
    description: 'Change what email you receive from Valstara.',
  },
  confirm: {
    heading: 'Choose what to stop',
    body: 'A marketing email link stops marketing. A service email link stops all email. You can also leave the waitlist entirely.',
    message: 'Unsubscribe from this email',
    leave: 'Leave the waitlist and stop all email',
  },
  complete: {
    heading: 'Your choice is saved',
    body: 'Your email preference has been updated.',
  },
  invalid: {
    heading: 'This link is not available',
    body: 'This email preference link has expired or is invalid.',
  },
  unavailable: {
    heading: 'That did not work',
    body: 'Your choice was not saved. Please try again.',
    retry: 'Try again',
  },
  rateLimited: 'Too many attempts. Please try again in a few minutes.',
  invalidInput: 'This request could not be used.',
} as const;
