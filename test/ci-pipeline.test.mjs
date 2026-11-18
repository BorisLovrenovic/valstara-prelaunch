import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertCoverage,
  changedCoverage,
  parseChangedLines,
  parseLcov,
  readChangedDiff,
} from '../scripts/ci/changed-coverage.mjs';

const workflowUrl = new URL('../.github/workflows/pr.yml', import.meta.url);
const configUrl = new URL('../coverage.config.json', import.meta.url);

test('the PR workflow exposes the mandatory E1-04 and E1-05 check names', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const jobNames = [...workflow.matchAll(/^ {2}([a-z-]+):$/gm)].map(
    (match) => match[1],
  );

  assert.deepEqual(jobNames, [
    'lint',
    'typecheck',
    'test',
    'build',
    'coverage',
    'red-paths',
    'security',
  ]);
  // Every job but coverage installs; coverage merges reports with Node alone.
  assert.equal((workflow.match(/- run: npm ci/g) ?? []).length, 6);
  assert.equal((workflow.match(/node-version: 22\.23\.5/g) ?? []).length, 7);
  assert.match(workflow, /npm run lint && npm run format/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run security/);
  assert.match(workflow, /npm run ci:security-red-paths/);
  assert.match(workflow, /npm run ci:red-paths/);
});

test('developer, CI, and local Compose Node versions satisfy lint plugin engines', async () => {
  const [nvmVersion, packageJson, compose] = await Promise.all([
    readFile(new URL('../.nvmrc', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(
      JSON.parse,
    ),
    readFile(
      new URL('../infra/compose/docker-compose.yml', import.meta.url),
      'utf8',
    ),
  ]);

  assert.equal(nvmVersion.trim(), '22.23.5');
  assert.equal(packageJson.engines.node, '>=22.23.5 <23');
  assert.equal(
    (compose.match(/image: node:22\.23\.5-bookworm-slim/g) ?? []).length,
    3,
  );
});

test('the integrated QA privacy and accessibility commands are runnable scripts', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(
    packageJson.scripts['test:a11y'],
    'RESEND_WEBHOOK_SECRET=whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk= BREVO_WEBHOOK_TOKEN=local-only-brevo-webhook-token-32-chars EMAIL_TOKEN_SECRET=local-only-email-token-secret-32-chars EMAIL_BASE_URL=http://localhost:4321 node --test --test-force-exit test/accessibility.test.mjs',
  );
  assert.match(
    packageJson.scripts['test:privacy'],
    /RESEND_WEBHOOK_SECRET=whsec_/u,
  );
  assert.match(
    packageJson.scripts['test:privacy'],
    /BREVO_WEBHOOK_TOKEN=local-only-/u,
  );
  assert.match(
    packageJson.scripts['test:privacy'],
    /EMAIL_TOKEN_SECRET=local-only-email-token-secret-32-chars EMAIL_BASE_URL=http:\/\/localhost:4321 node --test/u,
  );
  assert.match(packageJson.scripts['test:privacy'], /security-gates\.mjs/u);
  assert.match(
    packageJson.scripts['test:privacy'],
    /e1-11-rendered-page\.test\.mjs/u,
  );
  assert.match(
    packageJson.scripts['test:privacy'],
    /signup-form-rendered-page\.test\.mjs/u,
  );
});

test('docs-only pull requests are excluded without excluding other changes', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  // A QA gate can run the whole suite on main; its base is then main itself.
  assert.match(workflow, /\n {2}workflow_dispatch:\n/);
  assert.match(
    workflow,
    /RULES_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/,
  );

  assert.match(
    workflow,
    /pull_request:\n {4}paths-ignore:\n {6}- 'docs\/\*\*'/,
  );
  assert.doesNotMatch(workflow, /src\/\*\*/);
  assert.doesNotMatch(workflow, /infra\/\*\*/);
  assert.doesNotMatch(workflow, /scripts\/\*\*/);
});

