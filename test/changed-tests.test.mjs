import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  affectedDependencies,
  browserSuites,
  changedFilesSince,
  changedPackages,
  chooseTests,
  packageImports,
  parseArguments,
  reachesBrowser,
  repositoryReads,
  selectBranchTests,
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

test('only runtime imports of packages count, not type-only ones', () => {
  assert.deepEqual(
    [
      ...packageImports(
        [
          "import type { APIRoute } from 'astro';",
          "export type { Row } from 'pg';",
          "import { z } from 'astro/zod';",
          "import {\n  type Mail,\n  send,\n} from '@scope/mailer/client';",
          "import 'side-effect';",
          "const lazy = await import('lazy-package');",
          "import { readFile } from 'node:fs/promises';",
          "import { defineMiddleware } from 'astro:middleware';",
          "import { local } from './local.ts';",
        ].join('\n'),
      ),
    ].sort(),
    ['@scope/mailer', 'astro', 'lazy-package', 'side-effect'],
  );
});

const lock = (packages) => ({ lockfileVersion: 3, packages });
const baseLock = lock({
  '': {
    dependencies: { mailparser: '1.0.0', astro: '7.3.3' },
    devDependencies: { eslint: '9.0.0' },
  },
  'node_modules/mailparser': {
    version: '1.0.0',
    dependencies: { libmime: '^2' },
  },
  'node_modules/libmime': { version: '2.0.0' },
  'node_modules/astro': { version: '7.3.3', dependencies: { undici: '^8' } },
  'node_modules/undici': { version: '8.11.2' },
  'node_modules/eslint': { version: '9.0.0', dependencies: { ajv: '^6' } },
  'node_modules/ajv': { version: '6.0.0', dependencies: { 'fast-uri': '^3' } },
  'node_modules/fast-uri': { version: '3.0.0' },
  'node_modules/old-helper': { version: '1.0.0' },
});
const currentLock = lock({
  ...baseLock.packages,
  'node_modules/libmime': { version: '2.0.1' },
  'node_modules/fast-uri': { version: '3.1.0' },
  'node_modules/astro/node_modules/undici': { version: '8.12.0' },
  'node_modules/old-helper': undefined,
});
delete currentLock.packages['node_modules/old-helper'];

test('a lockfile change names each installed package that changed', () => {
  assert.deepEqual([...changedPackages(baseLock, currentLock)].sort(), [
    'fast-uri',
    'libmime',
    'old-helper',
    'undici',
  ]);
  assert.deepEqual([...changedPackages(currentLock, currentLock)], []);
});

test('a changed package reaches every direct dependency that installs it', () => {
  const affected = affectedDependencies(
    [baseLock, currentLock],
    changedPackages(baseLock, currentLock),
  );
  assert.deepEqual(
    [...affected].map(([name, causes]) => [name, [...causes].sort()]).sort(),
    [
      ['astro', ['undici']],
      ['eslint', ['fast-uri']],
      ['mailparser', ['libmime']],
    ],
  );
});

