import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test(
  'each E1-05 scan rejects its committed planted fixture',
  { skip: isChildRun, timeout: 120_000 },
  async () => {
    const fixtures = JSON.parse(
      await readFile(
        new URL('./fixtures/security/gates.json', import.meta.url),
        'utf8',
      ),
    );

    for (const [name, fixture] of Object.entries(fixtures)) {
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
