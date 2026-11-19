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
  mergeShardReports,
  parseLcovRecords,
  refreshProcedure,
  shardPlanDrift,
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

// E11.6-11a: CI runs eight shards. The merge proves every discovered file ran
// exactly once across all eight, and warns, without failing, when the
// recorded timings the plan uses have gone stale.

const eightFiles = Array.from(
  { length: 20 },
  (_, index) => `test/f${String(index).padStart(2, '0')}.test.mjs`,
);

test('eight shards place every file exactly once and balance recorded time', () => {
  const timings = Object.fromEntries(
    eightFiles.map((file, index) => [file, 10 + index]),
  );
  const plan = planShards(eightFiles, timings, 8);

  assert.equal(plan.length, 8);
  assert.deepEqual(plan.flatMap((shard) => shard.files).sort(), eightFiles);
  assert.ok(plan.every((shard) => shard.files.length > 0));
  const seconds = plan.map((shard) => shard.seconds);
  // 390s over eight shards: the longest-first plan keeps every shard within
  // one file's time of the others.
  assert.equal(
    seconds.reduce((sum, value) => sum + value, 0),
    390,
  );
  assert.ok(Math.max(...seconds) - Math.min(...seconds) <= 29, seconds);
  assert.deepEqual(parseShard('8/8'), { index: 8, total: 8 });
  assert.throws(() => parseShard('9/8'), /--shard must look like 2\/4/u);
});

const eightManifests = (files = eightFiles) =>
  planShards(files, {}, 8).map((shard, index) => ({
    index: index + 1,
    total: 8,
    discovered: files,
    files: shard.files,
  }));

test('the merge accepts eight shard reports only when each discovered file ran exactly once', () => {
  assert.equal(verifyShards(eightManifests()), 20);

  const moved = eightManifests();
  moved[7].files = [...moved[7].files, moved[0].files[0]];
  assert.throws(
    () => verifyShards(moved),
    new RegExp(`${moved[0].files[0]} ran in shards 1, 8`, 'u'),
  );
  const dropped = eightManifests();
  const lost = dropped[3].files.pop();
  assert.throws(
    () => verifyShards(dropped),
    new RegExp(`${lost} ran in no shard`, 'u'),
  );
});

test('the merge fails when any of the eight shard reports is missing', () => {
  for (const missing of [1, 5, 8]) {
    const reports = eightManifests().filter(
      (manifest) => manifest.index !== missing,
    );
    const present = [1, 2, 3, 4, 5, 6, 7, 8].filter(
      (index) => index !== missing,
    );
    assert.throws(
      () => verifyShards(reports),
      new RegExp(
        `Expected shard reports 1 to 8 once each; got ${present.join(', ')}\\.`,
        'u',
      ),
    );
  }
  // A shard reporting twice cannot stand in for a missing one.
  const repeated = eightManifests();
  repeated[7] = { ...repeated[6] };
  assert.throws(
    () => verifyShards(repeated),
    /Expected shard reports 1 to 8 once each; got 1, 2, 3, 4, 5, 6, 7, 7\./u,
  );
});

const shardTimes = (seconds) =>
  seconds.map((value, index) => ({
    index: index + 1,
    total: seconds.length,
    seconds: value,
  }));
const recordedFor = (files) =>
  Object.fromEntries(files.map((file) => [file, 5]));

test('the drift check stays silent on a balanced plan with every file recorded', () => {
  assert.deepEqual(
    shardPlanDrift({
      discovered: eightFiles,
      recorded: recordedFor(eightFiles),
      // The slowest shard, 500s, is exactly 25% above the 400s mean.
      shards: shardTimes([500, 300, 400, 400, 400, 400, 400, 400]),
    }),
    [],
  );
  // Two of twenty unrecorded is exactly the 10% limit, not above it.
  assert.deepEqual(
    shardPlanDrift({
      discovered: eightFiles,
      recorded: recordedFor(eightFiles.slice(2)),
      shards: shardTimes([400, 400, 400, 400, 400, 400, 400, 400]),
    }),
    [],
  );
});

test('the drift check warns when too many files have no recorded time or one shard runs long', () => {
  assert.deepEqual(
    shardPlanDrift({
      discovered: eightFiles,
      recorded: recordedFor(eightFiles.slice(3)),
      shards: shardTimes([400, 400, 400, 400, 400, 400, 400, 400]),
    }),
    [
      '3 of the 20 discovered test files (15%) have no recorded time in scripts/ci/shard-timings.json; the limit is 10%',
    ],
  );
  assert.deepEqual(
    shardPlanDrift({
      discovered: eightFiles,
      recorded: recordedFor(eightFiles),
      // 1,190s against a 470s mean: what test (3/4) looked like on PR #165.
      shards: shardTimes([1190, 370, 370, 370, 370, 370, 370, 350]),
    }),
    [
      'the slowest shard, 1/8, ran 1190s, 153% above the mean shard time of 470s; the limit is 25%',
    ],
  );
});

