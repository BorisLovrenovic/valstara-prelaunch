import assert from 'node:assert/strict';
import test from 'node:test';

import { landingCopy } from '../src/copy/landing.ts';
import { resendVerificationCopy } from '../src/copy/resend-verification.ts';
import { signupCopy, signupFormCopy } from '../src/copy/signup.ts';
import {
  collectClientErrors,
  serverErrorField,
  signupErrorField,
} from '../src/islands/signup-form.ts';
import { signupErrorCatalogue } from '../src/pages/api/signup.ts';

test('inline validation blocks exactly the empty required fields the server rejects', () => {
  assert.deepEqual(collectClientErrors({ email: '' }), [
    { field: 'email', message: signupFormCopy.emailRequired },
  ]);
  assert.deepEqual(collectClientErrors({ email: 'a@b.co' }), []);
});

test('inline validation never blocks an address the server would accept', () => {
  // These all normalise to a valid subscriber (E3-01), so the island must not
  // reject any of them on shape — it judges emptiness only, never format. If a
  // format check were ever added here, this is the test that catches it.
  const serverAcceptable = [
    'user@gmail.com',
    'u.s.e.r@gmail.com',
    'user+tag@gmail.com',
    'someone@sub.domain.example',
    'MiXeD@Example.COM',
  ];
  for (const email of serverAcceptable) {
    assert.deepEqual(
      collectClientErrors({ email }),
      [],
      `${email} must not be blocked inline`,
    );
  }
});

test('every closed server error code maps to a rendering target', () => {
  // The map and the route's closed code set cannot drift: a new code added to
  // the route without a target here fails this test.
  assert.deepEqual(
    Object.keys(signupErrorField).sort(),
    Object.keys(signupErrorCatalogue).sort(),
  );

  assert.equal(serverErrorField('invalid_email'), 'email');
  assert.equal(serverErrorField('blocked_domain'), 'email');
  assert.equal(serverErrorField('invalid_input'), 'form');
  assert.equal(serverErrorField('challenge_failed'), 'form');
  assert.equal(serverErrorField('rate_limited'), 'form');
  assert.equal(serverErrorField('unavailable'), 'form');
  assert.equal(serverErrorField('internal'), 'form');
  // An unrecognised code is surfaced safely at form level, never dropped.
  assert.equal(serverErrorField('something_new'), 'form');
});

// E11.5-11g: the 17 states' strings, verbatim from the ticket's table and
// StatesDesktop.dc.html / StatesPhone.dc.html, against the copy layer each
// one renders from. The server-supplied ones are the `signupCopy` entries the
// route's error envelope carries, and the island renders them as sent.
const stateTable = {
  label: 'Email address',
  hint: "We'll email you a link to confirm your address.",
  placeholder: 'you@example.com',
  submit: 'Join the waitlist',
  empty: 'Enter your email address.',
  invalid: 'Enter a valid email address.',
  blocked: 'Use a permanent email address to join the waitlist.',
  checking: 'Completing the security check…',
  submitting: 'Adding you to the waitlist…',
  checkFailed: "We couldn't confirm that request. Please try again.",
  network:
    "We couldn't reach the waitlist just now — check your connection and try again.",
  unavailable: "We can't take signups right now — try again in a few minutes.",
  rateLimited: (minutes: number) =>
    `Too many attempts — try again in ${minutes} minutes.`,
  successHeading: 'Check your inbox',
  successBody:
    'If an email from Valstara arrives, open it and click the link to confirm your address. Nothing counts until you do.',
  differentAddress: 'Use a different address',
  resend: 'Send the link again',
  resent:
    "If there's a pending signup for that email, we'll send a new confirmation link shortly.",
  javaScript:
    'JavaScript is required to complete the security check and join the waitlist.',
  pausedHeading: 'Signups are paused',
  pausedBody:
    "We're not taking new signups right now. Check back in a little while — the waitlist will reopen soon.",
} as const;

test('every signup state string matches the E11.5-11g table verbatim and comes from the copy layer', () => {
  assert.equal(landingCopy.form.label, stateTable.label);
  assert.equal(landingCopy.form.hint, stateTable.hint);
  assert.equal(landingCopy.form.placeholder, stateTable.placeholder);
  assert.equal(landingCopy.form.submit, stateTable.submit);
  assert.equal(signupFormCopy.emailRequired, stateTable.empty);
  assert.equal(signupCopy.invalidEmail, stateTable.invalid);
  assert.equal(signupCopy.blockedDomain, stateTable.blocked);
  assert.equal(signupFormCopy.challengePending, stateTable.checking);
  assert.equal(signupFormCopy.submitting, stateTable.submitting);
  assert.equal(signupCopy.challengeFailed, stateTable.checkFailed);
  assert.equal(signupFormCopy.connection, stateTable.network);
  assert.equal(signupCopy.unavailable, stateTable.unavailable);
  // N is the server's wait; the copy only words it.
  for (const minutes of [2, 5, 15])
    assert.equal(
      signupCopy.rateLimitedWait(minutes),
      stateTable.rateLimited(minutes),
    );
  assert.equal(signupFormCopy.successHeading, stateTable.successHeading);
  assert.equal(signupFormCopy.successStep, stateTable.successBody);
  assert.equal(signupFormCopy.differentAddress, stateTable.differentAddress);
  assert.equal(signupFormCopy.resendLink, stateTable.resend);
  assert.equal(resendVerificationCopy.accepted, stateTable.resent);
  assert.equal(signupFormCopy.javaScriptRequired, stateTable.javaScript);
  assert.equal(landingCopy.paused.heading, stateTable.pausedHeading);
  assert.equal(landingCopy.paused.body, stateTable.pausedBody);
});
