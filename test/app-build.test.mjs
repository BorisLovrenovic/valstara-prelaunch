import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildEnvironment, ensureAppBuild } from '../scripts/ci/app-build.mjs';

// A stand-in project whose build copies src/page.txt into dist/ and counts
// how many times it ran, so each reuse or rebuild is observable.
async function fixtureProject() {
  const root = await mkdtemp(join(tmpdir(), 'valstara-app-build-'));
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'build.mjs'),
    [
      "import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
      "if (readFileSync('src/page.txt', 'utf8').includes('broken')) process.exit(3);",
      "rmSync('dist', { recursive: true, force: true });",
      "mkdirSync('dist');",
      "writeFileSync('dist/page.txt', readFileSync('src/page.txt'));",
      "appendFileSync('builds.log', 'build\\n');",
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'package.json'),
    '{"type":"module","scripts":{"build":"node build.mjs"}}\n',
  );
  await writeFile(join(root, '.gitignore'), 'dist/\nbuilds.log\n');
  await writeFile(join(root, 'src/page.txt'), 'first\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

async function buildCount(root) {
  return (await readFile(join(root, 'builds.log'), 'utf8')).trim().split('\n')
    .length;
}

test('only NODE_ENV, COVERAGE_SOURCE_MAPS and PUBLIC_ variables key the build', () => {
  assert.deepEqual(
    buildEnvironment({
      PUBLIC_SITE: 'https://valstara.com',
      EMAIL_TOKEN_SECRET: 'secret',
      NODE_ENV: 'test',
      COVERAGE_SOURCE_MAPS: '1',
      DATABASE_URL: 'postgresql://example',
    }),
    [
      ['COVERAGE_SOURCE_MAPS', '1'],
      ['NODE_ENV', 'test'],
      ['PUBLIC_SITE', 'https://valstara.com'],
    ],
  );
});

test('a build is reused only while its inputs, environment and output are unchanged', async () => {
  const root = await fixtureProject();
  const environment = { ...process.env, NODE_ENV: 'production' };
  delete environment.COVERAGE_SOURCE_MAPS;
  const ensure = (env = environment) => ensureAppBuild({ root, env });
  try {
    assert.deepEqual(await ensure(), { built: true });
    assert.deepEqual(await ensure(), { built: false });
    assert.deepEqual(
      await ensure({ ...environment, EMAIL_TOKEN_SECRET: 'rotated' }),
      { built: false },
    );
    assert.equal(await buildCount(root), 1);

    await writeFile(join(root, 'src/page.txt'), 'second\n');
    assert.deepEqual(await ensure(), { built: true });
    assert.equal(
      await readFile(join(root, 'dist/page.txt'), 'utf8'),
      'second\n',
    );

    await writeFile(join(root, 'src/new.txt'), 'untracked input\n');
    assert.deepEqual(await ensure(), { built: true });

    await writeFile(join(root, 'dist/page.txt'), 'changed by a test\n');
    assert.deepEqual(await ensure(), { built: true });
    assert.equal(
      await readFile(join(root, 'dist/page.txt'), 'utf8'),
      'second\n',
    );

    assert.deepEqual(await ensure({ ...environment, NODE_ENV: 'test' }), {
      built: true,
    });
    assert.deepEqual(await ensure(), { built: true });
    assert.deepEqual(await ensure({ ...environment, PUBLIC_FLAG: 'on' }), {
      built: true,
    });
    assert.deepEqual(
      await ensure({ ...environment, COVERAGE_SOURCE_MAPS: '1' }),
      { built: true },
    );

    await writeFile(join(root, '.env.local'), 'PUBLIC_FLAG=on\n');
    assert.deepEqual(await ensure(), { built: true });
    assert.deepEqual(await ensure(), { built: false });
    assert.equal(await buildCount(root), 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed build throws with its exit code and never stamps the output', async () => {
  const root = await fixtureProject();
  try {
    await ensureAppBuild({ root });
    await writeFile(join(root, 'src/page.txt'), 'broken\n');
    await assert.rejects(
      ensureAppBuild({ root }),
      /npm run build failed \(exit 3\)/u,
    );
    await assert.rejects(
      ensureAppBuild({ root }),
      /npm run build failed \(exit 3\)/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
