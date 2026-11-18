import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium, type Browser } from 'playwright';

import {
  fetchUnits,
  openFetchSession,
  type FetchReport,
} from '../../packages/price-index/src/http/fetcher.ts';
import {
  createPlaywrightDriver,
  evasionLaunchArguments,
  sourceOnlyLaunchArguments,
} from '../../packages/price-index/src/http/playwright-driver.ts';
import { seededRandom } from '../../packages/price-index/src/http/random.ts';
import { readCheckpoint } from '../../packages/price-index/src/http/raw-store.ts';
import type { FetcherSettings } from '../../packages/price-index/src/schema/price-index-settings.ts';
import { fakeClock, fetcherSettings } from '../helpers/price-index-fetcher.ts';
import { publishedPort } from '../helpers/listen-port.mjs';

// E11.6-04 against a local fake server, in real headless Chromium (the
// repository's pinned Playwright container), with an injected clock and a
// seeded source. No test reaches the real source: the fetcher is pointed at
// the fake server's origin, and the second fake server stands for every
// other host.
//
// The fake pages do what a captured source page does (findings: 35 requests
// a page, 13 of them Next.js prefetches): a stylesheet with a font and a
// background image, a script that fires Next.js-style prefetches, a request
// under /api/, a request to a second host and an allowed same-host fetch, an
// image, a video, an iframe, a link prefetch and a favicon. The document is
// streamed slowly, so every one of those requests is issued while the page
// is still loading.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const browserContainer = `valstara-price-index-fetcher-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const dockerHost = 'host.docker.internal';
// The second host: another name for the same machine, so the browser's
// resolver treats it as a different host.
const otherHost = 'elsewhere.internal';

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
}

interface FakeServer {
  server: Server;
  origin: string;
  seen: Seen[];
  pageLevelInFlight: number;
  maxPageLevelInFlight: number;
  /** Page-level requests opening and closing, in order, for diagnosis. */
  timeline: string[];
  /** When false, the never-clearing checkpoint page serves its content. */
  checkpointStuck: boolean;
}

// Fetch-metadata headers are not sent to a plain-http origin, so a document
// is told apart by what it accepts: a navigation (page or frame) asks for
// HTML, while scripts, styles, images, fonts and fetches do not.
function isDocument(headers: IncomingMessage['headers']): boolean {
  return String(headers.accept ?? '').startsWith('text/html');
}

function isPageLevel(request: IncomingMessage, url: URL): boolean {
  return (
    isDocument(request.headers) ||
    url.searchParams.has('_rsc') ||
    request.headers.rsc !== undefined ||
    request.headers['next-router-prefetch'] !== undefined
  );
}

async function listen(
  host: string,
  handler: (
    fake: FakeServer,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) => void,
): Promise<FakeServer> {
  const fake = {
    seen: [],
    timeline: [],
    pageLevelInFlight: 0,
    maxPageLevelInFlight: 0,
    checkpointStuck: true,
  } as unknown as FakeServer;
  fake.server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.invalid');
    fake.seen.push({
      method: request.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
    });
    if (isPageLevel(request, url)) {
      const label = `${request.method} ${url.pathname}${url.search}`;
      fake.timeline.push(`open ${label}`);
      fake.pageLevelInFlight += 1;
      fake.maxPageLevelInFlight = Math.max(
        fake.maxPageLevelInFlight,
        fake.pageLevelInFlight,
      );
      let counted = true;
      const done = () => {
        if (counted) {
          counted = false;
          fake.pageLevelInFlight -= 1;
          fake.timeline.push(`close ${label}`);
        }
      };
      response.once('finish', done);
      response.once('close', done);
    }
    handler(fake, request, response, url);
  });
  fake.server.listen(0, '0.0.0.0');
  await once(fake.server, 'listening');
  const { port } = fake.server.address() as AddressInfo;
  fake.origin = `http://${host}:${port}`;
  return fake;
}

let source: FakeServer;
let elsewhere: FakeServer;
let browserServer: ChildProcess | undefined;
let browser: Browser;

const robotsText =
  'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /go/\nDisallow: /private/\n\nUser-agent: ClaudeBot\nDisallow: /\n';

