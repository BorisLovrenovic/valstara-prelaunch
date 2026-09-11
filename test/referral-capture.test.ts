import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureUtm,
  createReferralCaptureService,
  referralCaptureTtlMs,
} from '../src/server/referral/capture.ts';

const secret = 'referral-capture-test-secret';

test('a server-captured referral and UTM envelope verifies until its 24-hour expiry', () => {
  let now = new Date('2026-09-11T12:00:00.000Z');
  const service = createReferralCaptureService(secret, { clock: () => now });
  const capture = service.capture(
    new URL(
      'https://valstara.test/?ref=ABCDEF123456&utm_source=launch&utm_campaign=autumn',
    ),
  );
  const signed = service.signRef(capture);

  assert.deepEqual(service.verifyRef(signed), {
    ref: 'ABCDEF123456',
    utm: { campaign: 'autumn', source: 'launch' },
  });
  now = new Date(now.getTime() + referralCaptureTtlMs + 1);
  assert.equal(service.verifyRef(signed), null);
});

test('tampered, absent, and forged fields return null rather than throwing', () => {
  const service = createReferralCaptureService(secret);
  const signed = service.signRef({ ref: 'ABCDEF123456', utm: null });
  assert.equal(service.verifyRef(`${signed}x`), null);
  assert.equal(service.verifyRef(null), null);
  const forged = createReferralCaptureService(
    'public-information-only',
  ).signRef({
    ref: 'FORGED123456',
    utm: null,
  });
  assert.equal(service.verifyRef(forged), null);
});

test('UTM capture drops unknown, empty, control-character, and oversized values', () => {
  const params = new URLSearchParams({
    utm_source: '  newsletter  ',
    utm_medium: '',
    utm_campaign: `bad\nvalue`,
    utm_content: 'x'.repeat(129),
    utm_term: 'needle',
    utm_unknown: 'ignored',
  });
  assert.deepEqual(captureUtm(params), {
    source: 'newsletter',
    term: 'needle',
  });
});

test('UTM capture drops later values that would exceed the 512-byte serialized cap', () => {
  const params = new URLSearchParams({
    utm_source: 's'.repeat(128),
    utm_medium: 'm'.repeat(128),
    utm_campaign: 'c'.repeat(128),
    utm_content: 'x'.repeat(128),
    utm_term: 't'.repeat(128),
  });
  const utm = captureUtm(params);
  assert.ok(utm !== null);
  assert.ok(Buffer.byteLength(JSON.stringify(utm), 'utf8') <= 512);
  assert.equal(utm.term, undefined);
});
