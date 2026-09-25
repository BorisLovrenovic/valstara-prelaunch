import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRulesAppendOnly } from '../scripts/ci/assert-rules-append-only.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('published rules files on the base branch remain byte-for-byte unchanged', () => {
  const base =
    process.env.RULES_BASE_SHA ?? process.env.COVERAGE_BASE_SHA ?? 'main';
  assert.doesNotThrow(() => assertRulesAppendOnly(projectRoot, base));
});

test('the append-only check rejects edits and deletion of a published revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-rules-history-'));
  const directory = join(root, 'src', 'content', 'giveaway-rules');
  const file = join(directory, 'VAL-GW-LAUNCH-20260925-r1.md');
  const git = (...args) => execFileSync('git', args, { cwd: root });
  try {
    await mkdir(directory, { recursive: true });
    git('init', '-q');
    await writeFile(file, 'published rules\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Rules Test',
      '-c',
      'user.email=rules@example.test',
      'commit',
      '-qm',
      'publish',
    );
    const base = git('rev-parse', 'HEAD').toString('utf8').trim();
    assert.doesNotThrow(() => assertRulesAppendOnly(root, base));
    await writeFile(file, 'edited rules\n');
    assert.throws(() => assertRulesAppendOnly(root, base), /was edited/u);
    await unlink(file);
    assert.throws(() => assertRulesAppendOnly(root, base), /was deleted/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
