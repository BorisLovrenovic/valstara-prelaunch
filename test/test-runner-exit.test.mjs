import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const projectRoot = new URL('..', import.meta.url);

async function scripts() {
  return JSON.parse(
    await readFile(new URL('package.json', projectRoot), 'utf8'),
  ).scripts;
}

test('every suite entry point lets a finished test file exit', async () => {
  const {
    test: suite,
    'test:a11y': a11y,
    'test:privacy': privacy,
  } = await scripts();
  for (const script of [suite, a11y, privacy]) {
    assert.match(script, /node [^&]*--test --test-force-exit/u, script);
  }
  const runner = await readFile(
    new URL('scripts/ci/run-coverage.mjs', projectRoot),
    'utf8',
  );
  assert.match(
    runner,
    /\['--test', '--test-force-exit', '--test-concurrency=1'\]/u,
  );
});

test('a test file that leaks a running child fails fast and the next file still runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'valstara-runner-exit-'));
  const pidFile = join(directory, 'child.pid');
  const leaking = join(directory, 'leaking.test.mjs');
  const next = join(directory, 'next.test.mjs');
  await writeFile(
    leaking,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "import test from 'node:test';",
      "test('a browser fails to start after its container spawned', () => {",
      "  const child = spawn('sleep', ['600'], { stdio: ['ignore', 'pipe', 'pipe'] });",
      `  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "  throw new Error('browser did not start');",
      '});',
      '',
    ].join('\n'),
  );
  await writeFile(
    next,
    "import test from 'node:test';\ntest('the next file runs', () => {});\n",
  );
  // The exact Node arguments `npm test` uses, after its environment prefix.
  const nodeArguments = (await scripts()).test.split(' node ')[1].split(' ');
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(
      process.execPath,
      [...nodeArguments, '--test-reporter=spec', leaking, next],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: environment,
        timeout: 60_000,
      },
    );

    assert.equal(result.signal, null, 'the run hung until the timeout');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /✖ a browser fails to start/u);
    assert.match(result.stdout, /✔ the next file runs/u);
  } finally {
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (pid > 0) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
