import assert from 'node:assert/strict';
import test from 'node:test';

import { couponLadder } from '../src/server/referral/config.ts';
import {
  earlyAccess,
  earlyAccessMonthLabel,
  ladderPresentationConfiguration,
  ladderProgress,
  landingLadder,
} from '../src/server/referral/ladder-presentation.ts';

// E11.7-04: the ladder copy every surface shows, from configuration.

test('the progress line follows the founder’s figures at every step', () => {
  const cases: readonly (readonly [number, string])[] = [
    [0, '3 more confirmed referrals to Coupon 1 at 5%.'],
    [2, '1 more confirmed referral to Coupon 1 at 5%.'],
    [3, 'Coupon 1: 5% · 3 more confirmed referrals to 10%.'],
    [17, 'Coupon 1: 25% · 1 more confirmed referral to 30%.'],
    [18, 'Coupon 1: 30% · 3 more confirmed referrals to Coupon 2 at 5%.'],
    [21, 'Coupon 1: 30% · Coupon 2: 5% · 3 more confirmed referrals to 10%.'],
    // The founder's own example (2026-11-17).
    [25, 'Coupon 1: 30% · Coupon 2: 10% · 2 more confirmed referrals to 15%.'],
    [
      36,
      'Coupon 1: 30% · Coupon 2: 30% · 3 more confirmed referrals to Coupon 3 at 5%.',
    ],
    [
      39,
      'Coupon 1: 30% · Coupon 2: 30% · Coupon 3: 5% · 3 more confirmed referrals to 10%.',
    ],
    [
      54,
      'Coupon 1: 30% · Coupon 2: 30% · Coupon 3: 30% · The ladder is complete.',
    ],
    [
      60,
      'Coupon 1: 30% · Coupon 2: 30% · Coupon 3: 30% · The ladder is complete.',
    ],
  ];
  for (const [count, line] of cases)
    assert.equal(ladderProgress(count).line, line, `${count} referrals`);
});

test('every ladder progress carries the first-order condition and the configured expiry', () => {
  for (const count of [0, 3, 25, 60]) {
    const { held } = ladderProgress(count);
    assert.match(
      held,
      /once one of your referred friends places their first order/u,
    );
    assert.match(
      held,
      new RegExp(`last ${couponLadder.expiryYears} years after launch`, 'u'),
    );
  }
  assert.match(
    ladderProgress(3, {
      ...ladderPresentationConfiguration,
      ladder: { ...couponLadder, expiryYears: 7 },
    }).held,
    /last 7 years/u,
  );
});

test('a changed ladder changes the progress line, with no figure fixed in copy', () => {
  const configuration = {
    ...ladderPresentationConfiguration,
    ladder: {
      ...couponLadder,
      unlocks: [2, 10],
      stepReferrals: 2,
      stepPercent: 7,
      maximumPercent: 20,
    },
  };
  // 7, 14, then capped at 20: three steps per coupon.
  assert.equal(
    ladderProgress(0, configuration).line,
    '2 more confirmed referrals to Coupon 1 at 7%.',
  );
  assert.equal(
    ladderProgress(5, configuration).line,
    'Coupon 1: 14% · 1 more confirmed referral to 20%.',
  );
  assert.equal(
    ladderProgress(6, configuration).line,
    'Coupon 1: 20% · 4 more confirmed referrals to Coupon 2 at 7%.',
  );
});

test('overlapping unlocks still step to the nearest change', () => {
  const configuration = {
    ...ladderPresentationConfiguration,
    ladder: { ...couponLadder, unlocks: [3, 5] },
  };
  assert.equal(
    ladderProgress(3, configuration).line,
    'Coupon 1: 5% · 2 more confirmed referrals to Coupon 2 at 5%.',
  );
  assert.equal(ladderProgress(4, configuration).next?.target, 5);
  assert.equal(ladderProgress(5, configuration).next?.target, 6);
});

