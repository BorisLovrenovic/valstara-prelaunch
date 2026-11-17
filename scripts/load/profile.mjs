import { readFile } from 'node:fs/promises';

const fields = [
  'signupRate',
  'signupSeconds',
  'burstRate',
  'burstSeconds',
  'leaderboardRate',
  'leaderboardSeconds',
  'referralLandingRate',
  'leaderboardPageRate',
  'pageSeconds',
  'referralCodes',
  'hostileRate',
  'hostileSeconds',
  'exportRows',
  'maxFiveHundreds',
  'memorySampleSeconds',
];

export async function readProfile(path) {
  const profile = JSON.parse(await readFile(path, 'utf8'));
  for (const field of fields) {
    if (!Number.isInteger(profile[field]) || profile[field] < 0) {
      throw new RangeError(`${field} must be a nonnegative integer`);
    }
  }
  for (const field of fields.filter((name) => name !== 'maxFiveHundreds')) {
    if (profile[field] === 0) throw new RangeError(`${field} must be positive`);
  }
  return Object.freeze(profile);
}

export function signupIdentity(index, runId) {
  const group = Math.floor(index / 10);
  const unique = index % 10 !== 9;
  const number = unique ? index - group : index - group - 1;
  const email = `e1101-${runId}-${number}@gmail.com`;
  const prefix = `2001:db8:${(
    (Number.parseInt(runId.slice(0, 4), 16) + Math.floor(index / 65536)) %
    65536
  ).toString(16)}:${(index % 65536).toString(16)}::1`;
  return { email, prefix, unique };
}

// QA gate 7 (G7-1-I4/T4): referral-link landings spread across this many
// seeded referral codes, cycling in request order. Each code is a valid
// 12-character code from the production alphabet, unique per run.
export function referralCodeFor(index, runId, codes, alphabet) {
  const slot = index % codes;
  let value = Number.parseInt(runId, 16) * codes + slot;
  let code = '';
  for (let position = 0; position < 12; position += 1) {
    code += alphabet.charAt(value % alphabet.length);
    value = Math.floor(value / alphabet.length);
  }
  return code;
}

export function hostileIdentity(index, runId) {
  return {
    email: `e1101-${runId}-hostile-${index}@gmail.com`,
    prefix: `2001:db8:ffff:${runId.slice(0, 4)}::1`,
  };
}

export function phaseCount(rate, seconds) {
  if (!Number.isInteger(rate) || !Number.isInteger(seconds)) {
    throw new TypeError('Phase rate and duration must be integers');
  }
  return rate * seconds;
}

export function retryAfterMatchesWindow(
  header,
  windowStart,
  windowMs,
  requestStartedAt,
  responseEndedAt,
) {
  const seconds = Number(header);
  if (!Number.isInteger(seconds) || seconds < 1) return false;
  const reset = windowStart.getTime() + windowMs;
  const earliest = Math.max(
    1,
    Math.ceil((reset - responseEndedAt.getTime()) / 1000),
  );
  const latest = Math.max(
    1,
    Math.ceil((reset - requestStartedAt.getTime()) / 1000),
  );
  return seconds >= earliest && seconds <= latest;
}
