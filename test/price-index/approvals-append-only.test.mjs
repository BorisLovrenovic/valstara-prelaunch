import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appendOnlyFiles,
  appendOnlyIssues,
  scanPriceIndexAppendOnly,
} from '../../scripts/ci/price-index-append-only.mjs';

// E11.6-06, epic rule 7: data/price-index/approvals.json is append-only,
// enforced in CI against the merge base. Editing, removing or reordering an
// existing entry, or deleting the file, fails; adding entries at the end
// passes. The red path plants the committed fixtures under
// test/fixtures/price-index/approvals/ in a real git repository and runs the
// check as CI does, with a base revision.

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const script = join(projectRoot, 'scripts/ci/price-index-append-only.mjs');
const approvals = appendOnlyFiles.find(
  (file) => file.path === 'data/price-index/approvals.json',
);

function fixture(name) {
  return readFile(
    join(projectRoot, 'test/fixtures/price-index/approvals', `${name}.json`),
    'utf8',
  );
}

test('approvals.json is one of the append-only files', () => {
  assert.deepEqual(approvals, {
    path: 'data/price-index/approvals.json',
    key: 'approvals',
  });
});

test('appending entries at the end, or changing nothing, passes', async () => {
  const base = await fixture('base');
  assert.deepEqual(appendOnlyIssues(approvals, base, base), []);
  assert.deepEqual(
    appendOnlyIssues(approvals, base, await fixture('appended')),
    [],
  );
  assert.deepEqual(
    appendOnlyIssues(approvals, '{ "approvals": [] }', base),
    [],
  );
});

test('a file that did not exist at the base passes', async () => {
  assert.deepEqual(
    appendOnlyIssues(approvals, null, await fixture('base')),
    [],
  );
});

test('reformatting or reordering keys inside an entry is not an edit', async () => {
  const base = await fixture('base');
  const data = JSON.parse(base);
  data.approvals[0] = Object.fromEntries(
    Object.entries(data.approvals[0]).reverse(),
  );
  assert.deepEqual(appendOnlyIssues(approvals, base, JSON.stringify(data)), []);
});

const red = [
  ['edited', /entry 1 was edited, moved or removed/],
  ['removed', /entry 1 was edited, moved or removed|entry 2 was removed/],
  ['reordered', /entry 1 was edited, moved or removed/],
];

for (const [name, pattern] of red) {
  test(`the check fails on the planted ${name} fixture`, async () => {
    const issues = appendOnlyIssues(
      approvals,
      await fixture('base'),
      await fixture(name),
    );
    assert.ok(issues.length > 0, `${name} passed`);
    assert.ok(
      issues.every((found) => found.scan === 'price-index-append-only'),
    );
    assert.ok(issues.every((found) => found.path === approvals.path));
    assert.match(issues.map((found) => found.message).join('\n'), pattern);
  });
}

test('deleting the file, or breaking it, fails', async () => {
  const base = await fixture('base');
  assert.match(
    appendOnlyIssues(approvals, base, null)[0].message,
    /was deleted/,
  );
  assert.match(appendOnlyIssues(approvals, base, '{')[0].message, /not JSON/);
  assert.match(
    appendOnlyIssues(approvals, base, '{ "entries": [] }')[0].message,
    /has no "approvals" list/,
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'valstara-append-only-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  await mkdir(join(root, 'data/price-index'), { recursive: true });
  git('init', '-q');
  return {
    root,
    git,
    async commit(name, message) {
      await writeFile(
        join(root, 'data/price-index/approvals.json'),
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

test('red path: a committed edit, removal or reorder fails the check against the merge base', async () => {
  for (const [name] of red) {
    const repo = await repository();
    try {
      await repo.commit('base', 'the published decisions');
      const base = repo.git('rev-parse', 'HEAD').trim();
      repo.git('switch', '-q', '-c', `fixture/${name}`);
      await repo.commit(name, `plant ${name}`);

      const result = repo.run(['--base', base]);
      assert.equal(result.status, 1, `${name}: ${result.stdout}`);
      assert.match(
        result.stderr,
        /\[price-index-append-only\] data\/price-index\/approvals\.json: /,
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

test('green path: a committed append passes, and so does a branch whose base never had the file', async () => {
  const repo = await repository();
  try {
    await repo.commit('base', 'the published decisions');
    const base = repo.git('rev-parse', 'HEAD').trim();
    await repo.commit('appended', 'one more decision');
    const result = repo.run(['--base', base]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /append-only check passed/);
  } finally {
    await repo.dispose();
  }

  const fresh = await repository();
  try {
    await writeFile(join(fresh.root, 'README'), 'empty\n');
    fresh.git('add', '.');
    fresh.git(
      '-c',
      'user.name=Append-only fixture',
      '-c',
      'user.email=append-only@valstara.invalid',
      'commit',
      '-qm',
      'before the file',
    );
    const base = fresh.git('rev-parse', 'HEAD').trim();
    await fresh.commit('base', 'the file arrives');
    assert.equal(fresh.run(['--base', base]).status, 0);
  } finally {
    await fresh.dispose();
  }
});

test('with no base the working tree is compared with HEAD, so an uncommitted edit fails', async () => {
  const repo = await repository();
  try {
    await repo.commit('base', 'the published decisions');
    assert.deepEqual(scanPriceIndexAppendOnly({ root: repo.root }), []);
    await writeFile(
      join(repo.root, 'data/price-index/approvals.json'),
      await fixture('edited'),
    );
    assert.match(
      scanPriceIndexAppendOnly({ root: repo.root })[0].message,
      /entry 1 was edited/,
    );
    await unlink(join(repo.root, 'data/price-index/approvals.json'));
    assert.match(
      scanPriceIndexAppendOnly({ root: repo.root })[0].message,
      /was deleted/,
    );
  } finally {
    await repo.dispose();
  }
});

test('a base revision that cannot be resolved fails closed', async () => {
  const repo = await repository();
  try {
    await repo.commit('base', 'the published decisions');
    const issues = scanPriceIndexAppendOnly({
      root: repo.root,
      base: 'no-such-revision',
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /could not resolve the revision/);
  } finally {
    await repo.dispose();
  }
});

test('the check is wired into npm run security with the pull request base, and passes on this repository', async () => {
  const gates = await readFile(
    join(projectRoot, 'scripts/ci/security-gates.mjs'),
    'utf8',
  );
  assert.match(
    gates,
    /import \{ scanPriceIndexAppendOnly \} from '\.\/price-index-append-only\.mjs';/,
  );
  assert.match(
    gates,
    /scanPriceIndexAppendOnly\(\{ root: projectRoot, base: options\.base \}\)/,
  );
  const workflow = await readFile(
    join(projectRoot, '.github/workflows/pr.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /SECURITY_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
  assert.deepEqual(scanPriceIndexAppendOnly({ root: projectRoot }), []);
});
