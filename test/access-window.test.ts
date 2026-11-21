import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  accessWindowBands,
  accessWindowForReferrals,
  accessWindowForVerificationOrder,
  accessWindows,
  type AccessWindowBand,
} from '../src/server/referral/config.ts';

test('verification order deterministically selects the configured access window', () => {
  const cases = [
    { expected: 'wave-1', order: 1 },
    { expected: 'wave-1', order: 1_000 },
    { expected: 'wave-2', order: 1_001 },
    { expected: 'wave-2', order: 5_000 },
    { expected: 'wave-3', order: 5_001 },
    { expected: 'wave-3', order: 15_000 },
    { expected: 'wave-4', order: 15_001 },
  ] as const;

  for (const { expected, order } of cases) {
    assert.equal(accessWindowForVerificationOrder(order), expected);
  }
});

test('3 confirmed referrals put a member in wave 1, and the first-1,000 place holds without any (E11.7-03)', () => {
  const cases = [
    { expected: 'wave-4', window: 'wave-4', referrals: 2 },
    { expected: 'wave-1', window: 'wave-4', referrals: 3 },
    { expected: 'wave-2', window: 'wave-2', referrals: 0 },
    { expected: 'wave-1', window: 'wave-2', referrals: 60 },
    { expected: 'wave-1', window: 'wave-1', referrals: 0 },
  ] as const;

  for (const { expected, window, referrals } of cases) {
    assert.equal(accessWindowForReferrals(window, referrals), expected);
  }
  assert.equal(accessWindowForReferrals('wave-3', 2, 2), 'wave-1');
});

test('wave distribution is injectable configuration rather than schema', () => {
  const tunedBands: readonly AccessWindowBand[] = [
    { maximumVerificationOrder: 2, window: 'wave-1' },
    { maximumVerificationOrder: 3, window: 'wave-2' },
    { maximumVerificationOrder: 4, window: 'wave-3' },
    { maximumVerificationOrder: null, window: 'wave-4' },
  ];

  assert.equal(accessWindowForVerificationOrder(2, tunedBands), 'wave-1');
  assert.equal(accessWindowForVerificationOrder(3, tunedBands), 'wave-2');
  assert.equal(accessWindowForVerificationOrder(5, tunedBands), 'wave-4');
  assert.deepEqual(
    accessWindowBands.map((band) => band.maximumVerificationOrder),
    [1_000, 5_000, 15_000, null],
  );
});

test('invalid assignment inputs and an incomplete distribution fail closed', () => {
  assert.throws(() => accessWindowForVerificationOrder(0), /positive integer/u);
  assert.throws(
    () => accessWindowForVerificationOrder(1.5),
    /positive integer/u,
  );
  assert.throws(
    () => accessWindowForReferrals('wave-2', -1),
    /non-negative integer/u,
  );
  assert.throws(
    () => accessWindowForReferrals('wave-2', 0.5),
    /non-negative integer/u,
  );
  assert.throws(
    () =>
      accessWindowForVerificationOrder(2, [
        { maximumVerificationOrder: 1, window: 'wave-1' },
      ]),
    /each handoff wave in order/u,
  );
});

test('access-window values exactly match the launch-day handoff customer groups', async () => {
  const model = await readFile(
    new URL('../docs/data/model.md', import.meta.url),
    'utf8',
  );
  const handoff = model.slice(
    model.indexOf('## The launch-day handoff contract'),
  );
  const sequence = handoff.match(/assign customer groups[^\n]+/u)?.[0] ?? '';
  const range = sequence.match(/`wave-(\d)`…`wave-(\d)`/u);
  assert.notEqual(range, null);
  const first = Number(range?.[1]);
  const last = Number(range?.[2]);
  const documented = Array.from(
    { length: last - first + 1 },
    (_value, index) => `wave-${first + index}`,
  );

  assert.deepEqual(documented, [...accessWindows]);
});
