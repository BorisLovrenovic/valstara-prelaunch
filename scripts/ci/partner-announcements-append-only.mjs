import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// E11.7-16: a published partner announcement never changes. Every file in
// src/content/partner-announcements/ at the merge base must still be there on
// the branch, byte for byte, so a change may only add announcements. CI runs
// it inside `npm run security` with the pull request's base
// (SECURITY_BASE_SHA), comparing the working tree with the merge base of that
// base and HEAD. With no base, as in a local `npm run check`, it compares the
// working tree with HEAD.

export const announcementDirectory = 'src/content/partner-announcements';

function issue(path, message) {
  return { message, path, scan: 'partner-announcements-append-only' };
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Issues for every published announcement, against `base`'s merge base or HEAD. */
export function scanPartnerAnnouncementsAppendOnly({ root, base }) {
  let revision;
  try {
    revision = base
      ? git(root, ['merge-base', base, 'HEAD']).toString('utf8').trim()
      : 'HEAD';
    git(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
  } catch (error) {
    return [
      issue(
        announcementDirectory,
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
    announcementDirectory,
  ])
    .toString('utf8')
    .split('\n')
    .filter((path) => path.endsWith('.md'));
  const issues = [];
  for (const path of published) {
    const before = git(root, ['show', `${revision}:${path}`]);
    let now;
    try {
      now = readFileSync(join(root, path));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      issues.push(issue(path, 'a published announcement was deleted'));
      continue;
    }
    if (!before.equals(now)) {
      issues.push(
        issue(
          path,
          'a published announcement was edited; publish a new file instead',
        ),
      );
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

// Run on its own: `node scripts/ci/partner-announcements-append-only.mjs
// [--base <rev>]` checks the repository in the current directory.
if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  const issues = scanPartnerAnnouncementsAppendOnly({
    root: process.cwd(),
    base: parseBase(process.argv.slice(2)),
  });
  if (issues.length > 0) {
    process.stderr.write(
      `${issues.map(({ message, path, scan }) => `[${scan}] ${path}: ${message}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('Partner announcements append-only check passed.\n');
  }
}
