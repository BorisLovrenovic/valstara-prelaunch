import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverTestFiles,
  parseShard,
  planShards,
  readTimings,
} from './shard-plan.mjs';

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
const shardArgument = argumentValue('--shard');
const testArguments = ['--test', '--test-concurrency=1'];
const reporterArguments = ['--reporter=text', '--reporter=lcov'];
if (selectedTest) {
  testArguments.push(selectedTest);
}

// A CI shard runs its planned files only and records what it ran and how long
// each file took. The changed-line gate runs once, on the merged report.
if (shardArgument) {
  if (selectedTest) {
    throw new Error('--shard and --test cannot be combined.');
  }
  const { index, total } = parseShard(shardArgument);
  const discovered = await discoverTestFiles(projectRoot);
  const shard = planShards(discovered, await readTimings(projectRoot), total)[
    index - 1
  ];
  await mkdir(resolve(projectRoot, 'coverage'), { recursive: true });
  await writeFile(
    resolve(projectRoot, 'coverage/shard.json'),
    `${JSON.stringify(
      {
        index,
        total,
        root: projectRoot,
        discovered,
        files: shard.files,
        plannedSeconds: Math.round(shard.seconds),
      },
      null,
      2,
    )}\n`,
  );
  // With no file arguments, node --test would discover and run every file.
  if (shard.files.length === 0) {
    await writeFile(resolve(projectRoot, 'coverage/lcov.info'), '');
    await writeFile(resolve(projectRoot, 'coverage/test-timings.json'), '{}\n');
    console.log(`Shard ${index}/${total} has no test files.`);
    process.exit(0);
  }
  reporterArguments.splice(0, 1, '--reporter=text-summary');
  testArguments.push(
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=./scripts/ci/timing-reporter.mjs',
    '--test-reporter-destination=coverage/test-timings.json',
    ...shard.files,
  );
}

run(
  'npx',
  [
    'c8',
    '--config=scripts/ci/c8.config.json',
    ...reporterArguments,
    '--reports-dir=coverage',
    'node',
    '--expose-gc',
    '--import',
    'tsx',
    ...testArguments,
  ],
  { CI_RED_PATH_CHILD: '1', COVERAGE_SOURCE_MAPS: '1' },
);

if (!shardArgument) {
  const base = argumentValue('--base') ?? process.env.COVERAGE_BASE_SHA;
  run('node', [
    'scripts/ci/changed-coverage.mjs',
    ...(base ? ['--base', base] : []),
  ]);
}