// Plants a checked-out repository with `recorded` as its shard timings, and
// the eight shard reports CI would download, each file measured at `measured`
// seconds (by default 5).
async function plantedMerge({ recorded, measured = () => 5, drop = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'valstara-merge-drift-'));
  await mkdir(join(root, 'scripts/ci'), { recursive: true });
  if (recorded !== undefined) {
    await writeFile(
      join(root, 'scripts/ci/shard-timings.json'),
      typeof recorded === 'string' ? recorded : JSON.stringify(recorded),
    );
  }
  const directory = join(root, 'coverage-shards');
  for (const manifest of eightManifests()) {
    if (drop.includes(manifest.index)) continue;
    const shard = join(directory, `coverage-shard-${manifest.index}`);
    await mkdir(shard, { recursive: true });
    await writeFile(
      join(shard, 'shard.json'),
      JSON.stringify({ ...manifest, root: '/runner/repo', plannedSeconds: 10 }),
    );
    await writeFile(
      join(shard, 'lcov.info'),
      `SF:/runner/repo/src/shard-${manifest.index}.ts\nDA:1,1\nend_of_record\n`,
    );
    await writeFile(
      join(shard, 'test-timings.json'),
      JSON.stringify(
        Object.fromEntries(
          manifest.files.map((file) => [file, measured(manifest.index)]),
        ),
      ),
    );
  }
  const lines = [];
  return {
    root,
    lines,
    merge: () =>
      mergeShardReports({ directory, root, log: (line) => lines.push(line) }),
  };
}

const annotations = (lines) =>
  lines.filter((line) => line.startsWith('::warning'));

test('merging eight current reports prints the shard table and no drift warning', async () => {
  const planted = await plantedMerge({ recorded: recordedFor(eightFiles) });
  try {
    const result = await planted.merge();

    assert.deepEqual(result, { fileCount: 20, warnings: [] });
    assert.deepEqual(annotations(planted.lines), []);
    assert.equal(
      planted.lines.filter((line) => /^shard \d\/8: /u.test(line)).length,
      8,
    );
    assert.match(
      await readFile(join(planted.root, 'coverage/lcov.info'), 'utf8'),
      /SF:src\/shard-8\.ts/u,
    );
  } finally {
    await rm(planted.root, { recursive: true, force: true });
  }
});

test('a planted stale plan adds a warning annotation naming the refresh procedure, and the merge still succeeds', async () => {
  // Most files unrecorded, as when the suite outgrew a months-old plan, and
  // shard 3 measured far longer than the rest.
  const planted = await plantedMerge({
    recorded: recordedFor(eightFiles.slice(0, 4)),
    measured: (index) => (index === 3 ? 60 : 5),
  });
  try {
    const result = await planted.merge();

    assert.equal(result.fileCount, 20);
    assert.equal(result.warnings.length, 2);
    const warnings = annotations(planted.lines);
    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
      assert.match(
        warning,
        /^::warning title=Shard plan drift::The shard plan is stale: /u,
      );
      assert.ok(warning.endsWith(`${refreshProcedure}.`), warning);
      assert.doesNotMatch(warning, /\n/u);
    }
    assert.match(warnings[0], /16 of the 20 discovered test files \(80%\)/u);
    assert.match(warnings[1], /the slowest shard, 3\/8/u);
  } finally {
    await rm(planted.root, { recursive: true, force: true });
  }
});

test('an unreadable shard plan is a warning, never a failed merge', async () => {
  for (const recorded of [undefined, '{ not json']) {
    const planted = await plantedMerge({ recorded });
    try {
      const result = await planted.merge();

      assert.equal(result.fileCount, 20);
      assert.equal(result.warnings.length, 1);
      assert.match(
        annotations(planted.lines)[0],
        /The shard plan is stale: the shard plan could not be checked: /u,
      );
    } finally {
      await rm(planted.root, { recursive: true, force: true });
    }
  }
});

test('a missing shard report still fails the merge, whatever the plan', async () => {
  const planted = await plantedMerge({
    recorded: recordedFor(eightFiles),
    drop: [6],
  });
  try {
    await assert.rejects(
      planted.merge(),
      /Expected shard reports 1 to 8 once each; got 1, 2, 3, 4, 5, 7, 8\./u,
    );
  } finally {
    await rm(planted.root, { recursive: true, force: true });
  }
});

test('the committed shard plan records a time for every discovered test file', async () => {
  const recorded = JSON.parse(
    await readFile(
      new URL('../scripts/ci/shard-timings.json', import.meta.url),
      'utf8',
    ),
  );
  const discovered = await discoverTestFiles();
  assert.deepEqual(
    discovered.filter((file) => !Number.isFinite(recorded[file])),
    [],
  );
});
