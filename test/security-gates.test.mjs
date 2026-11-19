import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const isChildRun = process.env.CI_SECURITY_RED_PATH_CHILD === '1';

function run(cwd, command, args, extraEnvironment = {}) {
  const environment = { ...process.env, ...extraEnvironment };
  delete environment.NODE_TEST_CONTEXT;

  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
  });
}

function fixtureContent(fixture) {
  return fixture.content ?? fixture.contentParts.join('');
}

async function createFixtureRepository(name, fixture) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), `valstara-security-${name}-`),
  );
  const repository = join(temporaryRoot, 'repository');
  const excluded = new Set([
    '.astro',
    '.design-contact-sheets',
    '.git',
    'coverage',
    'dist',
    'node_modules',
  ]);

  await cp(projectRoot, repository, {
    recursive: true,
    filter: (source) => !excluded.has(source.split('/').at(-1)),
  });
  await symlink(
    join(projectRoot, 'node_modules'),
    join(repository, 'node_modules'),
  );

  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.email', 'ci-fixture@valstara.invalid'],
    ['config', 'user.name', 'Valstara security fixture'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'fixture baseline'],
    ['switch', '--quiet', '-c', `fixture/E1-05-${name}`],
  ]) {
    const result = run(repository, 'git', args);
    assert.equal(result.status, 0, result.stderr);
  }

  const fixturePath = join(repository, fixture.path);
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, fixtureContent(fixture));

  for (const args of [
    ['add', '--force', fixture.path],
    ['commit', '--quiet', '-m', `red path for ${name}`],
  ]) {
    const result = run(repository, 'git', args);
    assert.equal(result.status, 0, result.stderr);
  }

  return { repository, temporaryRoot };
}

function runSecurityGate(repository) {
  return run(
    repository,
    'node',
    ['scripts/ci/security-gates.mjs', '--base', 'HEAD^', '--skip-audit'],
    { CI_SECURITY_RED_PATH_CHILD: '1' },
  );
}

