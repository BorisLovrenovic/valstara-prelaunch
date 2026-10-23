import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  browserSuites,
  changedFilesSince,
  reachesBrowser,
  selectTests,
} from '../scripts/ci/changed-tests.mjs';

async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), 'valstara-changed-tests-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const files = {
  'src/server/referral/status.ts': "export const status = 'ok';\n",
  'src/server/referral/service.ts':
    "import { status } from './status.ts';\nexport const service = status;\n",
  'src/copy/landing.ts': "export const landing = 'Join';\n",
  'scripts/ci/tool.mjs': 'export const tool = 1;\n',
  'test/referral.test.mjs':
    "import { service } from '../src/server/referral/service.ts';\n",
  'test/landing.test.ts': "import { landing } from '../src/copy/landing.ts';\n",
  'test/tool.test.mjs':
    "const source = new URL('../scripts/ci/tool.mjs', import.meta.url);\n",
  'test/lazy.test.mjs':
    "const loaded = await import('../src/server/referral/status.ts');\n",
  'test/unrelated.test.mjs': "import assert from 'node:assert/strict';\n",
  'test/cycle-a.test.mjs': "import './cycle-b.test.mjs';\n",
  'test/cycle-b.test.mjs': "import './cycle-a.test.mjs';\n",
};
const candidates = Object.keys(files).filter((file) =>
  file.startsWith('test/'),
);

test('a server change selects every test that reaches it through imports', async () => {
  const root = await tree(files);
  try {
    const selected = await selectTests({
      root,
      changedFiles: ['src/server/referral/status.ts'],
      candidates,
    });
    assert.deepEqual(
      [...selected],
      [
        ['test/lazy.test.mjs', 'imports src/server/referral/status.ts'],
        ['test/referral.test.mjs', 'imports src/server/referral/status.ts'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changed tests, files read through new URL and named suites are selected', async () => {
  const root = await tree(files);
  try {
    const selected = await selectTests({
      root,
      changedFiles: ['scripts/ci/tool.mjs', 'test/unrelated.test.mjs'],
      candidates,
      named: ['test/cycle-a.test.mjs'],
    });
    assert.deepEqual(
      [...selected],
      [
        ['test/cycle-a.test.mjs', 'named'],
        ['test/tool.test.mjs', 'imports scripts/ci/tool.mjs'],
        ['test/unrelated.test.mjs', 'changed'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a browser-facing change also runs the privacy and accessibility suites', async () => {
  const root = await tree(files);
  try {
    const selected = await selectTests({
      root,
      changedFiles: ['src/copy/landing.ts'],
      candidates,
    });
    assert.deepEqual(
      [...selected],
      [
        ...browserSuites.map((suite) => [
          suite,
          'browser-facing change: src/copy/landing.ts',
        ]),
        ['test/landing.test.ts', 'imports src/copy/landing.ts'],
      ].sort(([a], [b]) => a.localeCompare(b)),
    );
    for (const file of [
      'src/pages/me.astro',
      'src/islands/Leaderboard.astro',
      'src/styles/tokens.css',
      'public/page-view.js',
      'astro.config.mjs',
    ]) {
      assert.equal(reachesBrowser(file), true, file);
    }
    for (const file of [
      'src/server/db/pool.ts',
      'docs/README.md',
      'test/x.test.mjs',
    ]) {
      assert.equal(reachesBrowser(file), false, file);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the browser suites are exactly the files test:privacy and test:a11y run', async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const named = (script) => script.match(/test\/[\w.-]+\.test\.mjs/gu);

  assert.deepEqual(
    browserSuites.toSorted(),
    [
      ...named(scripts['test:privacy']),
      ...named(scripts['test:a11y']),
    ].toSorted(),
  );
});

test('changed files include commits, uncommitted edits and untracked files since the base', async () => {
  const root = await tree({
    'src/a.ts': 'a\n',
    'src/b.ts': 'b\n',
    'src/c.ts': 'c\n',
  });
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    git('init', '--quiet', '--initial-branch=main');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@valstara.invalid',
      'commit',
      '--quiet',
      '-m',
      'base',
    );
    git('switch', '--quiet', '-c', 'feature');
    await writeFile(join(root, 'src/a.ts'), 'a2\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@valstara.invalid',
      'commit',
      '--quiet',
      '-m',
      'change a',
    );
    await writeFile(join(root, 'src/b.ts'), 'b2\n');
    await writeFile(join(root, 'src/new.ts'), 'new\n');

    assert.deepEqual(changedFilesSince(root, 'main'), [
      'src/a.ts',
      'src/b.ts',
      'src/new.ts',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
