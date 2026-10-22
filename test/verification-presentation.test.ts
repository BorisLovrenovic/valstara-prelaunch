import assert from 'node:assert/strict';
import test from 'node:test';

import { verificationCopy } from '../src/copy/verification.ts';
import { verificationReferralFigures } from '../src/server/referral/verification-presentation.ts';
import type { ReferralStatus } from '../src/server/referral/status.ts';

const baseStatus: ReferralStatus = {
  accessWindow: 'wave-2',
  confirmedReferrals: 0,
  giveawayEntries: 1,
  ownRank: null,
  referralLink: 'https://valstara.com/?ref=TESTREF12345',
  rewards: [],
  subscriberStatus: 'verified',
  tier: 0,
};

test('verification marketing copy stays within the E11.5 scan budget', () => {
  const words = (value: string) => value.trim().split(/\s+/u).length;
  for (const heading of [
    verificationCopy.confirm.body,
    verificationCopy.complete,
    verificationCopy.invalidHeading,
    verificationCopy.referral.label,
    verificationCopy.referral.unlocks(1),
    verificationCopy.survey.heading,
    verificationCopy.status.label,
  ]) {
    assert.ok(words(heading) <= 7, heading);
  }
  for (const line of [
    verificationCopy.confirm.next,
    verificationCopy.completeNext,
    verificationCopy.invalid,
    verificationCopy.referral.heldCondition,
  ]) {
    assert.ok(words(line) <= 20, line);
  }
  for (const cardText of [
    verificationCopy.referral.link,
    verificationCopy.referral.progress(0, 3, 1),
    verificationCopy.referral.reward(15),
    verificationCopy.referral.waveReward,
    verificationCopy.referral.wave('wave-1'),
    ...verificationCopy.survey.categoryOptions.map((option) => option.label),
    ...verificationCopy.survey.frequencyOptions.map((option) => option.label),
  ]) {
    assert.ok(words(cardText) <= 15, cardText);
  }
});

test('verification figures use the enabled ladder and exact shared count', () => {
  assert.deepEqual(verificationReferralFigures(baseStatus), {
    accessWindow: 'wave-2',
    ladder: {
      confirmedReferrals: 0,
      discountPercent: 15,
      progress: 0,
      rewardStates: [],
      threshold: 3,
      tier: 1,
    },
  });
  assert.equal(
    verificationReferralFigures({
      ...baseStatus,
      confirmedReferrals: 2,
    }).ladder?.progress,
    2,
  );
});

test('verification ladder figures follow a non-default ladder', () => {
  const ladder = [
    { discountPercent: 15, enabled: false, number: 1, threshold: 3 },
    { discountPercent: 20, enabled: true, number: 2, threshold: 4 },
  ];
  assert.deepEqual(
    verificationReferralFigures(
      {
        ...baseStatus,
        confirmedReferrals: 1,
        rewards: [
          { kind: 'wave_upgrade', state: 'settled', tier: 1 },
          { kind: 'discount', state: 'held', tier: 2 },
        ],
      },
      ladder,
    ),
    {
      accessWindow: 'wave-2',
      ladder: {
        confirmedReferrals: 1,
        discountPercent: 20,
        progress: 1,
        rewardStates: [{ kind: 'discount', state: 'held' }],
        threshold: 4,
        tier: 2,
      },
    },
  );
});

test('the access wave survives a ladder with no enabled tier', () => {
  assert.deepEqual(
    verificationReferralFigures(baseStatus, [
      { discountPercent: 15, enabled: false, number: 1, threshold: 3 },
    ]),
    { accessWindow: 'wave-2', ladder: null },
  );
});

test('earned states come from status; a disabled tier is never promised', () => {
  const result = verificationReferralFigures({
    ...baseStatus,
    confirmedReferrals: 4,
    tier: 1,
    rewards: [
      { kind: 'wave_upgrade', state: 'settled', tier: 1 },
      { kind: 'discount', state: 'held', tier: 1 },
    ],
  });
  assert.equal(result.ladder?.tier, 1);
  assert.equal(result.ladder?.progress, 3);
  assert.deepEqual(result.ladder?.rewardStates, [
    { kind: 'wave_upgrade', state: 'settled' },
    { kind: 'discount', state: 'held' },
  ]);
});
