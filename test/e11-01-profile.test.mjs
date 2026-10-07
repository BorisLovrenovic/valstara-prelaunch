import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hostileIdentity,
  phaseCount,
  readProfile,
  retryAfterMatchesWindow,
  signupIdentity,
} from '../scripts/load/profile.mjs';

test('E11-01 profile makes the authorised rates configurable', async () => {
  const profile = await readProfile(
    new URL('../scripts/load/e11-01-profile.json', import.meta.url),
  );
  assert.equal(phaseCount(profile.signupRate, profile.signupSeconds), 12000);
  assert.equal(phaseCount(profile.burstRate, profile.burstSeconds), 3000);
  assert.equal(
    phaseCount(profile.leaderboardRate, profile.leaderboardSeconds),
    24000,
  );
});

test('E11-01 hostile wait follows the recorded fixed-window reset', () => {
  const windowStart = new Date('2026-10-07T12:00:00.000Z');
  const started = new Date('2026-10-07T12:00:09.100Z');
  const ended = new Date('2026-10-07T12:00:09.300Z');
  const windowMs = 15 * 60 * 1_000;
  assert.equal(
    retryAfterMatchesWindow('891', windowStart, windowMs, started, ended),
    true,
  );
  assert.equal(
    retryAfterMatchesWindow('900', windowStart, windowMs, started, ended),
    false,
  );
  assert.equal(
    retryAfterMatchesWindow('890', windowStart, windowMs, started, ended),
    false,
  );
});

test('E11-01 traffic has nine unique addresses per ten, with distinct normal prefixes', () => {
  const requests = Array.from({ length: 100 }, (_, i) =>
    signupIdentity(i, 'a1b2c3d4'),
  );
  assert.equal(requests.filter((request) => request.unique).length, 90);
  assert.equal(new Set(requests.map((request) => request.email)).size, 90);
  assert.equal(new Set(requests.map((request) => request.prefix)).size, 100);
  assert.equal(
    hostileIdentity(0, 'a1b2c3d4').prefix,
    hostileIdentity(99, 'a1b2c3d4').prefix,
  );
});
