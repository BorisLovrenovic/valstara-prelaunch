import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import {
  evasionLaunchArguments,
  sourceOnlyLaunchArguments,
} from '../../packages/price-index/src/http/playwright-driver.ts';
import { pageFileName } from '../../packages/price-index/src/http/raw-store.ts';
import { runObservationsFileSchema } from '../../packages/price-index/src/schema/index.ts';
import { publishedPort } from '../helpers/listen-port.mjs';
import { record } from '../helpers/price-index-merge.ts';
import {
  priceIndexWorkspace,
  projectRoot,
  siteReadDirectories,
  treeDigest,
  type Workspace,
} from '../helpers/price-index-run.ts';

// E11.6-07: every command exits when its work is done. Each command runs
// here as its own process and must end on its own, with its documented exit
// code and no signal, within a deadline: an open handle (a browser
// connection, a timer, a listener) would keep it alive and fail the test.
// The CLI never calls process.exit(), which would hide such a handle; the
// first test asserts that.
//
// `scrape` runs against a fake source on this machine, in real headless
// Chromium (the repository's pinned Playwright container), through
// test/helpers/price-index-cli-child.ts: main.ts's own entry with the page
// origin and the browser connection swapped. The fake source serves the
// founder's captured pages. No test reaches the real source (epic rule 2).
// The workspace's settings shorten the waits to one second.

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-price-index-cli-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const dockerHost = 'host.docker.internal';
const fixtureRoot = join(
  projectRoot,
  'packages/price-index/test/fixtures/youfundceo',
);
const mainScript = join(projectRoot, 'packages/price-index/src/cli/main.ts');
const childScript = join(projectRoot, 'test/helpers/price-index-cli-child.ts');
const tsxLoader = import.meta.resolve('tsx');
const exitDeadlineMilliseconds = 120_000;

interface FakeSource {
  server: Server;
  origin: string;
  seen: string[];
  /** Answers a path with this status instead of its page. */
  status: Map<string, number>;
  /** Holds a path's answer until released, telling the test it arrived. */
  holds: Map<string, { arrived: () => void; release: Promise<void> }>;
}

let source: FakeSource;
let browserServer: ChildProcess | undefined;
let browserEndpoint: string;
let space: Workspace;

