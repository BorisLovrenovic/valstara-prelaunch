import assert from 'node:assert/strict';
import test from 'node:test';

import { leaderboardCopy } from '../src/copy/leaderboard.ts';
import {
  snapshotAgeFigure,
  splitOnFigure,
} from '../src/islands/leaderboard.ts';

// E11.5-11r: the meta line sets the snapshot age's figure and the snapshot
// time in mono by splitting the copy layer's sentence around them, never by
// rewording it.

test('E11.5-11r the age figure is the one snapshotAge prints, in seconds then minutes', () => {
  for (const [seconds, figure] of [
    [0, 0],
    [1, 1],
    [59, 59],
    [60, 1],
    [125, 2],
    [3_599, 59],
    [3_600, 60],
  ] as const) {
    assert.equal(snapshotAgeFigure(seconds), figure, `${seconds}s`);
    assert.ok(
      leaderboardCopy.snapshotAge(seconds).includes(` ${figure} `),
      `${seconds}s`,
    );
  }
});

test('E11.5-11r a sentence splits around its figure and joins back to the copy layer, unchanged', () => {
  for (const seconds of [0, 1, 7, 59, 60, 61, 180, 7_260]) {
    const sentence = leaderboardCopy.snapshotAge(seconds);
    const parts = splitOnFigure(sentence, String(snapshotAgeFigure(seconds)));
    assert.equal(parts.join(''), sentence);
    assert.equal(parts[1], String(snapshotAgeFigure(seconds)));
    assert.equal(parts[0], 'Snapshot age: ');
  }
  assert.deepEqual(
    splitOnFigure(
      `${leaderboardCopy.snapshotAsOf} Oct 28, 2026, 06:40 AM UTC`,
      'Oct 28, 2026, 06:40 AM UTC',
    ),
    ['Snapshot taken at ', 'Oct 28, 2026, 06:40 AM UTC', ''],
  );
  assert.deepEqual(
    splitOnFigure(leaderboardCopy.handle('k7Qx2LmP9aZb'), 'k7Qx2LmP9aZb'),
    ['Anonymous ', 'k7Qx2LmP9aZb', ''],
  );
});

test('E11.5-11r a sentence without the figure, or an empty figure, stays whole', () => {
  assert.deepEqual(splitOnFigure('Snapshot age: 3 minutes.', '4'), [
    'Snapshot age: 3 minutes.',
    '',
    '',
  ]);
  assert.deepEqual(splitOnFigure('Snapshot age: 3 minutes.', ''), [
    'Snapshot age: 3 minutes.',
    '',
    '',
  ]);
});
