import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  formatLcov,
  mergeLcovRecords,
  parseLcovRecords,
  summarise,
  verifyShards,
} from '../scripts/ci/merge-coverage.mjs';
import {
  discoverTestFiles,
  parseShard,
  planShards,
} from '../scripts/ci/shard-plan.mjs';
import testTimingReporter from '../scripts/ci/timing-reporter.mjs';

const execFileAsync = promisify(execFile);

test('the shard plan places every file exactly once and balances recorded time', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(
    (name) => `test/${name}.test.mjs`,
  );
  const timings = {
    'test/a.test.mjs': 120,
    'test/b.test.mjs': 100,
    'test/c.test.mjs': 60,
    'test/d.test.mjs': 50,
    'test/e.test.mjs': 40,
    'test/f.test.mjs': 30,
  };
  const plan = planShards(files, timings, 3);

  assert.deepEqual(plan.flatMap((shard) => shard.files).sort(), files);
  assert.deepEqual(
    plan.map((shard) => shard.files),
    [
      ['test/a.test.mjs', 'test/f.test.mjs'],
      ['test/b.test.mjs', 'test/d.test.mjs'],
      ['test/c.test.mjs', 'test/e.test.mjs', 'test/g.test.mjs'],
    ],
  );
  // test/g has no timing, so it weighs the median of the recorded ones (55s).
  assert.deepEqual(
    plan.map((shard) => shard.seconds),
    [150, 150, 155],
  );
  assert.deepEqual(planShards(files, timings, 3), plan);
});

test('the shard plan never leaves a file out, even with more shards than files', () => {
  const plan = planShards(['test/only.test.mjs'], {}, 4);

  assert.deepEqual(plan[0].files, ['test/only.test.mjs']);
  assert.deepEqual(
    plan.slice(1).map((shard) => shard.files),
    [[], [], []],
  );
});

test('a shard argument must name an index inside its total', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, total: 4 });
  for (const value of ['0/4', '5/4', '1/0', '2', 'two/four', undefined]) {
    assert.throws(
      () => parseShard(value),
      /--shard must look like 2\/4/u,
      String(value),
    );
  }
});

