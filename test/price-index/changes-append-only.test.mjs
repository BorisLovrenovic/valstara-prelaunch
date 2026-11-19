import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appendOnlyFiles,
  appendOnlyIssues,
  scanPriceIndexAppendOnly,
} from '../../scripts/ci/price-index-append-only.mjs';

// E11.6-09, epic rule 7: data/price-index/changes.json is append-only,
// enforced in CI by the same check as approvals.json (E11.6-06), against the
// merge base. Editing, removing or reordering an existing entry, or deleting
// the file, fails; adding entries at the end passes. The red path plants the
// committed fixtures under test/fixtures/price-index/changes/ in a real git
// repository and runs the check as CI does, with a base revision.

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const script = join(projectRoot, 'scripts/ci/price-index-append-only.mjs');
const changes = appendOnlyFiles.find(
  (file) => file.path === 'data/price-index/changes.json',
);

function fixture(name) {
  return readFile(
    join(projectRoot, 'test/fixtures/price-index/changes', `${name}.json`),
    'utf8',
  );
}

test('changes.json is one of the append-only files, beside approvals.json', () => {
  assert.deepEqual(changes, {
    path: 'data/price-index/changes.json',
    key: 'changes',
  });
  assert.ok(
    appendOnlyFiles.some(
      (file) => file.path === 'data/price-index/approvals.json',
    ),
  );
});

test('appending changes at the end, or changing nothing, passes', async () => {
  const base = await fixture('base');
  assert.deepEqual(appendOnlyIssues(changes, base, base), []);
  assert.deepEqual(
    appendOnlyIssues(changes, base, await fixture('appended')),
    [],
  );
  assert.deepEqual(appendOnlyIssues(changes, '{ "changes": [] }', base), []);
});

const red = [
  ['edited', /entry 1 was edited, moved or removed/],
  ['removed', /entry 1 was edited, moved or removed|entry 2 was removed/],
  ['reordered', /entry 1 was edited, moved or removed/],
];

for (const [name, pattern] of red) {
  test(`the check fails on the planted ${name} changes fixture`, async () => {
    const issues = appendOnlyIssues(
      changes,
      await fixture('base'),
      await fixture(name),
    );
    assert.ok(issues.length > 0, `${name} passed`);
    assert.ok(issues.every((found) => found.path === changes.path));
    assert.match(issues.map((found) => found.message).join('\n'), pattern);
  });
}

test('deleting changes.json, or breaking it, fails', async () => {
  const base = await fixture('base');
  assert.match(appendOnlyIssues(changes, base, null)[0].message, /was deleted/);
  assert.match(
    appendOnlyIssues(changes, base, '{ "approvals": [] }')[0].message,
    /has no "changes" list/,
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'valstara-changes-append-only-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  await mkdir(join(root, 'data/price-index'), { recursive: true });
  git('init', '-q');
  return {
    root,
    git,
    async commit(name, message) {
      await writeFile(
        join(root, 'data/price-index/changes.json'),
        await fixture(name),
      );
      git('add', '.');
      git(
        '-c',
        'user.name=Append-only fixture',
        '-c',
        'user.email=append-only@valstara.invalid',
        'commit',
        '-qm',
        message,
      );
    },
    run(args) {
      return spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        encoding: 'utf8',
      });
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test('red path: a committed edit, removal or reorder of changes.json fails the check against the merge base', async () => {
  for (const [name] of red) {
    const repo = await repository();
    try {
      await repo.commit('base', 'the logged changes');
      const base = repo.git('rev-parse', 'HEAD').trim();
      repo.git('switch', '-q', '-c', `fixture/${name}`);
      await repo.commit(name, `plant ${name}`);

      const result = repo.run(['--base', base]);
      assert.equal(result.status, 1, `${name}: ${result.stdout}`);
      assert.match(
        result.stderr,
        /\[price-index-append-only\] data\/price-index\/changes\.json: /,
      );
      assert.notEqual(
        scanPriceIndexAppendOnly({ root: repo.root, base }).length,
        0,
      );
    } finally {
      await repo.dispose();
    }
  }
});

test('green path: a committed append to changes.json passes', async () => {
  const repo = await repository();
  try {
    await repo.commit('base', 'the logged changes');
    const base = repo.git('rev-parse', 'HEAD').trim();
    await repo.commit('appended', 'one more change');
    const result = repo.run(['--base', base]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /append-only check passed/);
  } finally {
    await repo.dispose();
  }
});

test('the committed changes.json passes the check and is seeded empty or appended to', async () => {
  assert.deepEqual(scanPriceIndexAppendOnly({ root: projectRoot }), []);
  const committed = JSON.parse(
    await readFile(join(projectRoot, 'data/price-index/changes.json'), 'utf8'),
  );
  assert.ok(Array.isArray(committed.changes));
});
