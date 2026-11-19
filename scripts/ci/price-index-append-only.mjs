import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The price-index append-only check (E11.6-06, epic rule 7; changes.json
// from E11.6-09). History is never
// rewritten: every entry a data file holds at the merge base must still be
// there, unchanged and in the same place, so a change may only add entries at
// the end. CI runs it inside `npm run security` with the pull request's base
// (SECURITY_BASE_SHA), comparing the working tree with the merge base of
// that base and HEAD. With no base, as in a local `npm run check`, it
// compares the working tree with HEAD.
//
// Entries are compared as JSON values, so formatting alone is not an edit.

export const appendOnlyFiles = [
  { path: 'data/price-index/approvals.json', key: 'approvals' },
  // E11.6-09: the change log of real price changes.
  { path: 'data/price-index/changes.json', key: 'changes' },
];

function issue(path, message) {
  return { message, path, scan: 'price-index-append-only' };
}

/** The same JSON value, with object keys in a fixed order. */
function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function entries(text, key) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { problem: 'is not JSON' };
  }
  if (data === null || typeof data !== 'object' || !Array.isArray(data[key])) {
    return { problem: `has no "${key}" list` };
  }
  return { list: data[key].map((entry) => JSON.stringify(canonical(entry))) };
}

/**
 * Issues for one file: `baseText` is the file at the merge base (null when
 * it did not exist there), `currentText` the working copy (null when it is
 * gone). Every entry at the base must be unchanged at the same position.
 */
export function appendOnlyIssues({ path, key }, baseText, currentText) {
  if (baseText === null) {
    return [];
  }
  if (currentText === null) {
    return [issue(path, 'was deleted; it is append-only')];
  }
  const base = entries(baseText, key);
  if (base.problem) {
    return [issue(path, `at the merge base ${base.problem}`)];
  }
  const current = entries(currentText, key);
  if (current.problem) {
    return [issue(path, current.problem)];
  }
  const issues = [];
  base.list.forEach((entry, index) => {
    if (index >= current.list.length) {
      issues.push(
        issue(path, `entry ${index + 1} was removed; the file is append-only`),
      );
    } else if (current.list[index] !== entry) {
      issues.push(
        issue(
          path,
          `entry ${index + 1} was edited, moved or removed; the file is append-only`,
        ),
      );
    }
  });
  return issues;
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Issues for every append-only file, against `base`'s merge base or HEAD. */
export function scanPriceIndexAppendOnly({ root, base }) {
  let revision;
  try {
    revision = base ? git(root, ['merge-base', base, 'HEAD']).trim() : 'HEAD';
    git(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
  } catch (error) {
    return [
      issue(
        '.',
        `could not resolve the revision to compare with (${base ?? 'HEAD'}): ${String(error)}`,
      ),
    ];
  }
  const issues = [];
  for (const file of appendOnlyFiles) {
    const listed = git(root, [
      'ls-tree',
      '--name-only',
      revision,
      '--',
      file.path,
    ]).trim();
    const baseText =
      listed === '' ? null : git(root, ['show', `${revision}:${file.path}`]);
    let currentText;
    try {
      currentText = readFileSync(join(root, file.path), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      currentText = null;
    }
    issues.push(...appendOnlyIssues(file, baseText, currentText));
  }
  return issues;
}

function parseBase(argumentsList) {
  const index = argumentsList.indexOf('--base');
  return index === -1
    ? process.env.SECURITY_BASE_SHA || undefined
    : argumentsList[index + 1];
}

// Run on its own: `node scripts/ci/price-index-append-only.mjs [--base <rev>]`
// checks the repository in the current directory.
if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  const issues = scanPriceIndexAppendOnly({
    root: process.cwd(),
    base: parseBase(process.argv.slice(2)),
  });
  if (issues.length > 0) {
    process.stderr.write(
      `${issues.map(({ message, path, scan }) => `[${scan}] ${path}: ${message}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('Price-index append-only check passed.\n');
  }
}
