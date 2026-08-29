export const thinSliceCopy = {
  challengeFailed: 'We could not verify this signup. Please try again.',
  invalidInput: 'Enter a valid email address.',
  rateLimited: 'Too many attempts — try again in a few minutes.',
  signupComplete: 'Check your inbox for your verification link.',
  signupSubmit: 'Join the waitlist',
  unavailable:
    'The waitlist is temporarily unavailable. Please try again soon.',
  verificationComplete: 'Your email address is verified.',
  verificationInvalid: 'This verification link is not available.',
  verificationSubject: 'Verify your Valstara waitlist email',
  verificationText: (verificationUrl: string) =>
    `Verify your waitlist email: ${verificationUrl}`,
} as const;