test('a dependency change selects tests that load the affected package at runtime', async () => {
  const root = await tree({
    'src/server/email/seed.ts':
      "import { simpleParser } from 'mailparser';\nexport const seed = simpleParser;\n",
    'src/server/routes.ts':
      "import type { APIRoute } from 'astro';\nexport const route = 1;\n",
    'astro.config.mjs':
      "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
    'test/seed.test.ts':
      "import { seed } from '../src/server/email/seed.ts';\n",
    'test/routes.test.ts': "import { route } from '../src/server/routes.ts';\n",
    'test/config.test.mjs':
      "const config = new URL('../astro.config.mjs', import.meta.url);\n",
    'test/build.test.mjs': "import { build } from 'astro';\n",
  });
  try {
    const selected = await selectTests({
      root,
      changedFiles: ['package-lock.json'],
      candidates: [
        'test/build.test.mjs',
        'test/config.test.mjs',
        'test/routes.test.ts',
        'test/seed.test.ts',
      ],
      dependencies: new Map([
        ['mailparser', new Set(['libmime'])],
        ['astro', new Set(['undici'])],
      ]),
    });
    // routes.test.ts only imports astro's types, and config.test.mjs only reads
    // astro.config.mjs as text, so neither loads the changed package.
    assert.deepEqual(
      [...selected],
      [
        ['test/build.test.mjs', 'uses astro, affected by changed undici'],
        ['test/seed.test.ts', 'uses mailparser, affected by changed libmime'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file a test only reads selects the test when it changes, not when its imports do', async () => {
  const root = await tree({
    'src/data.ts': 'export const data = 1;\n',
    'scripts/reader.mjs':
      "import { data } from '../src/data.ts';\nexport default data;\n",
    'test/reads.test.mjs':
      "const file = new URL('../scripts/reader.mjs', import.meta.url);\n",
  });
  try {
    const select = (changedFiles) =>
      selectTests({ root, changedFiles, candidates: ['test/reads.test.mjs'] });
    assert.deepEqual([...(await select(['src/data.ts']))], []);
    assert.deepEqual(
      [...(await select(['scripts/reader.mjs']))],
      [['test/reads.test.mjs', 'imports scripts/reader.mjs']],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Tests that scan the repository through fs name what they read in string
// literals. Seen on PR #122: an added component and an added content file
// failed closed-registry tests in CI that the import graph never selected.
const scanningTree = {
  'src/components/button.astro': '<button />\n',
  'src/content/legit.md': '# Legit\n',
  'src/pages/index.astro': '<main />\n',
  'src/server/config.ts': 'export const config = {};\n',
  'public/images/providers/a.svg': '<svg />\n',
  'docs/brand/tokens.md': '# Tokens\n',
  'test/components.test.mjs':
    "const names = await readdir(new URL('../src/components/', import.meta.url));\n",
  'test/helpers/content.mjs':
    "export const list = () => readdir(join(root, 'src/content'));\n",
  'test/content.test.ts': "import { list } from './helpers/content.mjs';\n",
  'test/pages.test.mjs':
    'const pages = await readdir(`${root}/src/pages`, { recursive: true });\n',
  'test/logos.test.mjs':
    "const logos = import.meta.glob('/public/images/providers/*.svg');\n",
  'test/checklist.test.ts':
    "const checklist = await readFile(source('docs/brand/tokens.md'));\n",
  'test/routes.test.mjs': [
    "await page.goto('/src/components');",
    "assert.equal(url, 'https://example.com/src/content');",
    "assert.ok(found, 'src/pages and src/content');",
    "const missing = 'src/content/missing.json';",
    '',
  ].join('\n'),
};
const scanningCandidates = Object.keys(scanningTree).filter((file) =>
  /^test\/[^/]+\.test\.(?:mjs|ts)$/u.test(file),
);

test('a test names the repository paths it reads, as directories or files', async () => {
  const root = await tree(scanningTree);
  try {
    const reads = async (file) => [
      ...(await repositoryReads(root, file, scanningTree[file])),
    ];
    assert.deepEqual(await reads('test/components.test.mjs'), [
      ['src/components', true],
    ]);
    assert.deepEqual(await reads('test/helpers/content.mjs'), [
      ['src/content', true],
    ]);
    assert.deepEqual(await reads('test/pages.test.mjs'), [['src/pages', true]]);
    assert.deepEqual(await reads('test/logos.test.mjs'), [
      ['public/images/providers', true],
    ]);
    assert.deepEqual(await reads('test/checklist.test.ts'), [
      ['docs/brand/tokens.md', false],
    ]);
    // A route that is also a folder name still names a repository path, but a
    // URL, a sentence and a path that does not exist name nothing.
    assert.deepEqual(await reads('test/routes.test.mjs'), [
      ['src/components', true],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an added component or content file selects the tests that scan its directory', async () => {
  const root = await tree(scanningTree);
  try {
    // The browser suites a browser-facing change adds are covered above.
    const select = async (changedFiles) =>
      [
        ...(await selectTests({
          root,
          changedFiles,
          candidates: scanningCandidates.filter(
            (file) => file !== 'test/routes.test.mjs',
          ),
        })),
      ].filter(([file]) => !browserSuites.includes(file));
    assert.deepEqual(await select(['src/components/hero-banner.astro']), [
      [
        'test/components.test.mjs',
        'reads src/components/ (src/components/hero-banner.astro)',
      ],
    ]);
    // Through a helper the test imports.
    assert.deepEqual(await select(['src/content/landing-hero.json']), [
      [
        'test/content.test.ts',
        'reads src/content/ (src/content/landing-hero.json)',
      ],
    ]);
    assert.deepEqual(await select(['src/pages/giveaway/rules.astro']), [
      [
        'test/pages.test.mjs',
        'reads src/pages/ (src/pages/giveaway/rules.astro)',
      ],
    ]);
    assert.deepEqual(await select(['public/images/providers/b.svg']), [
      [
        'test/logos.test.mjs',
        'reads public/images/providers/ (public/images/providers/b.svg)',
      ],
    ]);
    assert.deepEqual(await select(['docs/brand/tokens.md']), [
      ['test/checklist.test.ts', 'reads docs/brand/tokens.md'],
    ]);
    // A named file covers only itself, and a change elsewhere selects none.
    assert.deepEqual(await select(['docs/brand/page-design.md']), []);
    assert.deepEqual(await select(['src/server/config.ts']), []);
    // A directory's name is not a file beneath it.
    assert.deepEqual(await select(['src/components-old/a.astro']), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only test code is read for repository paths, not the modules it imports', async () => {
  const root = await tree({
    'src/content/legit.md': '# Legit\n',
    'scripts/ci/roots.mjs': "export const roots = ['src/content'];\n",
    'test/roots.test.mjs': "import { roots } from '../scripts/ci/roots.mjs';\n",
  });
  try {
    assert.deepEqual(
      [
        ...(await selectTests({
          root,
          changedFiles: ['src/content/new.json'],
          candidates: ['test/roots.test.mjs'],
        })),
      ].filter(([file]) => !browserSuites.includes(file)),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The local gate from E11.6-11a: by default only the named files and the
// branch's added or changed test files run. The wider rules above are the
// `--wide` selection, which is not part of any gate.

const commit = (root, message) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@valstara.invalid',
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    { cwd: root },
  );

// A repository whose `main` holds `base`, checked out on a feature branch with
// `committed` committed on it and `uncommitted` written to the working tree.
async function branchRepository(base, { committed = {}, uncommitted = {} }) {
  const root = await tree(base);
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '.');
  commit(root, 'base');
  git('switch', '--quiet', '-c', 'feature');
  const write = async (files) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, dirname(path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  };
  if (Object.keys(committed).length > 0) {
    await write(committed);
    git('add', '.');
    commit(root, 'feature');
  }
  await write(uncommitted);
  return root;
}

test('by default only named files and test files the branch changed are selected', () => {
  const selected = selectBranchTests({
    changedFiles: [
      'package-lock.json',
      'scripts/ci/tool.mjs',
      'src/copy/landing.ts',
      'src/server/referral/status.ts',
      'test/unrelated.test.mjs',
    ],
    candidates,
    named: ['test/cycle-a.test.mjs'],
  });
  // No import reach (referral, lazy, landing), no file read through new URL
  // (tool), no dependency reach and no browser suites.
  assert.deepEqual(
    [...selected],
    [
      ['test/cycle-a.test.mjs', 'named'],
      ['test/unrelated.test.mjs', 'changed'],
    ],
  );
  // A file both named and changed is reported once, as named.
  assert.deepEqual(
    [
      ...selectBranchTests({
        changedFiles: ['test/unrelated.test.mjs'],
        candidates,
        named: ['test/unrelated.test.mjs'],
      }),
    ],
    [['test/unrelated.test.mjs', 'named']],
  );
  // A changed file that npm test does not run is not a test to select.
  assert.deepEqual(
    [
      ...selectBranchTests({
        changedFiles: ['test/helpers/new-helper.mjs', 'docs/README.md'],
        candidates,
      }),
    ],
    [],
  );
});

const registryTree = {
  'src/server/flags/registry.ts': "export const registry = ['signup'];\n",
  'src/pages/index.astro': '<main />\n',
  'test/flags.test.ts':
    "import { registry } from '../src/server/flags/registry.ts';\n",
  'test/landing.test.ts':
    "import { registry } from '../src/server/flags/registry.ts';\n",
  'test/reads.test.mjs': "const pages = readdir('src/pages');\n",
};
const registryCandidates = Object.keys(registryTree).filter((file) =>
  file.startsWith('test/'),
);

test('a branch that changes only the flag registry and names one test runs that one test', async () => {
  const root = await branchRepository(registryTree, {
    committed: {
      'src/server/flags/registry.ts':
        "export const registry = ['signup', 'prices'];\n",
    },
  });
  try {
    const narrow = await chooseTests({
      root,
      base: 'main',
      wide: false,
      named: ['test/flags.test.ts'],
      candidates: registryCandidates,
    });
    assert.deepEqual(narrow.changedFiles, ['src/server/flags/registry.ts']);
    assert.deepEqual([...narrow.selected], [['test/flags.test.ts', 'named']]);

    // --wide still sees every test the registry reaches.
    const wide = await chooseTests({
      root,
      base: 'main',
      wide: true,
      named: ['test/flags.test.ts'],
      candidates: registryCandidates,
    });
    assert.deepEqual(
      [...wide.selected],
      [
        ['test/flags.test.ts', 'named'],
        ['test/landing.test.ts', 'imports src/server/flags/registry.ts'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('committed, uncommitted and untracked test files on the branch are selected without being named', async () => {
  const root = await branchRepository(registryTree, {
    committed: { 'test/flags.test.ts': "import './landing.test.ts';\n" },
    uncommitted: {
      'test/landing.test.ts': "import assert from 'node:assert/strict';\n",
      'test/added.test.mjs': "import assert from 'node:assert/strict';\n",
      'src/pages/new.astro': '<main />\n',
    },
  });
  try {
    const { selected } = await chooseTests({
      root,
      base: 'main',
      wide: false,
      named: [],
      candidates: [...registryCandidates, 'test/added.test.mjs'],
    });
    // A browser-facing change adds no browser suite locally; CI runs them.
    assert.deepEqual(
      [...selected],
      [
        ['test/added.test.mjs', 'changed'],
        ['test/flags.test.ts', 'changed'],
        ['test/landing.test.ts', 'changed'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a named file npm test does not run is refused in both modes', async () => {
  const root = await branchRepository(registryTree, {});
  try {
    for (const wide of [false, true]) {
      await assert.rejects(
        chooseTests({
          root,
          base: 'main',
          wide,
          named: ['test/missing.test.mjs'],
          candidates: registryCandidates,
        }),
        /Not a test file npm test runs: test\/missing\.test\.mjs/u,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--wide reproduces the selection on every existing selection fixture, file for file and reason for reason', async () => {
  // Each case is a fixture above, now reached through a real branch, with
  // the selection its own test asserts.
  const cases = [
    {
      base: files,
      committed: {
        'src/server/referral/status.ts': "export const status = 'changed';\n",
      },
      candidates,
      expected: [
        ['test/lazy.test.mjs', 'imports src/server/referral/status.ts'],
        ['test/referral.test.mjs', 'imports src/server/referral/status.ts'],
      ],
    },
    {
      base: files,
      committed: {
        'scripts/ci/tool.mjs': 'export const tool = 2;\n',
        'test/unrelated.test.mjs': "import assert from 'node:assert';\n",
      },
      named: ['test/cycle-a.test.mjs'],
      candidates,
      expected: [
        ['test/cycle-a.test.mjs', 'named'],
        ['test/tool.test.mjs', 'imports scripts/ci/tool.mjs'],
        ['test/unrelated.test.mjs', 'changed'],
      ],
    },
    {
      base: files,
      committed: {
        'src/copy/landing.ts': "export const landing = 'Join now';\n",
      },
      candidates,
      expected: [
        ...browserSuites.map((suite) => [
          suite,
          'browser-facing change: src/copy/landing.ts',
        ]),
        ['test/landing.test.ts', 'imports src/copy/landing.ts'],
      ].sort(([a], [b]) => a.localeCompare(b)),
    },
    {
      base: scanningTree,
      uncommitted: { 'src/content/landing-hero.json': '{}\n' },
      candidates: scanningCandidates.filter(
        (file) => file !== 'test/routes.test.mjs',
      ),
      expected: [
        ...browserSuites.map((suite) => [
          suite,
          'browser-facing change: src/content/landing-hero.json',
        ]),
        [
          'test/content.test.ts',
          'reads src/content/ (src/content/landing-hero.json)',
        ],
      ].sort(([a], [b]) => a.localeCompare(b)),
    },
    {
      base: scanningTree,
      committed: { 'docs/brand/tokens.md': '# Tokens, changed\n' },
      candidates: scanningCandidates,
      expected: [['test/checklist.test.ts', 'reads docs/brand/tokens.md']],
    },
    {
      // A dependency upgrade: the lockfile changes and nothing else.
      base: {
        'package-lock.json': JSON.stringify(baseLock),
        'src/server/email/seed.ts':
          "import { simpleParser } from 'mailparser';\nexport const seed = simpleParser;\n",
        'test/seed.test.ts':
          "import { seed } from '../src/server/email/seed.ts';\n",
        'test/build.test.mjs': "import { build } from 'astro';\n",
        'test/lint.test.mjs': "import assert from 'node:assert';\n",
      },
      committed: { 'package-lock.json': JSON.stringify(currentLock) },
      candidates: [
        'test/build.test.mjs',
        'test/lint.test.mjs',
        'test/seed.test.ts',
      ],
      expected: [
        ['test/build.test.mjs', 'uses astro, affected by changed undici'],
        ['test/seed.test.ts', 'uses mailparser, affected by changed libmime'],
      ],
      // The default gate runs nothing for a dependency upgrade alone.
      narrow: [],
    },
  ];
  for (const { base, committed, uncommitted, named = [], ...rest } of cases) {
    const root = await branchRepository(base, { committed, uncommitted });
    try {
      const wide = await chooseTests({
        root,
        base: 'main',
        wide: true,
        named,
        candidates: rest.candidates,
      });
      assert.deepEqual([...wide.selected], rest.expected);
      // The same selection selectTests() makes for the same change.
      if (!wide.changedFiles.includes('package-lock.json')) {
        assert.deepEqual(
          [...wide.selected],
          [
            ...(await selectTests({
              root,
              changedFiles: wide.changedFiles,
              candidates: rest.candidates,
              named,
            })),
          ],
        );
      }
      const narrow = await chooseTests({
        root,
        base: 'main',
        wide: false,
        named,
        candidates: rest.candidates,
      });
      assert.deepEqual(
        [...narrow.selected],
        rest.narrow ??
          rest.expected.filter(
            ([, reason]) => reason === 'named' || reason === 'changed',
          ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('the command line takes --wide, --dry-run and --base beside the named files', () => {
  assert.deepEqual(parseArguments(['test/a.test.mjs', 'test/b.test.ts']), {
    base: undefined,
    dryRun: false,
    wide: false,
    named: ['test/a.test.mjs', 'test/b.test.ts'],
  });
  assert.deepEqual(
    parseArguments([
      '--wide',
      '--dry-run',
      '--base',
      'origin/main',
      'test/a.test.mjs',
    ]),
    {
      base: 'origin/main',
      dryRun: true,
      wide: true,
      named: ['test/a.test.mjs'],
    },
  );
});

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

// The real command, in this repository, against HEAD: --dry-run prints the
// selection and a reason for each file, and runs nothing.
async function dryRun(...extra) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      'scripts/ci/changed-tests.mjs',
      '--dry-run',
      '--base',
      'HEAD',
      ...extra,
      'test/ci-pipeline.test.mjs',
    ],
    { cwd: projectRoot, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  const listed = [...stdout.matchAll(/^ {2}(\S+) {2}\((.+)\)$/gmu)].map(
    ([, file, reason]) => [file, reason],
  );
  return { stdout, listed };
}

test('--dry-run prints the default selection with a reason for each file and runs nothing', async () => {
  const { stdout, listed } = await dryRun();
  const changed = new Set(changedFilesSince(projectRoot, 'HEAD'));

  assert.match(
    stdout,
    /files changed since HEAD\. Selection: the named files/u,
  );
  assert.ok(
    listed.some(
      ([file, reason]) =>
        file === 'test/ci-pipeline.test.mjs' && reason === 'named',
    ),
    stdout,
  );
  for (const [file, reason] of listed) {
    assert.ok(
      reason === 'named' || (reason === 'changed' && changed.has(file)),
      `${file} (${reason})`,
    );
  }
  // The node test runner's summary appears only when tests run.
  assert.doesNotMatch(stdout, /ℹ tests \d+/u);
});

test('--dry-run works with --wide and prints the wide selection', async () => {
  const { stdout, listed } = await dryRun('--wide');

  assert.match(stdout, /Wide selection \(--wide\)/u);
  assert.ok(
    listed.some(
      ([file, reason]) =>
        file === 'test/ci-pipeline.test.mjs' && reason === 'named',
    ),
    stdout,
  );
  assert.doesNotMatch(stdout, /ℹ tests \d+/u);
});
