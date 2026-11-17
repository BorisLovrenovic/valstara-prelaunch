import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hostileIdentity,
  phaseCount,
  readProfile,
  referralCodeFor,
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
  // QA gate 7 (G7-1-I4/T4): both uncacheable page renders at the leaderboard
  // spike rate for two minutes, across 200 valid referral codes.
  assert.equal(
    phaseCount(profile.referralLandingRate, profile.pageSeconds),
    24000,
  );
  assert.equal(
    phaseCount(profile.leaderboardPageRate, profile.pageSeconds),
    24000,
  );
  assert.equal(profile.referralCodes, 200);
});

test('E11-01 referral landings cycle through distinct valid referral codes', () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes = Array.from({ length: 400 }, (_, index) =>
    referralCodeFor(index, 'a1b2c3d4', 200, alphabet),
  );
  assert.equal(new Set(codes).size, 200);
  assert.equal(codes[0], codes[200]);
  for (const code of codes) assert.match(code, /^[A-HJKMNP-Z2-9]{12}$/u);
  assert.notEqual(
    referralCodeFor(0, 'a1b2c3d4', 200, alphabet),
    referralCodeFor(0, 'a1b2c3d5', 200, alphabet),
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
