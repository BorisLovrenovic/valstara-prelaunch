import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rulesDirectory = 'src/content/giveaway-rules';

function git(root, args) {
  return execFileSync('git', args, { cwd: root });
}

export function assertRulesAppendOnly(root, baseRevision) {
  const files = git(root, [
    'ls-tree',
    '-r',
    '--name-only',
    baseRevision,
    '--',
    rulesDirectory,
  ])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter((path) => path.endsWith('.md'));
  for (const file of files) {
    const published = git(root, ['show', `${baseRevision}:${file}`]);
    let working;
    try {
      working = readFileSync(join(root, file));
    } catch {
      throw new Error(`Published giveaway rules revision was deleted: ${file}`);
    }
    if (!published.equals(working)) {
      throw new Error(`Published giveaway rules revision was edited: ${file}`);
    }
  }
}