function page(title: string, second: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/static/site.css">
<link rel="prefetch" href="/countries/prefetched">
<link rel="icon" href="/favicon.ico">
<script src="/static/app.js"></script>
</head><body><h1 class="hero">${title}</h1>
<img src="/static/logo.png" alt=""><img src="${second}/pixel.png" alt="">
<video src="/static/clip.mp4" preload="auto"></video>
<iframe src="/countries/framed"></iframe>
<iframe src="/countries/framed-2"></iframe>
<iframe src="${second}/framed"></iframe>
<a href="/countries/linked">linked</a>
<script src="${second}/tracker.js"></script>
<script src="/api/widget.js"></script>
<script>
// Requests that can outlive their page, fired as the fetcher reads it and
// leaves, and a worker, whose script the rule refuses, so it never runs.
document.addEventListener('DOMContentLoaded', () => {
  navigator.sendBeacon('/countries/beacon');
  const late = document.createElement('link');
  late.rel = 'prefetch';
  late.href = '/countries/late-prefetch';
  document.head.append(late);
  new Worker('/static/worker.js');
});
</script>
`;
}

const appScript = (second: string) => `
fetch('/countries/next?_rsc=1a2b3', { headers: { rsc: '1', 'next-router-prefetch': '1' } });
fetch('/services/netflix', { headers: { rsc: '1' } });
fetch('/services/spotify', { headers: { 'next-router-prefetch': '1' } });
fetch('/api/track');
fetch('${second}/beacon');
fetch('/static/data.json');
fetch('/report?webdriver=' + String(navigator.webdriver));
`;

function sendPage(
  response: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    ...headers,
  });
  // Stream the document so its subresources are requested while it loads.
  response.write(html);
  setTimeout(() => response.end('</body></html>\n'), 150);
}

// The checkpoint answers with one small, complete page (10.6 KB gzipped in
// the findings' raw/ capture); its script runs, and reloads, after that.
function sendCheckpoint(response: ServerResponse, script: string) {
  response.writeHead(429, {
    'content-type': 'text/html; charset=utf-8',
    'x-vercel-mitigated': 'challenge',
    'cache-control': 'private, no-store, max-age=0',
  });
  response.end(`${checkpointPage(script)}</body></html>\n`);
}

const checkpointPage = (script: string) =>
  `<!doctype html><html><head><title>Vercel Security Checkpoint</title></head><body><p>We're verifying your browser</p><script src="${script}"></script>`;

before(async () => {
  elsewhere = await listen(otherHost, (_fake, _request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('elsewhere');
  });
  source = await listen(dockerHost, (fake, request, response, url) => {
    const path = url.pathname;
    if (path === '/robots.txt') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        etag: '"robots-1"',
      });
      response.end(robotsText);
    } else if (path === '/static/site.css') {
      response.writeHead(200, {
        'content-type': 'text/css',
        'cache-control': 'no-cache',
        etag: '"css-1"',
      });
      response.end(
        '@font-face{font-family:Fake;src:url(/static/font.woff2)}body{font-family:Fake}.hero{background:url(/static/bg.png)}',
      );
    } else if (path === '/static/app.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'no-cache',
        etag: '"js-1"',
      });
      response.end(appScript(elsewhere.origin));
    } else if (path === '/static/worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(
        `fetch('/api/worker'); fetch('/countries/worker?_rsc=1'); fetch('${elsewhere.origin}/worker');`,
      );
    } else if (path === '/static/data.json' || path === '/report') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    } else if (path === '/.well-known/checkpoint.js') {
      // The clearing checkpoint: a same-host script that calls a same-host
      // endpoint, then reloads the page.
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(
        "fetch('/.well-known/checkpoint/verify', { method: 'POST' }).then(() => location.reload());",
      );
    } else if (
      path === '/.well-known/checkpoint/verify' &&
      request.method === 'POST'
    ) {
      response.writeHead(204, {
        'set-cookie': 'checkpoint=passed; Path=/; HttpOnly',
      });
      response.end();
    } else if (path === '/.well-known/stuck.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('// verifying…');
    } else if (path === '/checkpoint/clears') {
      if ((request.headers.cookie ?? '').includes('checkpoint=passed')) {
        sendPage(response, 200, page('Cleared page', elsewhere.origin));
      } else {
        sendCheckpoint(response, '/.well-known/checkpoint.js');
      }
    } else if (path === '/checkpoint/never') {
      if (fake.checkpointStuck) {
        sendCheckpoint(response, '/.well-known/stuck.js');
      } else {
        sendPage(response, 200, page('No longer stuck', elsewhere.origin));
      }
    } else if (path === '/hang') {
      // Never answers.
    } else if (path === '/redirect-same') {
      response.writeHead(302, { location: '/countries/redirected' });
      response.end();
    } else if (path === '/redirect-away') {
      response.writeHead(302, { location: `${elsewhere.origin}/landing` });
      response.end();
    } else if (path === '/missing') {
      sendPage(response, 404, '<title>Not found</title>');
    } else if (path.startsWith('/static/') || path === '/favicon.ico') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end('x');
    } else {
      sendPage(response, 200, page(`Page ${path}`, elsewhere.origin), {
        etag: 'W/"page-1"',
        'last-modified': 'Mon, 16 Nov 2026 00:00:00 GMT',
        'cache-control': 'public, max-age=0, must-revalidate',
      });
    }
  });

  // Chromium starts inside the container with the module's own launch
  // arguments; run-server would drop them, so launchServer is used.
  const launch = `
const { chromium } = require('/work/node_modules/playwright');
chromium.launchServer({ headless: true, args: JSON.parse(process.argv[1]), host: '0.0.0.0', port: 3000, wsPath: '/fetcher' })
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
      '--add-host',
      `${otherHost}:host-gateway`,
      '--publish',
      '127.0.0.1::3000',
      '--volume',
      `${root}:/work:ro`,
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
  const port = await publishedPort(browserContainer, 3000);
  browser = await chromium.connect(`ws://127.0.0.1:${port}/fetcher`);
});