test('the suite runs once, sharded, against disposable PostgreSQL services', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.equal((workflow.match(/image: postgres:17-alpine/g) ?? []).length, 1);
  assert.equal((workflow.match(/TEST_DATABASE_URL:/g) ?? []).length, 1);
  assert.match(
    workflow,
    /strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}shard: \[1, 2, 3, 4\]/,
  );
  assert.match(
    workflow,
    /name: test \(\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}\)/,
  );
  // Each shard runs its planned files under coverage; nothing runs the whole
  // suite a second time outside coverage.
  assert.match(
    workflow,
    /- run: npm run coverage -- --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/,
  );
  assert.doesNotMatch(workflow, /- run: npm test/);
  assert.match(workflow, /COVERAGE_SOURCE_MAPS: '1'/);
  // The shard starts the stack with the CI overlay, which reuses the runner's
  // install instead of installing again inside a memory-capped container.
  assert.equal(
    (
      workflow.match(
        /docker compose -f infra\/compose\/docker-compose\.yml -f infra\/compose\/docker-compose\.ci\.yml up -d --wait/g,
      ) ?? []
    ).length,
    1,
  );
  // The overlay serves the built app, so the shard builds first; its tests
  // reuse that build while it is fresh.
  assert.equal(
    (workflow.match(/run: node scripts\/ci\/app-build\.mjs/g) ?? []).length,
    1,
  );
  assert.equal((workflow.match(/run: npm run build/g) ?? []).length, 1);
  assert.equal((workflow.match(/\.valstara-lock-checksum/g) ?? []).length, 1);
  assert.equal(
    (workflow.match(/actions\/upload-artifact@v7/g) ?? []).length,
    2,
  );
  assert.match(workflow, /name: coverage-shard-\$\{\{ matrix\.shard \}\}/);
  assert.match(workflow, /if-no-files-found: error/);
});

test('coverage merges every shard and fails, not skips, when a shard fails', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const coverage = workflow.slice(
    workflow.indexOf('\n  coverage:\n'),
    workflow.indexOf('\n  red-paths:\n'),
  );

  assert.match(coverage, /needs: test\n {4}if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(
    coverage,
    /if: \$\{\{ needs\.test\.result != 'success' \}\}\n {8}run: \|\n[^\n]*\n {10}exit 1/,
  );
  assert.match(
    coverage,
    /COVERAGE_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/,
  );
  assert.match(coverage, /fetch-depth: 0/);
  assert.match(
    coverage,
    /uses: actions\/download-artifact@v8\n {8}with:\n {10}pattern: coverage-shard-\*/,
  );
  assert.match(
    coverage,
    /- run: node scripts\/ci\/merge-coverage\.mjs coverage-shards\n {6}- run: node scripts\/ci\/changed-coverage\.mjs/,
  );
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

test('the changed-line diff survives a large change outside the measured roots', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'changed-coverage-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'CI');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src/example.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();

  // Above the 1 MiB default child-process buffer that overflowed in CI.
  await mkdir(join(repo, 'fixtures'));
  await writeFile(
    join(repo, 'fixtures/capture.html'),
    'x'.repeat(200).concat('\n').repeat(12_000),
  );
  await writeFile(
    join(repo, 'src/example.ts'),
    'export const a = 1;\nexport const b = 2;\n',
  );
  git('add', '.');
  git('commit', '-q', '-m', 'change');

  const changed = parseChangedLines(readChangedDiff(base, ['src/'], repo));
  assert.deepEqual([...changed.keys()], ['src/example.ts']);
  assert.deepEqual([...(changed.get('src/example.ts') ?? [])], [2]);
});

test('changed-line coverage ignores deletion-only hunks but still checks added lines', () => {
  const changed = parseChangedLines(
    '+++ b/src/removed.ts\n@@ -3,2 +2,0 @@\n' +
      '+++ b/src/changed.ts\n@@ -4,1 +4,1 @@\n',
  );
  assert.equal(changed.has('src/removed.ts'), false);
  assert.deepEqual([...(changed.get('src/changed.ts') ?? [])], [4]);
  const result = changedCoverage(changed, new Map(), {
    includedRoots: ['src/'],
    includedExtensions: ['.ts', '.astro'],
  });
  assert.deepEqual(result.filesWithoutCoverage, ['src/changed.ts']);
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

test('an uncovered changed line under packages/price-index/src/ fails the gate', async () => {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const changed = parseChangedLines(
    '+++ b/packages/price-index/src/schema/example.ts\n@@ -0,0 +1,2 @@\n',
  );
  const coverage = parseLcov(
    'SF:packages/price-index/src/schema/example.ts\nDA:1,1\nDA:2,0\nend_of_record\n',
    process.cwd(),
  );
  const result = changedCoverage(changed, coverage, config);

  assert.equal(result.percentage, 50);
  assert.throws(
    () => assertCoverage(result, config.changedLinesMinimum),
    /below 80%/,
  );
});

test('coverage includes every executable source format used under src', async () => {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const runner = await readFile(
    new URL('../scripts/ci/run-coverage.mjs', import.meta.url),
    'utf8',
  );
  const c8Config = JSON.parse(
    await readFile(
      new URL('../scripts/ci/c8.config.json', import.meta.url),
      'utf8',
    ),
  );

  assert.deepEqual(config.includedExtensions, ['.ts', '.astro']);
  assert.match(runner, /--config=scripts\/ci\/c8\.config\.json/);
  assert.ok(c8Config.include.includes('src/**/*.{ts,astro}'));
  assert.ok(c8Config.extension.includes('.astro'));
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
