import assert from 'node:assert/strict';
import test from 'node:test';

import { landingCopy } from '../src/copy/landing.ts';

// E11.5-11e: the drawn figures on the reward cards are formatted from their
// source values, never written into copy.

test('the coral pill figure is the tier discount it is given', () => {
  assert.equal(
    landingCopy.rewards.tierDiscount({ discountPercent: 15 }),
    '15%',
  );
  assert.equal(
    landingCopy.rewards.tierDiscount({ discountPercent: 30 }),
    '30%',
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

test('the drawn equation fragments are the tier sentence in pieces', () => {
  const tier = { discountPercent: 15, enabled: true, number: 1, threshold: 3 };
  const sentence = landingCopy.rewards.tier(tier);
  assert.ok(sentence.includes(landingCopy.rewards.tierReferrals));
  assert.ok(
    sentence.includes(
      `${landingCopy.rewards.tierDiscount(tier)} ${landingCopy.rewards.tierDiscountLabel}`,
    ),
  );
});