after(async () => {
  await browser?.close();
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
  elsewhere?.server.close();
});

function testSettings(
  overrides: Partial<FetcherSettings> = {},
): FetcherSettings {
  return fetcherSettings({
    page_timeout_seconds: 15,
    checkpoint_wait_seconds: 10,
    ...overrides,
  });
}

async function run(
  units: { id: string; paths: string[] }[],
  options: {
    settings?: FetcherSettings;
    rawRoot: string;
    resumeRunId?: string;
  },
): Promise<FetchReport> {
  const settings = options.settings ?? testSettings();
  const driver = await createPlaywrightDriver({
    browser,
    origin: source.origin,
    pageTimeoutMilliseconds: settings.page_timeout_seconds * 1000,
    checkpointWaitMilliseconds: settings.checkpoint_wait_seconds * 1000,
  });
  try {
    const session = await openFetchSession({
      origin: source.origin,
      settings,
      driver,
      clock: fakeClock(),
      random: seededRandom(4),
      rawRoot: options.rawRoot,
      ...(options.resumeRunId === undefined
        ? {}
        : { resumeRunId: options.resumeRunId }),
    });
    return await fetchUnits(session, units);
  } finally {
    await driver.close();
  }
}

async function withRawRoot<T>(
  work: (rawRoot: string) => Promise<T>,
): Promise<T> {
  const rawRoot = await mkdtemp(
    join(tmpdir(), 'valstara-price-index-browser-'),
  );
  try {
    return await work(rawRoot);
  } finally {
    await rm(rawRoot, { recursive: true, force: true });
  }
}

function reset() {
  source.seen.length = 0;
  elsewhere.seen.length = 0;
  source.maxPageLevelInFlight = 0;
  source.timeline.length = 0;
  source.checkpointStuck = true;
}

const neverReached = [
  /^\/countries\/next\?_rsc=/,
  /^\/services\/(netflix|spotify)$/,
  /^\/api\//,
  /^\/static\/(logo\.png|bg\.png|font\.woff2|clip\.mp4)$/,
  /^\/favicon\.ico$/,
  /^\/countries\/(prefetched|framed|framed-2|linked|beacon|late-prefetch)$/,
  /^\/countries\/worker/,
  /^\/static\/worker\.js$/,
];

