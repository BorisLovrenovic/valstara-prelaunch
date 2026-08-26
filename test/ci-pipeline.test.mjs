import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertCoverage,
  changedCoverage,
  parseChangedLines,
  parseLcov,
} from '../scripts/ci/changed-coverage.mjs';

const workflowUrl = new URL('../.github/workflows/pr.yml', import.meta.url);
const configUrl = new URL('../coverage.config.json', import.meta.url);

test('the PR workflow exposes the five E1-04 mandatory check names', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const jobNames = [...workflow.matchAll(/^ {2}([a-z]+):$/gm)].map(
    (match) => match[1],
  );

  assert.deepEqual(jobNames, [
    'lint',
    'typecheck',
    'test',
    'build',
    'coverage',
  ]);
  assert.equal((workflow.match(/- run: npm ci/g) ?? []).length, 5);
  assert.match(workflow, /npm run lint && npm run format/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run coverage/);
});

test('docs-only pull requests are excluded without excluding other changes', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(
    workflow,
    /pull_request:\n {4}paths-ignore:\n {6}- 'docs\/\*\*'/,
  );
  assert.doesNotMatch(workflow, /src\/\*\*/);
  assert.doesNotMatch(workflow, /infra\/\*\*/);
  assert.doesNotMatch(workflow, /scripts\/\*\*/);
});

test('test and coverage run against disposable PostgreSQL services', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.equal((workflow.match(/image: postgres:17-alpine/g) ?? []).length, 2);
  assert.equal((workflow.match(/TEST_DATABASE_URL:/g) ?? []).length, 2);
  // Both jobs start the stack with the CI overlay, which reuses the runner's
  // install instead of installing again inside a memory-capped container.
  assert.equal(
    (
      workflow.match(
        /docker compose -f infra\/compose\/docker-compose\.yml -f infra\/compose\/docker-compose\.ci\.yml up -d --wait/g,
      ) ?? []
    ).length,
    2,
  );
  // The overlay serves the built app rather than the dev server, so both jobs
  // must build first or the container has nothing to run.
  assert.equal((workflow.match(/run: npm run build/g) ?? []).length, 3);
  assert.equal((workflow.match(/\.valstara-lock-checksum/g) ?? []).length, 2);
  assert.match(
    workflow,
    /COVERAGE_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
  assert.match(workflow, /fetch-depth: 0/);
});

test('changed-line coverage passes at 80% and fails below it', () => {
  const changed = parseChangedLines('+++ b/src/example.ts\n@@ -0,0 +1,5 @@\n');
  const coverage = parseLcov(
    'SF:src/example.ts\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,0\nend_of_record\n',
    process.cwd(),
  );
  const config = {
    includedRoots: ['src/'],
    includedExtensions: ['.ts', '.astro'],
  };
  const passing = changedCoverage(changed, coverage, config);

  assert.equal(passing.percentage, 80);
  assert.doesNotThrow(() => assertCoverage(passing, 80));
  assert.throws(() => assertCoverage(passing, 81), /below 81%/);
});

test('an uncovered Astro change fails closed without LCOV entries', async () => {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const changed = parseChangedLines(
    '+++ b/src/pages/uncovered.astro\n@@ -0,0 +1,4 @@\n',
  );
  const result = changedCoverage(changed, new Map(), config);

  assert.deepEqual(result.filesWithoutCoverage, ['src/pages/uncovered.astro']);
  assert.throws(
    () => assertCoverage(result, config.changedLinesMinimum),
    /no coverage entries: src\/pages\/uncovered\.astro/,
  );
});

test('coverage includes every executable source format used under src', async () => {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const runner = await readFile(
    new URL('../scripts/ci/run-coverage.mjs', import.meta.url),
    'utf8',
  );

  assert.deepEqual(config.includedExtensions, ['.ts', '.astro']);
  assert.match(runner, /--include=src\/\*\*\/\*\.\{ts,astro\}/);
});

test('the 90% critical-module list is complete and deliberately deferred', async () => {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));

  assert.equal(config.criticalModules.minimum, 90);
  assert.equal(config.criticalModules.enforced, false);
  assert.deepEqual(config.criticalModules.paths, [
    'src/server/subscriber/',
    'src/server/verification/',
    'src/server/referral/',
    'src/server/giveaway/',
    'src/server/email/',
  ]);
});
