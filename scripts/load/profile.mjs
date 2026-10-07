import { readFile } from 'node:fs/promises';

const fields = [
  'signupRate',
  'signupSeconds',
  'burstRate',
  'burstSeconds',
  'leaderboardRate',
  'leaderboardSeconds',
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
