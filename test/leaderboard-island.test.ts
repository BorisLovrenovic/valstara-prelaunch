import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { leaderboardCopy } from '../src/copy/leaderboard.ts';
import { flagCacheTtlMilliseconds } from '../src/server/flags/service.ts';
import {
  formatSnapshotTimestamp,
  leaderboardPollIntervalMilliseconds,
  parseLeaderboardSnapshot,
  snapshotAgeSeconds,
} from '../src/islands/leaderboard.ts';

test('E6-02 preserves exact snapshot counts and never pads a short board', () => {
  const snapshot = parseLeaderboardSnapshot({
    as_of: '2026-09-21T10:00:00.000Z',
    entries: [
      {
        confirmed_referrals: 7,
        display_handle: 'first-handle',
        rank: 1,
      },
      {
        confirmed_referrals: 3,
        display_handle: 'second-handle',
        rank: 2,
      },
    ],
  });

  assert.notEqual(snapshot, null);
  assert.equal(snapshot?.entries.length, 2);
  assert.deepEqual(
    snapshot?.entries.map((entry) => entry.confirmedReferrals),
    [7, 3],
  );
  assert.equal(leaderboardCopy.confirmedReferrals(7), '7 confirmed referrals');
});

test('E6-02 rejects malformed snapshot values instead of manufacturing display data', () => {
  for (const malformed of [
    null,
    { as_of: 'not-a-date', entries: [] },
    {
      as_of: '2026-09-21T10:00:00.000Z',
      entries: [
        { confirmed_referrals: 1.5, display_handle: 'handle', rank: 1 },
      ],
    },
    {
      as_of: '2026-09-21T10:00:00.000Z',
      entries: [{ confirmed_referrals: 1, display_handle: '', rank: 1 }],
    },
  ]) {
    assert.equal(parseLeaderboardSnapshot(malformed), null);
  }
});

test('E6-02 exposes the snapshot timestamp and a clock-derived age', () => {
  const asOf = '2026-09-21T10:00:00.000Z';
  assert.equal(
    snapshotAgeSeconds(asOf, new Date('2026-09-21T10:02:05.900Z')),
    125,
  );
  assert.match(formatSnapshotTimestamp(asOf), /2026/u);
  assert.equal(leaderboardCopy.snapshotAge(125), 'Snapshot age: 2 minutes.');
});

test('E6-02 polling cannot outlive the registered flag TTL', () => {
  assert.equal(leaderboardPollIntervalMilliseconds, flagCacheTtlMilliseconds);
});

test('E6-02 is the third and final island and has no personal-rank path', async () => {
  const islandDirectory = new URL('../src/islands/', import.meta.url);
  const islands = (await readdir(islandDirectory))
    .filter((path) => path.endsWith('.astro'))
    .sort();
  assert.deepEqual(islands, [
    'Leaderboard.astro',
    'SignupForm.astro',
    'ThemeToggle.astro',
  ]);

  const [component, page] = await Promise.all([
    readFile(
      new URL('../src/islands/Leaderboard.astro', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../src/pages/leaderboard.astro', import.meta.url),
      'utf8',
    ),
  ]);
  const source = `${component}\n${page}`;
  assert.doesNotMatch(source, /statusToken|verification\/|searchParams/u);
  assert.doesNotMatch(source, /server\/subscriber|FROM\s+subscriber/iu);
  assert.match(source, /\/api\/leaderboard/u);
});

test('E6-02 component styling uses portable tokens for visual values', async () => {
  const source = await readFile(
    new URL('../src/islands/Leaderboard.astro', import.meta.url),
    'utf8',
  );
  const literalColour = /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu;
  const tokenisedProperties = [
    /\b(?:background-)?color\s*:\s*([^;]+)/giu,
    /\bfont(?:-family|-size)?\s*:\s*([^;]+)/giu,
    /\bline-height\s*:\s*([^;]+)/giu,
    /\bborder-radius\s*:\s*([^;]+)/giu,
    /\b(?:margin|padding|gap|inset|top|right|bottom|left|outline-offset)(?:-[\w-]+)?\s*:\s*([^;]+)/giu,
    /\b(?:animation|transition)-duration\s*:\s*([^;]+)/giu,
  ];

  assert.doesNotMatch(source, literalColour);
  for (const propertyPattern of tokenisedProperties) {
    for (const match of source.matchAll(propertyPattern)) {
      assert.match(
        match[1].trim(),
        /^(?:var\(|inherit\b|currentColor\b|transparent\b|0\b|none\b|auto\b)/u,
        `leaderboard island has a literal value in "${match[0]}"`,
      );
    }
  }
});
