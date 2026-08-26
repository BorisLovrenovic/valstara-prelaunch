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
const isChildRun = process.env.CI_RED_PATH_CHILD === '1';

function run(cwd, command, args, extraEnvironment = {}) {
  const environment = { ...process.env, ...extraEnvironment };
  delete environment.NODE_TEST_CONTEXT;

  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
  });
}

async function createFixtureRepository(name, fixture) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `valstara-${name}-`));
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
    ['config', 'user.name', 'Valstara CI fixture'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'fixture baseline'],
    ['switch', '--quiet', '-c', `fixture/E1-04-${name}`],
  ]) {
    const result = run(repository, 'git', args);
    assert.equal(result.status, 0, result.stderr);
  }

  const fixturePath = join(repository, fixture.path);
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, fixture.content);

  for (const args of [
    ['add', fixture.path],
    ['commit', '--quiet', '-m', `red path for ${name}`],
  ]) {
    const result = run(repository, 'git', args);
    assert.equal(result.status, 0, result.stderr);
  }

  return { repository, temporaryRoot };
}

test(
  'each E1-04 gate rejects its committed red-path fixture branch',
  { skip: isChildRun, timeout: 120_000 },
  async () => {
    const fixtures = JSON.parse(
      await readFile(
        new URL('./fixtures/ci/red-paths.json', import.meta.url),
        'utf8',
      ),
    );
    const commands = {
      lint: ['npm', ['run', 'lint']],
      typecheck: ['npm', ['run', 'typecheck']],
      test: ['npm', ['test', '--', 'test/ci-test-fixture.test.mjs']],
      build: ['npm', ['run', 'build']],
      coverage: [
        'npm',
        [
          'run',
          'coverage',
          '--',
          '--base',
          'HEAD^',
          '--test',
          'test/scaffold.test.mjs',
        ],
      ],
    };
    const expectedDiagnostics = {
      lint: /no-explicit-any/,
      typecheck: /Type 'number' is not assignable to type 'string'/,
      test: /expected test-gate failure/,
      build: /ci-build-fixture\.astro|Expected identifier/,
      coverage: /no coverage entries: src\/pages\/ci-coverage-fixture\.astro/,
    };

    for (const [name, fixture] of Object.entries(fixtures)) {
      const { repository, temporaryRoot } = await createFixtureRepository(
        name,
        fixture,
      );

      try {
        const [command, args] = commands[name];
        const result = run(repository, command, args, {
          CI_RED_PATH_CHILD: '1',
        });

        assert.notEqual(
          result.status,
          0,
          `${name} fixture unexpectedly passed:\n${result.stdout}\n${result.stderr}`,
        );
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          expectedDiagnostics[name],
          `${name} fixture failed for the wrong reason`,
        );
      } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
      }
    }
  },
);