test('discovery lists the files Node would run without running any test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-discovery-'));
  try {
    await mkdir(join(root, 'test/helpers'), { recursive: true });
    const marker = join(root, 'ran.txt');
    const body = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`;
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(root, 'test/alpha.test.mjs'), body);
    await writeFile(join(root, 'test/helpers/beta.mjs'), body);
    await writeFile(join(root, 'scripts.mjs'), body);
    await writeFile(join(root, 'notes.test.txt'), 'not code');

    assert.deepEqual(await discoverTestFiles(root), [
      'test/alpha.test.mjs',
      'test/helpers/beta.mjs',
    ]);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const manifest = (index, files, discovered = ['a', 'b', 'c']) => ({
  index,
  total: 2,
  discovered,
  files,
});

test('shard reports must cover every discovered file exactly once', () => {
  assert.equal(verifyShards([manifest(1, ['a', 'c']), manifest(2, ['b'])]), 3);
  assert.throws(
    () => verifyShards([manifest(1, ['a']), manifest(2, ['b'])]),
    /c ran in no shard/u,
  );
  assert.throws(
    () => verifyShards([manifest(1, ['a', 'b']), manifest(2, ['b', 'c'])]),
    /b ran in shards 1, 2/u,
  );
  assert.throws(
    () => verifyShards([manifest(1, ['a', 'b', 'c', 'd']), manifest(2, [])]),
    /d ran but was not discovered/u,
  );
  assert.throws(
    () => verifyShards([manifest(1, ['a', 'b', 'c'])]),
    /Expected shard reports 1 to 2 once each; got 1/u,
  );
  assert.throws(
    () =>
      verifyShards([
        manifest(1, ['a', 'b']),
        manifest(2, ['c'], ['a', 'b', 'c', 'd']),
      ]),
    /discovered different test files/u,
  );
  assert.throws(() => verifyShards([]), /No shard reports/u);
});

test('merged coverage sums line hits across shards and keeps only line data', () => {
  const first = parseLcovRecords(
    [
      'TN:',
      'SF:/runner/repo/src/a.ts',
      'FN:1,load',
      'FNDA:2,load',
      'DA:1,2',
      'DA:2,0',
      'DA:5,0',
      'BRDA:2,0,0,1',
      'end_of_record',
      'SF:/runner/repo/src/only-first.ts',
      'DA:1,0',
      'end_of_record',
      'SF:/runner/repo/.astro/fixture/entry.mjs',
      'DA:1,1',
      'DA:2,0',
      'end_of_record',
    ].join('\n'),
    '/runner/repo',
  );
  const second = parseLcovRecords(
    [
      'SF:/other/checkout/src/a.ts',
      'DA:1,0',
      'DA:2,0',
      'DA:5,3',
      'end_of_record',
    ].join('\n'),
    '/other/checkout',
  );
  const merged = mergeLcovRecords([first, second]);

  assert.deepEqual(
    [...merged.keys()],
    ['src/a.ts', 'src/only-first.ts', '.astro/fixture/entry.mjs'],
  );
  assert.deepEqual(
    [...merged.get('src/a.ts')],
    [
      [1, 2],
      [2, 0],
      [5, 3],
    ],
  );
  assert.equal(
    summarise(merged),
    'src/ lines 50.00% (2/4) · all reported lines 50.00% (3/6)',
  );
  assert.equal(
    formatLcov(merged),
    [
      'TN:',
      'SF:.astro/fixture/entry.mjs',
      'DA:1,1',
      'DA:2,0',
      'LF:2',
      'LH:1',
      'end_of_record',
      'TN:',
      'SF:src/a.ts',
      'DA:1,2',
      'DA:2,0',
      'DA:5,3',
      'LF:3',
      'LH:2',
      'end_of_record',
      'TN:',
      'SF:src/only-first.ts',
      'DA:1,0',
      'LF:1',
      'LH:0',
      'end_of_record',
      '',
    ].join('\n'),
  );
});

test('c8 line coverage merged from shards equals one run over all the files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-merge-'));
  const c8 = join(process.cwd(), 'node_modules/.bin/c8');
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_V8_COVERAGE;
  const coverage = (name, files) =>
    execFileAsync(
      c8,
      [
        '--all',
        '--include=src/**',
        '--reporter=lcov',
        `--reports-dir=${name}`,
        `--temp-directory=${name}/tmp`,
        process.execPath,
        '--test',
        ...files,
      ],
      { cwd: root, env: environment },
    ).then(async () =>
      parseLcovRecords(
        await readFile(join(root, name, 'lcov.info'), 'utf8'),
        root,
      ),
    );
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'test'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      join(root, 'src/shared.mjs'),
      [
        'export function grade(score) {',
        "  if (score > 50) return 'pass';",
        "  return 'fail';",
        '}',
        'export const twice = (value) => value * 2;',
        'export function unused() {',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    );
    await writeFile(join(root, 'src/unloaded.mjs'), 'export const idle = 1;\n');
    await writeFile(
      join(root, 'test/pass.test.mjs'),
      "import test from 'node:test';\nimport { grade } from '../src/shared.mjs';\ntest('pass', () => grade(90));\n",
    );
    await writeFile(
      join(root, 'test/fail.test.mjs'),
      "import test from 'node:test';\nimport { grade, twice } from '../src/shared.mjs';\ntest('fail', () => twice(grade(10)));\n",
    );
    const whole = await coverage('whole', [
      'test/pass.test.mjs',
      'test/fail.test.mjs',
    ]);
    const merged = mergeLcovRecords([
      await coverage('one', ['test/pass.test.mjs']),
      await coverage('two', ['test/fail.test.mjs']),
    ]);

    assert.deepEqual(
      [...merged].map(([file, lines]) => [
        file,
        [...lines].sort(([a], [b]) => a - b),
      ]),
      [...whole].map(([file, lines]) => [
        file,
        [...lines].sort(([a], [b]) => a - b),
      ]),
    );
    // Both branches of grade() ran, in different shards; unused() never did.
    assert.ok(merged.get('src/shared.mjs').get(2) > 0);
    assert.ok(merged.get('src/shared.mjs').get(3) > 0);
    assert.equal(merged.get('src/shared.mjs').get(7), 0);
    assert.equal(merged.get('src/unloaded.mjs').get(1), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the timing reporter records each file once, from its file-level result', async () => {
  const file = join(process.cwd(), 'test/example.test.mjs');
  async function* events() {
    yield {
      type: 'test:complete',
      data: {
        nesting: 0,
        file,
        name: 'inner test',
        details: { duration_ms: 900 },
      },
    };
    yield {
      type: 'test:complete',
      data: {
        nesting: 1,
        file,
        name: 'test/example.test.mjs',
        details: { duration_ms: 5 },
      },
    };
    yield {
      type: 'test:pass',
      data: {
        nesting: 0,
        file,
        name: 'test/example.test.mjs',
        details: { duration_ms: 7 },
      },
    };
    yield {
      type: 'test:complete',
      data: {
        nesting: 0,
        file,
        name: 'test/example.test.mjs',
        details: { duration_ms: 1234 },
      },
    };
  }
  let output = '';
  for await (const chunk of testTimingReporter(events())) output += chunk;

  assert.deepEqual(JSON.parse(output), { 'test/example.test.mjs': 1.2 });
});
