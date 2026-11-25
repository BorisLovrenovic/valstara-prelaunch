import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// E11.8-01: a published Trust Ledger entry never changes. Every entry in
// src/content/trust-ledger/ at the merge base must still be there on the
// branch, byte for byte, so a change may only add entries; a mistake is
// corrected in the next entry, dated. "How we count" may change only together
// with a new entry that announces the change in its `howWeCountChanges`
// section. CI runs this inside `npm run security` with the pull request's
// base (SECURITY_BASE_SHA), comparing the working tree with the merge base of
// that base and HEAD. With no base, as in a local `npm run check`, it
// compares the working tree with HEAD.

export const trustLedgerEntryDirectory = 'src/content/trust-ledger';
export const howWeCountFile = 'src/content/trust-ledger-how-we-count.md';

function issue(path, message) {
  return { message, path, scan: 'trust-ledger-append-only' };
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readOrNull(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function announcesChange(source) {
  try {
    const entry = JSON.parse(source.toString('utf8'));
    return (
      Array.isArray(entry?.howWeCountChanges) &&
      entry.howWeCountChanges.some(
        (paragraph) => typeof paragraph === 'string' && paragraph.trim() !== '',
      )
    );
  } catch {
    return false;
  }
}

/** Issues for the published entries and "How we count", against `base`. */
export function scanTrustLedgerAppendOnly({ root, base }) {
  let revision;
  try {
    revision = base
      ? git(root, ['merge-base', base, 'HEAD']).toString('utf8').trim()
      : 'HEAD';
    git(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
  } catch (error) {
    return [
      issue(
        trustLedgerEntryDirectory,
        `could not resolve the revision to compare with (${base ?? 'HEAD'}): ${String(error)}`,
      ),
    ];
  }
  const published = git(root, [
    'ls-tree',
    '-r',
    '--name-only',
    revision,
    '--',
    trustLedgerEntryDirectory,
  ])
    .toString('utf8')
    .split('\n')
    .filter((path) => path.endsWith('.json'));
  const issues = [];
  for (const path of published) {
    const before = git(root, ['show', `${revision}:${path}`]);
    const now = readOrNull(join(root, path));
    if (now === null) {
      issues.push(issue(path, 'a published Trust Ledger entry was deleted'));
    } else if (!before.equals(now)) {
      issues.push(
        issue(
          path,
          'a published Trust Ledger entry was edited; correct it in the next entry instead',
        ),
      );
    }
  }

  const howWeCountPublished =
    git(root, ['ls-tree', '--name-only', revision, '--', howWeCountFile])
      .toString('utf8')
      .trim() !== '';
  if (howWeCountPublished) {
    const before = git(root, ['show', `${revision}:${howWeCountFile}`]);
    const now = readOrNull(join(root, howWeCountFile));
    if (now === null || !before.equals(now)) {
      const publishedSet = new Set(published);
      let names;
      try {
        names = readdirSync(join(root, trustLedgerEntryDirectory));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        names = [];
      }
      const announced = names
        .filter((name) => name.endsWith('.json'))
        .map((name) => `${trustLedgerEntryDirectory}/${name}`)
        .filter((path) => !publishedSet.has(path))
        .some((path) => announcesChange(readFileSync(join(root, path))));
      if (!announced) {
        issues.push(
          issue(
            howWeCountFile,
            now === null
              ? '"How we count" was deleted'
              : '"How we count" changed without a new entry that announces the change in howWeCountChanges',
          ),
        );
      }
    }
  }
  return issues;
}

function parseBase(argumentsList) {
  const index = argumentsList.indexOf('--base');
  return index === -1
    ? process.env.SECURITY_BASE_SHA || undefined
    : argumentsList[index + 1];
}

// Run on its own: `node scripts/ci/trust-ledger-append-only.mjs [--base <rev>]`
// checks the repository in the current directory.
if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  const issues = scanTrustLedgerAppendOnly({
    root: process.cwd(),
    base: parseBase(process.argv.slice(2)),
  });
  if (issues.length > 0) {
    process.stderr.write(
      `${issues.map(({ message, path, scan }) => `[${scan}] ${path}: ${message}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('Trust Ledger append-only check passed.\n');
  }
}
