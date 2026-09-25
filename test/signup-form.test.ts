import assert from 'node:assert/strict';
import test from 'node:test';

import { signupFormCopy } from '../src/copy/signup.ts';
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