test('a queue of 50: at most one page-level request is ever in flight, over every request the browser makes, and the refused requests never reach either server', async () => {
  reset();
  await withRawRoot(async (rawRoot) => {
    const units = Array.from({ length: 10 }, (_, unit) => ({
      id: `M${unit}`,
      paths: Array.from(
        { length: 5 },
        (_, index) => `/countries/c-${unit * 5 + index}`,
      ),
    }));
    const report = await run(units, { rawRoot });
    assert.equal(report.status, 'completed', JSON.stringify(report.stop));
    assert.equal(
      report.pages.filter((page) => page.outcome === 'ok').length,
      51,
    );

    assert.equal(source.maxPageLevelInFlight, 1, source.timeline.join('\n'));
    const pageLevel = source.seen.filter(
      (request) =>
        isDocument(request.headers) ||
        request.path.includes('_rsc=') ||
        request.headers.rsc !== undefined ||
        request.headers['next-router-prefetch'] !== undefined,
    );
    assert.equal(
      pageLevel.length,
      51,
      'robots.txt and the 50 pages, nothing else',
    );

    for (const pattern of neverReached) {
      assert.deepEqual(
        source.seen
          .filter((request) => pattern.test(request.path))
          .map((r) => r.path),
        [],
        String(pattern),
      );
    }
    assert.deepEqual(elsewhere.seen, [], 'the second host is never reached');

    // What the rule allows did arrive: the same-host script, stylesheet and fetch.
    for (const path of [
      '/static/app.js',
      '/static/site.css',
      '/static/data.json',
    ]) {
      assert.ok(
        source.seen.some((request) => request.path === path),
        path,
      );
    }
    // And the refused requests were attempted, then refused in the browser.
    for (const reason of [
      'prefetch',
      'resource_type',
      'other_host',
      'disallowed_path',
      'not_the_requested_page',
    ] as const) {
      assert.ok((report.refused_browser_requests[reason] ?? 0) > 0, reason);
    }

    // The page as rendered is in the raw store.
    assert.match(
      await readFile(
        join(rawRoot, report.run_id, 'pages', 'countries__c-7.html'),
        'utf8',
      ),
      /<title>Page \/countries\/c-7<\/title>/,
    );
  });
});

test('the browser presents as an ordinary browser: no headless marker, navigator.webdriver hidden', async () => {
  reset();
  await withRawRoot(async (rawRoot) => {
    await run([{ id: 'SE', paths: ['/countries/sweden'] }], { rawRoot });
    const document = source.seen.find(
      (request) => request.path === '/countries/sweden',
    );
    assert.ok(document);
    assert.match(String(document.headers['user-agent']), /Chrome\//);
    assert.doesNotMatch(String(document.headers['user-agent']), /Headless/i);
    assert.equal(
      document.headers['accept-language']?.startsWith('en-US'),
      true,
    );
    const report = source.seen.find((request) =>
      request.path.startsWith('/report'),
    );
    assert.equal(report?.path, '/report?webdriver=undefined');
  });
});

test('the fetcher makes no conditional request, even for a page and assets loaded twice', async () => {
  reset();
  await withRawRoot(async (rawRoot) => {
    await run(
      [
        { id: 'A', paths: ['/countries/again'] },
        { id: 'B', paths: ['/countries/again'] },
      ],
      { rawRoot },
    );
    assert.equal(
      source.seen.filter((request) => request.path === '/countries/again')
        .length,
      2,
    );
    for (const request of source.seen) {
      assert.equal(request.headers['if-none-match'], undefined, request.path);
      assert.equal(
        request.headers['if-modified-since'],
        undefined,
        request.path,
      );
    }
  });
});

test('a checkpoint that clears does so through a same-host script and fetch, and the page is stored', async () => {
  reset();
  await withRawRoot(async (rawRoot) => {
    const report = await run([{ id: 'SE', paths: ['/checkpoint/clears'] }], {
      rawRoot,
    });
    assert.equal(report.status, 'completed', JSON.stringify(report.stop));
    const loaded = report.pages.at(-1)!;
    assert.equal(loaded.outcome, 'ok');
    assert.equal(loaded.status, 200);
    assert.equal(loaded.attempts, 1, 'cleared within its wait, not by a retry');
    assert.match(
      await readFile(join(rawRoot, report.run_id, loaded.file!), 'utf8'),
      /<title>Cleared page<\/title>/,
    );
    assert.deepEqual(
      source.seen
        .filter(
          (request) =>
            request.path.startsWith('/.well-known/') ||
            request.path === '/checkpoint/clears',
        )
        .map((request) => `${request.method} ${request.path}`),
      [
        'GET /checkpoint/clears',
        'GET /.well-known/checkpoint.js',
        'POST /.well-known/checkpoint/verify',
        'GET /checkpoint/clears',
      ],
    );
    assert.equal(source.maxPageLevelInFlight, 1, source.timeline.join('\n'));
  });
});

test('a checkpoint that never clears is a failure; three stop the run, leaving the checkpoint, and a resume fetches only the rest', async () => {
  reset();
  await withRawRoot(async (rawRoot) => {
    const units = [
      { id: 'A', paths: ['/countries/a'] },
      { id: 'B', paths: ['/checkpoint/never', '/countries/b'] },
      { id: 'C', paths: ['/countries/c'] },
    ];
    const stopped = await run(units, {
      rawRoot,
      settings: testSettings({ checkpoint_wait_seconds: 2 }),
    });
    assert.equal(stopped.status, 'stopped_by_source');
    assert.equal(stopped.exit_code, 2);
    assert.equal(stopped.stop?.reason, 'source_refused');
    assert.equal(stopped.stop?.url, `${source.origin}/checkpoint/never`);
    assert.match(stopped.stop?.detail ?? '', /still the bot checkpoint/);
    assert.deepEqual(stopped.completed_units, ['A']);
    assert.deepEqual(
      (await readCheckpoint(rawRoot, stopped.run_id))?.completed_units,
      ['A'],
    );
    const documents = () =>
      source.seen
        .filter((request) => isDocument(request.headers))
        .map((request) => request.path);
    assert.deepEqual(documents(), [
      '/robots.txt',
      '/countries/a',
      '/checkpoint/never',
      '/checkpoint/never',
      '/checkpoint/never',
    ]);

    // The source relents; the founder resumes the run.
    source.seen.length = 0;
    source.checkpointStuck = false;
    const resumed = await run(units, { rawRoot, resumeRunId: stopped.run_id });
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed.stop));
    assert.deepEqual(documents(), [
      '/checkpoint/never',
      '/countries/b',
      '/countries/c',
    ]);
    assert.deepEqual(resumed.skipped_units, ['A']);
    assert.deepEqual(resumed.completed_units, ['A', 'B', 'C']);
  });
});

