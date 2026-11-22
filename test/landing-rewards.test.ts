import assert from 'node:assert/strict';
import test from 'node:test';

import { landingCopy } from '../src/copy/landing.ts';
import { referralLadderCopy } from '../src/copy/referral-ladder.ts';
import { couponLadder } from '../src/server/referral/config.ts';
import {
  ladderPresentationConfiguration,
  landingLadder,
} from '../src/server/referral/ladder-presentation.ts';

// E11.5-11e: the drawn figures on the reward cards are formatted from their
// source values, never written into copy.

test('the coral pill figure is the first coupon percent it is given', () => {
  assert.equal(referralLadderCopy.percent(5), '5%');
  assert.equal(
    landingLadder().percent,
    couponLadder.stepPercent,
    'the drawn percent is the configured first step',
  );
  assert.equal(
    landingLadder({
      ...ladderPresentationConfiguration,
      ladder: { ...couponLadder, stepPercent: 6, maximumPercent: 30 },
    }).percent,
    6,
  );
});

test('the drawn prize value is the rules value in euros, grouped like the prize sentence', () => {
  for (const prizeApproxRetailValueEur of [300, 350, 1_250]) {
    const value = landingCopy.rewards.prizeValue({
      prizeApproxRetailValueEur,
    });
    assert.equal(
      value,
      `€${prizeApproxRetailValueEur.toLocaleString('en-US')}`,
    );
    // The hidden sentence and the drawn figure always state the same value.
    assert.ok(
      landingCopy.rewards
        .prize({ prizeCount: 5, prizeApproxRetailValueEur })
        .includes(` ${value} `),
    );
  }
  assert.equal(
    landingCopy.rewards.prizeValue({ prizeApproxRetailValueEur: 1_250 }),
    '€1,250',
  );
});

test('the drawn equation fragments are the ladder sentence in pieces', () => {
  const ladder = landingLadder();
  assert.ok(ladder.earlyAccessMonth !== null);
  assert.ok(
    ladder.sentence.startsWith(
      `${ladder.threshold} ${landingCopy.rewards.tierReferrals}`,
    ),
  );
  assert.ok(
    ladder.sentence.includes(
      `${referralLadderCopy.percent(ladder.percent)} ${referralLadderCopy.landing.couponLabel}`,
    ),
  );
  assert.ok(ladder.sentence.includes(ladder.earlyAccessMonth));
});
