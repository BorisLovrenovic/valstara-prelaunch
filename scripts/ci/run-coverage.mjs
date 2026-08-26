import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnvironment },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

await rm(resolve(projectRoot, 'coverage'), { force: true, recursive: true });

const selectedTest = argumentValue('--test');
const testArguments = ['--test'];
if (selectedTest) {
  testArguments.push(selectedTest);
}

run(
  'npx',
  [
    'c8',
    '--all',
    '--include=src/**/*.{ts,astro}',
    '--reporter=text',
    '--reporter=lcov',
    '--reports-dir=coverage',
    'node',
    '--import',
    'tsx',
    ...testArguments,
  ],
  { CI_RED_PATH_CHILD: '1' },
);

const base = argumentValue('--base') ?? process.env.COVERAGE_BASE_SHA;
run('node', [
  'scripts/ci/changed-coverage.mjs',
  ...(base ? ['--base', base] : []),
]);