test('security and privacy gates pass on the repository baseline', async () => {
  const result = run(projectRoot, 'node', [
    'scripts/ci/security-gates.mjs',
    '--skip-audit',
  ]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('the wired literal gate rejects planted page, island and media fixtures', async () => {
  for (const [name, path] of [
    ['page', 'src/pages/ci-literal-page.astro'],
    ['island', 'src/islands/CiLiteralIsland.astro'],
    ['media', 'src/pages/ci-literal-media.astro'],
  ]) {
    const content = await readFile(
      new URL(`fixtures/literal-values/${name}.astro`, import.meta.url),
      'utf8',
    );
    const { repository, temporaryRoot } = await createFixtureRepository(
      `literal-${name}`,
      { path, content },
    );
    try {
      const result = runSecurityGate(repository);
      assert.notEqual(result.status, 0, `${name} fixture unexpectedly passed`);
      assert.match(`${result.stdout}\n${result.stderr}`, /\[literal-values\]/u);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
});

// E11.5-11i: the motion literals, a literal in a global stylesheet, and the
// motion-property scan each fail the wired gate.
test('the wired gate rejects planted motion literals and motion properties', async () => {
  for (const [name, fixture, path, scan] of [
    [
      'transition',
      'literal-values/transition.astro',
      'src/components/ci-motion-transition.astro',
      'literal-values',
    ],
    [
      'easing',
      'literal-values/easing.astro',
      'src/components/ci-motion-easing.astro',
      'literal-values',
    ],
    [
      'keyframe',
      'literal-values/keyframe.astro',
      'src/islands/CiMotionKeyframe.astro',
      'literal-values',
    ],
    [
      'stylesheet',
      'literal-values/stylesheet.css',
      'src/styles/ci-planted.css',
      'literal-values',
    ],
    [
      'motion-keyframe',
      'motion-properties/keyframe.astro',
      'src/components/ci-motion-grow.astro',
      'motion-properties',
    ],
    [
      'motion-transition',
      'motion-properties/transition.astro',
      'src/pages/ci-motion-margin.astro',
      'motion-properties',
    ],
  ]) {
    const content = await readFile(
      new URL(`fixtures/${fixture}`, import.meta.url),
      'utf8',
    );
    const { repository, temporaryRoot } = await createFixtureRepository(
      `motion-${name}`,
      { path, content },
    );
    try {
      const result = runSecurityGate(repository);
      assert.notEqual(result.status, 0, `${name} fixture unexpectedly passed`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        new RegExp(`\\[${scan}\\] ${path.replaceAll('.', '\\.')}`, 'u'),
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
});

test('Astro remote-image caching uses only the expected policy methods', async () => {
  const astroRoot = join(projectRoot, 'node_modules/astro');
  const astroPackage = JSON.parse(
    await readFile(join(astroRoot, 'package.json'), 'utf8'),
  );
  assert.equal(astroPackage.version, '7.4.12');

  const dist = join(astroRoot, 'dist');
  const files = (await readdir(dist, { recursive: true })).filter((file) =>
    file.endsWith('.js'),
  );
  const consumers = (
    await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(join(dist, file), 'utf8'),
      })),
    )
  ).filter(({ source }) => source.includes('http-cache-semantics'));
  assert.deepEqual(
    consumers.map(({ file }) => file),
    ['assets/build/remote.js'],
  );
  const source = consumers[0].source;
  assert.match(source, /policy\.storable\(\)/u);
  assert.match(source, /policy\.timeToLive\(\)/u);
  assert.doesNotMatch(source, /satisfiesWithoutRevalidation|max-stale/u);
});

// picomatch advisory 1247710 is allowlisted on the basis that the built server
// never imports it (D-022). The walk follows every static import, re-export,
// require() and string-literal dynamic import, comments excluded, from the
// server entry, resolving each specifier against the module that names it.
// Two-argument import.meta.resolve needs the flag, so the walk runs in a child.
const unreachablePackages = ['picomatch', 'anymatch', 'tinyglobby', 'fdir'];
const unreachableFiles = ['@astrojs/internal-helpers/dist/create-filter.js'];

const serverImportWalker = `
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const reached = new Set();
const unresolved = new Set();
const queue = [pathToFileURL(process.argv[1]).href];
while (queue.length > 0) {
  const url = queue.pop();
  if (reached.has(url)) continue;
  reached.add(url);
  if (!url.startsWith('file:') || !/\\.[cm]?js$/u.test(url)) continue;
  const source = await readFile(fileURLToPath(url), 'utf8');
  for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
    if (fileName.startsWith('node:')) continue;
    try {
      queue.push(import.meta.resolve(fileName, url));
    } catch {
      unresolved.add(fileName);
    }
  }
}
process.stdout.write(JSON.stringify({ reached: [...reached], unresolved: [...unresolved] }));
`;

function walkServerImports(entryPath) {
  const result = run(projectRoot, process.execPath, [
    '--experimental-import-meta-resolve',
    '--no-warnings',
    '--input-type=module',
    '--eval',
    serverImportWalker,
    entryPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function unreachableModulesReached({ reached, unresolved }) {
  const packagePattern = new RegExp(
    `/node_modules/(?:${unreachablePackages.join('|')})/`,
    'u',
  );
  const specifierPattern = new RegExp(
    `^(?:${unreachablePackages.join('|')})(?:/|$)`,
    'u',
  );
  return [
    ...reached.filter(
      (url) =>
        packagePattern.test(url) ||
        unreachableFiles.some((file) => url.endsWith(`/node_modules/${file}`)),
    ),
    ...unresolved.filter((specifier) => specifierPattern.test(specifier)),
  ];
}

test(
  'the built server never reaches picomatch or the packages that load it',
  { timeout: 150_000 },
  async () => {
    await ensureAppBuild();
    const walk = walkServerImports(join(projectRoot, 'dist/server/entry.mjs'));

    // The walk must actually leave the entry: the server's own database
    // driver is reached through a chunk, so an empty walk cannot pass.
    assert.ok(
      walk.reached.some((url) => url.includes('/node_modules/pg/')),
      'the import walk did not reach the pg driver',
    );
    assert.deepEqual(unreachableModulesReached(walk), []);
  },
);

test('the server import guard fails when a chunk reaches picomatch', async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'valstara-security-picomatch-'),
  );
  try {
    await symlink(
      join(projectRoot, 'node_modules'),
      join(temporaryRoot, 'node_modules'),
    );
    await mkdir(join(temporaryRoot, 'chunks'));
    await writeFile(
      join(temporaryRoot, 'entry.mjs'),
      "// import 'fdir'; a comment is not an import.\nconst page = () => import('./chunks/page.mjs');\nexport { page };\n",
    );
    await writeFile(
      join(temporaryRoot, 'chunks/page.mjs'),
      "import picomatch from 'picomatch';\nexport const match = picomatch('*.md');\n",
    );

    const reached = unreachableModulesReached(
      walkServerImports(join(temporaryRoot, 'entry.mjs')),
    );
    assert.ok(reached.length > 0, 'a reached picomatch import passed');
    assert.ok(reached.every((url) => url.includes('/node_modules/picomatch/')));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

const plantedFixtures = JSON.parse(
  await readFile(
    new URL('./fixtures/security/gates.json', import.meta.url),
    'utf8',
  ),
);

// Each fixture copies the checkout and runs the gate in it, so the budget
// grows with the fixture count instead of a fixed figure a loaded runner
// can outgrow as fixtures are added.
const plantedFixtureBudgetMs = 15_000;

test(
  'each E1-05 scan rejects its committed planted fixture',
  {
    skip: isChildRun,
    timeout: Object.keys(plantedFixtures).length * plantedFixtureBudgetMs,
  },
  async () => {
    for (const [name, fixture] of Object.entries(plantedFixtures)) {
      const { repository, temporaryRoot } = await createFixtureRepository(
        name,
        fixture,
      );

      try {
        const result = runSecurityGate(repository);
        const output = `${result.stdout}\n${result.stderr}`;

        assert.notEqual(
          result.status,
          0,
          `${name} fixture unexpectedly passed`,
        );
        assert.match(output, new RegExp(fixture.diagnostic));
      } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
      }
    }
  },
);

test('a committed .env.example is content-scanned but does not fail the path rule', async () => {
  const fixture = {
    content: 'EXAMPLE_SETTING=replace-me\n',
    path: '.env.example',
  };
  const { repository, temporaryRoot } = await createFixtureRepository(
    'env-example',
    fixture,
  );

  try {
    const result = runSecurityGate(repository);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test('the third-party request rule excludes server-only API routes', async () => {
  const fixture = {
    content:
      "export const POST = () => fetch('https://example.invalid/server-only');\n",
    path: 'src/pages/api/ci-server-request-fixture.ts',
  };
  const { repository, temporaryRoot } = await createFixtureRepository(
    'api-server-request',
    fixture,
  );

  try {
    const result = runSecurityGate(repository);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test('the privacy gate rejects an incomplete Turnstile disclosure contract', async () => {
  const policy = JSON.parse(
    await readFile(
      new URL('../scripts/ci/privacy-allowlist.json', import.meta.url),
      'utf8',
    ),
  );
  const turnstile = policy.thirdPartyRequests.find(
    (entry) => entry.host === 'challenges.cloudflare.com',
  );
  delete turnstile.disclosureContract.processorServerSideSignals;
  const fixture = {
    content: `${JSON.stringify(policy, null, 2)}\n`,
    path: 'scripts/ci/privacy-allowlist.json',
  };
  const { repository, temporaryRoot } = await createFixtureRepository(
    'turnstile-disclosure',
    fixture,
  );

  try {
    const result = runSecurityGate(repository);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /\[privacy-disclosure\]/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test('the privacy gate rejects a withdrawn founder waiver', async () => {
  const path =
    'docs/architecture/adr/030-founder-legal-review-risk-acceptance.md';
  const waiver = await readFile(join(projectRoot, path), 'utf8');
  const fixture = {
    content: waiver.replace(
      '- Status: Accepted — legal review waived, not reviewed',
      '- Status: Proposed',
    ),
    path,
  };
  assert.notEqual(fixture.content, waiver);
  const { repository, temporaryRoot } = await createFixtureRepository(
    'withdrawn-founder-waiver',
    fixture,
  );

  try {
    const result = runSecurityGate(repository);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /\[privacy-disclosure\].*founder legal-review waiver record is missing or incomplete/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test('a credential in .env.example fails the content scan', async () => {
  const fixture = {
    contentParts: [
      'EXAMPLE_TOKEN=',
      'ghp_',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '\n',
    ],
    path: '.env.example',
  };
  const { repository, temporaryRoot } = await createFixtureRepository(
    'env-example-secret',
    fixture,
  );

  try {
    const result = runSecurityGate(repository);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /\[secret\]/);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