test('early access says why a member is in wave 1, or exactly what earns it', () => {
  assert.deepEqual(
    earlyAccess({
      accessWindow: 'wave-1',
      verificationOrderWindow: 'wave-1',
      confirmedReferrals: 0,
    }),
    {
      inWaveOne: true,
      reason: 'first_members',
      remaining: 0,
      month: 'July 2027',
      line: "You're in wave 1, with early access from July 2027, as one of the first 1,000 verified members.",
    },
  );
  assert.equal(
    earlyAccess({
      accessWindow: 'wave-1',
      verificationOrderWindow: 'wave-3',
      confirmedReferrals: 5,
    }).line,
    "You're in wave 1, with early access from July 2027, for reaching 3 confirmed referrals.",
  );
  // The founder's example (2026-11-17).
  assert.equal(
    earlyAccess({
      accessWindow: 'wave-3',
      verificationOrderWindow: 'wave-3',
      confirmedReferrals: 1,
    }).line,
    "You don't have early access yet. 2 more confirmed referrals and you get early access in July 2027.",
  );
  assert.equal(
    earlyAccess({
      accessWindow: 'wave-2',
      verificationOrderWindow: 'wave-2',
      confirmedReferrals: 2,
    }).line,
    "You don't have early access yet. 1 more confirmed referral and you get early access in July 2027.",
  );
  // The first-1,000 place outlasts a void that drops the count to zero.
  assert.equal(
    earlyAccess({
      accessWindow: 'wave-1',
      verificationOrderWindow: 'wave-1',
      confirmedReferrals: 0,
    }).inWaveOne,
    true,
  );
  // Stored wave 1 with no recorded reason still says wave 1, without a why.
  assert.equal(
    earlyAccess({
      accessWindow: 'wave-1',
      verificationOrderWindow: null,
      confirmedReferrals: 0,
    }).line,
    "You're in wave 1, with early access from July 2027.",
  );
});

test('early access figures come from configuration', () => {
  const changed = earlyAccess(
    {
      accessWindow: 'wave-2',
      verificationOrderWindow: 'wave-2',
      confirmedReferrals: 1,
    },
    {
      ...ladderPresentationConfiguration,
      waveOneReferrals: 5,
      earlyAccessMonth: '2027-08',
    },
  );
  assert.equal(
    changed.line,
    "You don't have early access yet. 4 more confirmed referrals and you get early access in August 2027.",
  );
  assert.match(
    earlyAccess(
      {
        accessWindow: 'wave-1',
        verificationOrderWindow: 'wave-1',
        confirmedReferrals: 0,
      },
      {
        ...ladderPresentationConfiguration,
        bands: [
          { maximumVerificationOrder: 2_500, window: 'wave-1' },
          { maximumVerificationOrder: 5_000, window: 'wave-2' },
          { maximumVerificationOrder: 15_000, window: 'wave-3' },
          { maximumVerificationOrder: null, window: 'wave-4' },
        ],
      },
    ).line,
    /first 2,500 verified members/u,
  );
});

test('the early-access month label is validated', () => {
  assert.equal(earlyAccessMonthLabel('2027-07'), 'July 2027');
  for (const invalid of ['2027-13', '2027-7', 'July 2027', ''])
    assert.throws(() => earlyAccessMonthLabel(invalid), RangeError, invalid);
});

test('the landing ladder states the first unlock, the steps and wave 1 from configuration', () => {
  assert.deepEqual(landingLadder(), {
    threshold: 3,
    percent: 5,
    earlyAccessMonth: 'July 2027',
    sentence:
      '3 confirmed referrals → early access in July 2027 and a 5% coupon',
    steps: 'Each coupon rises 5% every 3 more confirmed referrals, up to 30%.',
    moreCoupons: 'Coupons 2 and 3 unlock at 21 and 39.',
    waveOne: 'Early access opens in July 2027.',
    held: 'Coupons apply once a referred friend places a first order, for 5 years after launch.',
  });
  // A wave-1 threshold apart from the first unlock gets its own line.
  const apart = landingLadder({
    ...ladderPresentationConfiguration,
    ladder: { ...couponLadder, unlocks: [4] },
    waveOneReferrals: 3,
  });
  assert.equal(apart.earlyAccessMonth, null);
  assert.equal(apart.sentence, '4 confirmed referrals → a 5% coupon');
  assert.equal(apart.moreCoupons, null);
  assert.equal(
    apart.waveOne,
    '3 confirmed referrals also give you early access in July 2027.',
  );
});
