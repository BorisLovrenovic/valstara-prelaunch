import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hoursToVerifyBucket,
  referrerTierBucket,
  sourceBucket,
} from '../src/server/analytics/funnel.ts';

test('source buckets follow the founder-approved medium table and precedence', () => {
  const cases = [
    [{ medium: 'email' }, false, 'email'],
    [{ medium: ' NEWSLETTER ' }, true, 'email'],
    [{ medium: 'social' }, false, 'social'],
    [{ medium: 'cpc' }, false, 'paid'],
    [{ medium: 'ppc' }, false, 'paid'],
    [{ medium: 'paid' }, false, 'paid'],
    [{ medium: 'paid_social' }, false, 'paid'],
    [{ medium: 'display' }, false, 'paid'],
    [{ medium: 'organic' }, false, 'organic'],
    [{ medium: 'referral' }, false, 'referral'],
    [{ medium: 'mystery' }, true, 'other'],
    [{ source: 'social-network' }, true, 'referral'],
    [{ source: 'social-network' }, false, 'other'],
    [null, true, 'referral'],
    [null, false, 'direct'],
  ] as const;
  for (const [utm, hasRef, expected] of cases) {
    assert.equal(
      sourceBucket(utm, hasRef),
      expected,
      JSON.stringify({ utm, hasRef }),
    );
  }
  assert.equal(
    sourceBucket({ source: 'email', medium: 'organic' }, false),
    'organic',
  );
});

test('verification time and settled tier use only bounded categories', () => {
  const start = new Date('2026-10-06T00:00:00.000Z');
  for (const [hours, expected] of [
    [0, 'under_1'],
    [1, '1_to_24'],
    [24, '24_to_72'],
    [72, 'over_72'],
  ] as const) {
    assert.equal(
      hoursToVerifyBucket(start, new Date(start.getTime() + hours * 3_600_000)),
      expected,
    );
  }
  assert.equal(referrerTierBucket(0), 'none');
  assert.equal(referrerTierBucket(1), 'tier_1');
  assert.equal(referrerTierBucket(2), 'tier_2_or_higher');
});
