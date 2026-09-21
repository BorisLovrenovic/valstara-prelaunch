import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createLeaderboardRoute } from '../src/pages/api/leaderboard.ts';
import {
  createLeaderboardSnapshotCache,
  leaderboardRefreshIntervalMilliseconds,
  leaderboardSnapshotSize,
  startLeaderboardSnapshotScheduler,
  type LeaderboardSnapshot,
} from '../src/server/leaderboard/snapshot.ts';

const candidates = [
  {
    confirmedReferrals: 4,
    rank: 1,
    subscriberId: '86d37cb5-4c51-4d0e-91ee-717ed62b0025',
  },
] as const;

test('E6-01 snapshot is bounded to the authorised top 10 and discards source IDs', async () => {
  const limits: number[] = [];
  const cache = createLeaderboardSnapshotCache(
    {
      async leaderboardCandidates(limit) {
        limits.push(limit);
        return candidates;
      },
    },
    { now: () => new Date('2026-09-20T10:00:00.000Z') },
  );

  const snapshot = await cache.refresh();
  assert.deepEqual(limits, [leaderboardSnapshotSize]);
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.rank),
    [1],
  );
  assert.equal(snapshot.entries[0]?.displayHandle.length, 12);
  assert.doesNotMatch(JSON.stringify(snapshot), /86d37cb5/u);
});

test('E6-01 keeps the last good snapshot when a refresh fails', async () => {
  let shouldFail = false;
  const cache = createLeaderboardSnapshotCache(
    {
      async leaderboardCandidates() {
        if (shouldFail) throw new Error('database stopped');
        return candidates;
      },
    },
    { now: () => new Date('2026-09-20T10:00:00.000Z') },
  );
  const good = await cache.refresh();
  shouldFail = true;
  await assert.rejects(cache.refresh(), /database stopped/u);
  assert.deepEqual(cache.read(), good);
});

test('E6-01 scheduler refreshes immediately and every five minutes', async () => {
  let refreshes = 0;
  let scheduledAfter: number | undefined;
  let callback: (() => void) | undefined;
  const scheduler = startLeaderboardSnapshotScheduler(
    {
      read: () => null,
      async refresh() {
        refreshes += 1;
        return { asOf: '2026-09-20T10:00:00.000Z', entries: [] };
      },
    },
    {
      schedule(next, milliseconds) {
        callback = next;
        scheduledAfter = milliseconds;
        return { clear() {} };
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  callback?.();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.stop();

  assert.equal(scheduledAfter, leaderboardRefreshIntervalMilliseconds);
  assert.equal(refreshes, 2);
});

test('E6-01 public route reads only a supplied snapshot and exposes its safe response shape', async () => {
  const snapshot: LeaderboardSnapshot = {
    asOf: '2026-09-20T10:00:00.000Z',
    entries: [
      { confirmedReferrals: 4, displayHandle: 'BQBao_sEnxqw', rank: 1 },
    ],
  };
  let reads = 0;
  const route = createLeaderboardRoute({
    flags: {
      async isEnabled() {
        return true;
      },
    },
    snapshot: {
      read() {
        reads += 1;
        return snapshot;
      },
    },
  });

  const response = await route({} as Parameters<typeof route>[0]);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60');
  assert.equal(reads, 1);
  assert.deepEqual(body, {
    as_of: snapshot.asOf,
    entries: [
      { confirmed_referrals: 4, display_handle: 'BQBao_sEnxqw', rank: 1 },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(body),
    /email|country|referral_code|subscriber/i,
  );

  const routeSource = await readFile(
    new URL('../src/pages/api/leaderboard.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(routeSource, /server\/subscriber|FROM\s+subscriber/iu);
});

test('E6-01 flag-off route response is an honest 503 without reading the snapshot', async () => {
  const route = createLeaderboardRoute({
    flags: {
      async isEnabled() {
        return false;
      },
    },
    snapshot: {
      read() {
        throw new Error('flag-off must not read the snapshot');
      },
    },
  });

  const response = await route({} as Parameters<typeof route>[0]);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'unavailable',
      message: 'The leaderboard is paused right now.',
    },
  });
});