test('every page has a timeout: a page that never answers is a failure', async () => {
  reset();
  await withRawRoot(async (rawRoot) => {
    const report = await run([{ id: 'SE', paths: ['/hang'] }], {
      rawRoot,
      settings: testSettings({
        page_timeout_seconds: 2,
        max_consecutive_failures: 1,
      }),
    });
    assert.equal(report.status, 'stopped_by_source');
    assert.match(
      report.stop?.detail ?? '',
      /^1 consecutive failures; the last was timeout/,
    );
  });
});

test('a same-host redirect is followed; a redirect to another host never reaches it and fails the page', async () => {
  reset();
  await withRawRoot(async (rawRoot) => {
    const report = await run(
      [{ id: 'SE', paths: ['/redirect-same', '/missing', '/redirect-away'] }],
      { rawRoot, settings: testSettings({ max_consecutive_failures: 2 }) },
    );
    const [same, missing] = report.pages.slice(1);
    assert.equal(same?.outcome, 'ok');
    assert.ok(
      source.seen.some((request) => request.path === '/countries/redirected'),
    );
    assert.equal(missing?.outcome, 'not_found');
    assert.equal(report.status, 'stopped_by_source');
    assert.equal(report.stop?.url, `${source.origin}/redirect-away`);
    assert.match(report.stop?.detail ?? '', /the last was error/);
    assert.deepEqual(elsewhere.seen, [], 'the other host is never requested');
  });
});

test('paths robots.txt disallows, /api/ and /go/ are never opened', async () => {
  reset();
  await withRawRoot(async (rawRoot) => {
    const report = await run(
      [
        {
          id: 'SE',
          paths: [
            '/private/page',
            '/api/prices',
            '/go/netflix',
            `${elsewhere.origin}/x`,
          ],
        },
      ],
      { rawRoot },
    );
    assert.deepEqual(
      report.pages.slice(1).map((page) => page.reason),
      ['disallowed_path', 'disallowed_path', 'disallowed_path', 'other_host'],
    );
    assert.deepEqual(
      source.seen.map((request) => request.path),
      ['/robots.txt'],
    );
    assert.deepEqual(elsewhere.seen, []);
  });
});
