import assert from 'node:assert/strict';
import test from 'node:test';

import { referralLadderCopy } from '../src/copy/referral-ladder.ts';
import { verificationCopy } from '../src/copy/verification.ts';
import { couponLadder } from '../src/server/referral/config.ts';
import { ladderPresentationConfiguration } from '../src/server/referral/ladder-presentation.ts';
import { verificationReferralFigures } from '../src/server/referral/verification-presentation.ts';
import type { ReferralStatus } from '../src/server/referral/status.ts';

const baseStatus: ReferralStatus = {
  accessWindow: 'wave-2',
  confirmedReferrals: 0,
  giveawayEntries: 1,
  ownRank: null,
  referralLink: 'https://valstara.com/?ref=TESTREF12345',
  subscriberStatus: 'verified',
  verificationOrderWindow: 'wave-2',
};

test('verification marketing copy stays within the E11.5 scan budget', () => {
  const words = (value: string) => value.trim().split(/\s+/u).length;
  for (const heading of [
    verificationCopy.confirm.body,
    verificationCopy.complete,
    verificationCopy.invalidHeading,
    verificationCopy.referral.label,
    referralLadderCopy.nextAt(39),
    verificationCopy.survey.heading,
    verificationCopy.status.label,
  ]) {
    assert.ok(words(heading) <= 7, heading);
  }
  for (const line of [
    verificationCopy.confirm.next,
    verificationCopy.completeNext,
    verificationCopy.invalid,
    referralLadderCopy.held(couponLadder.expiryYears),
  ]) {
    assert.ok(words(line) <= 20, line);
  }
  for (const cardText of [
    verificationCopy.referral.link,
    verificationReferralFigures(baseStatus).ladder.line,
    referralLadderCopy.coupon(1, 5),
    referralLadderCopy.earlyAccessPill,
    verificationCopy.referral.wave('wave-1'),
    ...verificationCopy.survey.categoryOptions.map((option) => option.label),
    ...verificationCopy.survey.frequencyOptions.map((option) => option.label),
  ]) {
    assert.ok(words(cardText) <= 15, cardText);
  }
});

test('a new member sees the first coupon and early access as the next step', () => {
  assert.deepEqual(verificationReferralFigures(baseStatus), {
    accessWindow: 'wave-2',
    ladder: {
      line: '3 more confirmed referrals to Coupon 1 at 5%.',
      held: 'Coupons become usable once one of your referred friends places their first order, and last 5 years after launch.',
      meter: {
        progress: 0,
        span: 3,
        target: 3,
        coupon: { number: 1, percent: 5 },
        earlyAccessMonth: 'September 2027',
      },
    },
  });
  assert.equal(
    verificationReferralFigures({ ...baseStatus, confirmedReferrals: 2 }).ladder
      .meter?.progress,
    2,
  );
});

test('the meter runs from the last step reached to the next', () => {
  const figures = verificationReferralFigures({
    ...baseStatus,
    accessWindow: 'wave-1',
    confirmedReferrals: 19,
  });
  assert.equal(
    figures.ladder.line,
    'Coupon 1: 30% · 2 more confirmed referrals to Coupon 2 at 5%.',
  );
  assert.deepEqual(figures.ladder.meter, {
    progress: 1,
    span: 3,
    target: 21,
    coupon: { number: 2, percent: 5 },
    // Already in wave 1, so the next step promises only the coupon.
    earlyAccessMonth: null,
  });
});

test('a first-1,000 member is never promised early access they already have', () => {
  const figures = verificationReferralFigures({
    ...baseStatus,
    accessWindow: 'wave-1',
    verificationOrderWindow: 'wave-1',
  });
  assert.equal(figures.ladder.meter?.earlyAccessMonth, null);
});

test('a complete ladder has no meter', () => {
  const figures = verificationReferralFigures({
    ...baseStatus,
    accessWindow: 'wave-1',
    confirmedReferrals: 60,
  });
  assert.equal(figures.ladder.meter, null);
  assert.equal(
    figures.ladder.line,
    'Coupon 1: 30% · Coupon 2: 30% · Coupon 3: 30% · The ladder is complete.',
  );
});

test('the figures follow a changed ladder configuration', () => {
  const figures = verificationReferralFigures(
    { ...baseStatus, confirmedReferrals: 5 },
    {
      ...ladderPresentationConfiguration,
      ladder: {
        ...couponLadder,
        unlocks: [4, 30],
        stepPercent: 10,
        stepReferrals: 4,
        maximumPercent: 20,
        expiryYears: 3,
      },
      waveOneReferrals: 4,
    },
  );
  assert.deepEqual(figures.ladder, {
    line: 'Coupon 1: 10% · 3 more confirmed referrals to 20%.',
    held: 'Coupons become usable once one of your referred friends places their first order, and last 3 years after launch.',
    meter: {
      progress: 1,
      span: 4,
      target: 8,
      coupon: { number: 1, percent: 20 },
      earlyAccessMonth: null,
    },
  });
});
