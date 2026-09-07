export const signupCopy = {
  // Success — the pending row has no honest position, so there is none to show.
  pending: "Check your inbox — we've sent a link to confirm your email.",
  alreadyVerified: "You're already on the list, and your email is confirmed.",
  // Flag-off: an honest paused response, never a form that fails on submit.
  paused:
    "We're not taking new signups right now. Check back in a little while — the waitlist will reopen soon.",
  // Errors, in brand voice: plain, specific, no vendor names, no machinery terms.
  invalidInput: 'Enter a valid email address and select your country.',
  invalidEmail: 'Enter a valid email address.',
  challengeFailed: "We couldn't confirm that request. Please try again.",
  rateLimited: 'Too many attempts — try again in a few minutes.',
  unavailable: "We can't take signups right now — try again in a few minutes.",
  internal: 'Something went wrong — please try again in a few minutes.',
} as const;