function hold(path: string): { arrived: Promise<void>; release: () => void } {
  let arrived!: () => void;
  let release!: () => void;
  const arrival = new Promise<void>((resolve) => (arrived = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  source.holds.set(path, { arrived, release: released });
  return {
    arrived: arrival,
    release: () => {
      source.holds.delete(path);
      release();
    },
  };
}

async function answer(path: string, response: ServerResponse) {
  const status = source.status.get(path);
  if (status !== undefined) {
    response.writeHead(status, { 'content-type': 'text/html' });
    response.end('<title>Refused</title>');
    return;
  }
  if (path === '/robots.txt') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(await readFile(join(fixtureRoot, 'raw/robots.txt')));
    return;
  }
  let html: Buffer;
  try {
    html = await readFile(
      join(fixtureRoot, 'pages', pageFileName(`http://fake.invalid${path}`)),
    );
  } catch {
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<title>Not found</title>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

before(async () => {
  source = {
    seen: [],
    status: new Map(),
    holds: new Map(),
  } as unknown as FakeSource;
  source.server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.invalid');
    const path = `${url.pathname}${url.search}`;
    source.seen.push(path);
    const held = source.holds.get(path);
    if (held === undefined) {
      void answer(path, response);
    } else {
      held.arrived();
      void held.release.then(() => answer(path, response));
    }
  });
  source.server.listen(0, '0.0.0.0');
  await once(source.server, 'listening');
  source.origin = `http://${dockerHost}:${(source.server.address() as AddressInfo).port}`;

  // Chromium starts inside the container with the tool's own launch
  // arguments, as in the fetcher's browser suite.
  const launch = `
const { chromium } = require('/work/node_modules/playwright');
chromium.launchServer({ headless: true, args: JSON.parse(process.argv[1]), host: '0.0.0.0', port: 3000, wsPath: '/cli' })
  .then(() => console.log('Listening'));`;
  browserServer = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      browserContainer,
      '--add-host',
      `${dockerHost}:host-gateway`,
      '--publish',
      '127.0.0.1::3000',
      '--volume',
      `${projectRoot}:/work:ro`,
      '--workdir',
      '/work',
      playwrightImage,
      'node',
      '-e',
      launch,
      JSON.stringify([
        ...evasionLaunchArguments,
        ...sourceOnlyLaunchArguments(source.origin),
      ]),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  browserServer.stdout!.setEncoding('utf8');
  browserServer.stderr!.setEncoding('utf8');
  browserServer.stdout!.on('data', (chunk) => (output += chunk));
  browserServer.stderr!.on('data', (chunk) => (output += chunk));
  for (let attempt = 0; ; attempt += 1) {
    if (output.includes('Listening')) {
      break;
    }
    if (browserServer.exitCode !== null || attempt >= 720) {
      throw new Error(`The browser server did not start.\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browserEndpoint = `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/cli`;

  // Two services in two markets, and one-second waits.
  space = await priceIndexWorkspace({
    services: ['netflix', 'spotify'],
    markets: ['SE', 'US'],
  });
  const settingsPath = join(space.root, 'config/price-index.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.fetcher = {
    ...settings.fetcher,
    jitter_seconds: { min: 1, max: 1 },
    page_timeout_seconds: 30,
    checkpoint_wait_seconds: 2,
    backoff: {
      initial_seconds: 1,
      multiplier: 1,
      max_seconds: 1,
      retry_after_max_seconds: 3600,
    },
    max_consecutive_failures: 2,
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await space.writeLatest(
    {
      built_at: '2026-10-18T09:00:00.000Z',
      records: [
        record({
          price_local: '129.00',
          price_source_text: 'kr 129',
          observed_at: '2026-10-18T09:00:00.000Z',
        }),
      ],
    },
    '2026-10-18',
  );
});

after(async () => {
  await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
    (error) => {
      if (!String(error.stderr).includes('No such container')) throw error;
    },
  );
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
  source?.server.close();
  await space?.dispose();
});

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
}

/**
 * Runs one command as its own process in the workspace and waits for it to
 * end on its own. `child` runs it through the fake-source entry; otherwise
 * it is main.ts itself. A process still alive at the deadline fails.
 */
function run(
  args: readonly string[],
  options: {
    child?: boolean;
    started?: (process: ChildProcess) => void;
    /** Piped to standard input, which is then closed. Ignored otherwise. */
    input?: string;
  } = {},
): Promise<Exit> {
  const script = options.child ? childScript : mainScript;
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, script, ...args],
    {
      cwd: space.root,
      env: {
        ...process.env,
        ...(options.child
          ? {
              PRICE_INDEX_CHILD_ORIGIN: source.origin,
              PRICE_INDEX_CHILD_BROWSER: browserEndpoint,
            }
          : {}),
      },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    },
  );
  if (options.input !== undefined) {
    child.stdin!.end(options.input);
  }
  options.started?.(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk) => (out += chunk));
  child.stderr!.setEncoding('utf8').on('data', (chunk) => (err += chunk));
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `price-index ${args.join(' ')} did not exit within ${exitDeadlineMilliseconds} ms: something kept the process alive.\n${out}\n${err}`,
        ),
      );
    }, exitDeadlineMilliseconds);
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, out, err });
    });
  });
}

function assertExited(result: Exit, code: number) {
  assert.equal(result.signal, null, `ended by ${result.signal}\n${result.err}`);
  assert.equal(result.code, code, `${result.out}\n${result.err}`);
}

async function runIds(): Promise<string[]> {
  return (await readdir(space.rawRoot)).sort();
}

test('the CLI never ends itself with process.exit()', async () => {
  const directory = join(projectRoot, 'packages/price-index/src/cli');
  for (const name of await readdir(directory)) {
    const text = await readFile(join(directory, name), 'utf8');
    assert.doesNotMatch(text, /process\.exit\(/, name);
  }
});

test('validate exits 0', async () => {
  assertExited(await run(['validate']), 0);
});

test('a usage error exits 1', async () => {
  const result = await run(['scrape', '--everything']);
  assertExited(result, 1);
});

test('scrape against the fake source exits 0, and leaves the site data untouched', async () => {
  const before = await treeDigest(space.root, siteReadDirectories);
  const result = await run(['scrape'], { child: true });
  assertExited(result, 0);
  assert.match(
    result.out,
    /completed \(exit 0\)\. latest\.json was not touched\./,
  );
  assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);

  const [runId] = await runIds();
  const observations = runObservationsFileSchema.parse(
    JSON.parse(
      await readFile(join(space.rawRoot, runId!, 'observations.json'), 'utf8'),
    ),
  );
  assert.equal(observations.fetch_status, 'completed');
  // Read from the page as real Chromium rendered it.
  const spotify = observations.observations.find(
    (item) => item.market === 'SE' && item.service_id === 'spotify',
  );
  assert.equal(spotify?.price_local, '149.00');
  assert.ok(!source.seen.some((path) => path.startsWith('/api/')));
});

test('scrape --dry-run exits 0', async () => {
  const before = await treeDigest(space.root);
  const result = await run(['scrape', '--dry-run']);
  assertExited(result, 0);
  assert.deepEqual(await treeDigest(space.root), before);
});

test('review exits (here refusing a record that is not flagged)', async () => {
  const result = await run([
    'review',
    'approve',
    '--market',
    'SE',
    '--service',
    'spotify',
    '--plan',
    'individual',
    '--actor',
    'founder',
  ]);
  assertExited(result, 1);
  assert.match(result.err, /is ok; only needs_review and conflict/);
});

test('build-data exits 0', async () => {
  const result = await run(['build-data']);
  assertExited(result, 0);
  assert.match(result.out, /built run/);
});

test('report exits 0', async () => {
  const before = await treeDigest(space.root, siteReadDirectories);
  const result = await run(['report']);
  assertExited(result, 0);
  assert.match(result.out, /reports\/coverage-\d{4}-\d{2}-\d{2}\.md/);
  assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);
});

test('monthly-report exits 0, and 1 for a month without a build', async () => {
  const [snapshot] = await readdir(join(space.dataDirectory, 'snapshots'));
  const month = snapshot!.slice(0, 7);
  const result = await run(['monthly-report', '--month', month]);
  assertExited(result, 0);
  assert.match(result.out, new RegExp(`reports/monthly/${month}\\.md`));
  assertExited(await run(['monthly-report', '--month', '1999-01']), 1);
});

test('override reads piped standard input and exits, and exits 1 when the input is empty', async () => {
  const path = join(space.root, 'data/price-index/manual-overrides.json');
  const before = await readFile(path, 'utf8');
  const added = await run(['override', 'not-offered'], {
    input:
      'US\nnetflix\nbasic\n\nhttps://www.netflix.com/signup/planform\n2026-11-17\nFounder\n\n',
  });
  assertExited(added, 0);
  assert.match(added.out, /recorded US\/netflix\/basic\/month: not offered/);
  const retired = await run(['override', 'retire'], {
    input: 'US\nnetflix\nbasic\nmonth\n',
  });
  assertExited(retired, 0);
  assert.equal(await readFile(path, 'utf8'), before);
  const empty = await run(['override', 'add']);
  assertExited(empty, 1);
  assert.match(empty.err, /the input ended/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('a run stopped by the source exits 2, and leaves the site data byte-identical', async () => {
  const before = await treeDigest(space.root, siteReadDirectories);
  source.status.set('/countries/united-states', 429);
  try {
    const result = await run(['scrape'], { child: true });
    assertExited(result, 2);
    assert.match(result.out, /was stopped by the source \(exit 2\)/);
  } finally {
    source.status.clear();
  }
  assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);
});

test('a run killed mid-market leaves the site data byte-identical, and resumes', async () => {
  const before = await treeDigest(space.root, siteReadDirectories);
  const runsBefore = await runIds();
  const sweden = hold('/countries/sweden');
  let child!: ChildProcess;
  const killed = run(['scrape'], {
    child: true,
    started: (process) => (child = process),
  });
  await sweden.arrived;
  child.kill('SIGKILL');
  const result = await killed;
  sweden.release();
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);

  const [runId] = (await runIds()).filter((id) => !runsBefore.includes(id));
  assert.ok(runId, 'the killed run left no run directory');
  await assert.rejects(
    readFile(join(space.rawRoot, runId, 'observations.json')),
    { code: 'ENOENT' },
  );

  // The resume fetches only what the index unit did not checkpoint.
  source.seen.length = 0;
  const resumed = await run(['scrape', '--resume', runId], { child: true });
  assertExited(resumed, 0);
  assert.ok(
    !source.seen.some((path) =>
      ['/countries', '/services', '/price-moves'].includes(path),
    ),
    source.seen.join(', '),
  );
  assert.ok(source.seen.includes('/countries/sweden'));
});

test('an interrupted run exits 4, and leaves the site data byte-identical', async () => {
  const before = await treeDigest(space.root, siteReadDirectories);
  const sweden = hold('/countries/sweden');
  let child!: ChildProcess;
  const interrupted = run(['scrape'], {
    child: true,
    started: (process) => (child = process),
  });
  await sweden.arrived;
  child.kill('SIGINT');
  sweden.release();
  const result = await interrupted;
  assertExited(result, 4);
  assert.match(result.out, /was interrupted \(exit 4\)/);
  assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);
});
