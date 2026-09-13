import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  accessWindowBands,
  accessWindowForVerificationOrder,
  accessWindows,
  promoteAccessWindow,
  type AccessWindowBand,
} from '../src/server/referral/config.ts';

test('verification order and tier deterministically select the configured access window', () => {
  const cases = [
    { expected: 'wave-1', order: 1, tier: 0 },
    { expected: 'wave-1', order: 1_000, tier: 0 },
    { expected: 'wave-2', order: 1_001, tier: 0 },
    { expected: 'wave-2', order: 5_000, tier: 0 },
    { expected: 'wave-3', order: 5_001, tier: 0 },
    { expected: 'wave-3', order: 15_000, tier: 0 },
    { expected: 'wave-4', order: 15_001, tier: 0 },
    { expected: 'wave-3', order: 15_001, tier: 1 },
    { expected: 'wave-2', order: 15_001, tier: 2 },
    { expected: 'wave-1', order: 15_001, tier: 3 },
  ] as const;

  for (const { expected, order, tier } of cases) {
    assert.equal(accessWindowForVerificationOrder(order, tier), expected);
  }
});

test('wave distribution is injectable configuration rather than schema', () => {
  const tunedBands: readonly AccessWindowBand[] = [
    { maximumVerificationOrder: 2, window: 'wave-1' },
    { maximumVerificationOrder: 3, window: 'wave-2' },
    { maximumVerificationOrder: 4, window: 'wave-3' },
    { maximumVerificationOrder: null, window: 'wave-4' },
  ];

  assert.equal(accessWindowForVerificationOrder(2, 0, tunedBands), 'wave-1');
  assert.equal(accessWindowForVerificationOrder(5, 0, tunedBands), 'wave-4');
  assert.equal(accessWindowForVerificationOrder(5, 2, tunedBands), 'wave-2');
  assert.deepEqual(
    accessWindowBands.map((band) => band.maximumVerificationOrder),
    [1_000, 5_000, 15_000, null],
  );
});

test('invalid assignment inputs and an incomplete distribution fail closed', () => {
  assert.throws(() => accessWindowForVerificationOrder(0), /positive integer/u);
  assert.throws(
    () => accessWindowForVerificationOrder(1, -1),
    /non-negative integer/u,
  );
  assert.throws(
    () => accessWindowForVerificationOrder(1, 0.5),
    /non-negative integer/u,
  );
  assert.throws(() => promoteAccessWindow('wave-2', -1), /non-negative/u);
  assert.throws(
    () =>
      accessWindowForVerificationOrder(2, 0, [
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
