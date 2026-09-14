export const signupCopy = {
  // Identical accepted copy for unknown, pending, and verified addresses: no
  // membership or position signal leaves the public route.
  pending: 'Thanks — any next step will arrive by email.',
  // Flag-off: an honest paused response, never a form that fails on submit.
  paused:
    "We're not taking new signups right now. Check back in a little while — the waitlist will reopen soon.",
  // Errors, in brand voice: plain, specific, no vendor names, no machinery terms.
  invalidInput: 'Enter a valid email address and select your country.',
  invalidEmail: 'Enter a valid email address.',
  blockedDomain: 'Use a permanent email address to join the waitlist.',
  challengeFailed: "We couldn't confirm that request. Please try again.",
  rateLimited: 'Too many attempts — try again in a few minutes.',
  unavailable: "We can't take signups right now — try again in a few minutes.",
  internal: 'Something went wrong — please try again in a few minutes.',
} as const;

/**
 * Copy the signup form *island* (E3-05) renders client-side. Server responses
 * already carry their own copy-layer message (see `signupCopy` and the route's
 * error envelope), so these cover only what the island decides on its own:
 * inline required-field validation before a request is sent, the in-flight
 * status, and a connection failure where no response comes back at all.
 */
export const signupFormCopy = {
  javaScriptRequired:
    'JavaScript is required to complete the security check and join the waitlist.',
  challengePending: 'Completing the security check…',
  challengeUnavailable:
    "We couldn't complete the security check. Please try again.",
  submitting: 'Adding you to the waitlist…',
  connection:
    "We couldn't reach the waitlist just now — check your connection and try again.",
  emailRequired: 'Enter your email address.',
  countryRequired: 'Select your country.',
  regionRequired: 'Select your province or territory.',
} as const;
