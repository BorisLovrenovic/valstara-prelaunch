import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { writeRunObservations } from '../../packages/price-index/src/cli/run-files.ts';
import { runDirectory } from '../../packages/price-index/src/http/raw-store.ts';
import type {
  MarketsFile,
  RunObservationsFile,
} from '../../packages/price-index/src/schema/index.ts';
import { readPublishedUrls } from '../../packages/price-index/src/storage/index.ts';
import { clockAt, observation, scraper } from '../helpers/price-index-merge.ts';
import {
  priceIndexWorkspace,
  projectRoot,
  type Workspace,
} from '../helpers/price-index-run.ts';

// E11.6-12: `price-index retire-url <url> --to <hub> --actor` (D2, D-032
// Q2). A workspace builds Spotify Premium — Individual in Sweden and the
// United Kingdom, so the ledger holds two published URLs and the data makes
// the hubs /prices/spotify, /prices/countries/sweden and
// /prices/countries/united-kingdom. Every refusal leaves the ledger
// byte-identical.

const mainScript = join(projectRoot, 'packages/price-index/src/cli/main.ts');
const tsxLoader = import.meta.resolve('tsx');

async function builtWorkspace(): Promise<Workspace> {
  const space = await priceIndexWorkspace({
    services: ['spotify'],
    markets: ['SE', 'GB'],
  });
  const observedAt = '2026-12-01T09:30:00.000Z';
  const run: RunObservationsFile = {
    run_id: '20261201T093000Z',
    source: scraper,
    observed_at: observedAt,
    fetch_status: 'completed',
    market_scope: null,
    pages_fetched: 2,
    observations: [
      observation({ observed_at: observedAt }),
      observation({
        market: 'GB',
        currency: 'GBP',
        price_local: '11.99',
        price_source_text: '£11.99',
        price_usd_source: '15.19',
        source_url:
          'https://www.youfundceo.com/services/spotify/united-kingdom',
        observed_at: observedAt,
      }),
    ],
    gaps: [],
    untracked: [],
    price_moves: null,
    failures: [],
  };
  await mkdir(runDirectory(space.rawRoot, run.run_id), { recursive: true });
  await writeRunObservations(space.rawRoot, run);
  const built = await space.cli(['build-data'], {
    clock: clockAt('2026-12-01T10:00:00.000Z'),
  });
  assert.equal(built.status, 0, built.err);
  return space;
}

const retiredOn = clockAt('2026-12-05T08:00:00.000Z');

function ledgerPath(space: Workspace): string {
  return join(space.dataDirectory, 'published-urls.json');
}

test('retire-url appends one retirement, dated by the clock, after the URL’s publication, and validate accepts it', async (t) => {
  const space = await builtWorkspace();
  t.after(() => space.dispose());
  const before = await readPublishedUrls(ledgerPath(space));
  assert.deepEqual(
    before?.urls.map((entry) => entry.path),
    ['/prices/spotify/sweden', '/prices/spotify/united-kingdom'],
  );

  const result = await space.cli(
    [
      'retire-url',
      '/prices/spotify/sweden',
      '--to',
      '/prices/spotify',
      '--actor',
      'Founder',
    ],
    { clock: retiredOn },
  );
  assert.equal(result.status, 0, result.err);
  assert.match(
    result.out,
    /\/prices\/spotify\/sweden now answers 301 to \/prices\/spotify/u,
  );
  const after = await readPublishedUrls(ledgerPath(space));
  // The publication entries are untouched; one entry is appended.
  assert.deepEqual(after?.urls.slice(0, 2), before?.urls);
  assert.deepEqual(after?.urls[2], {
    kind: 'retired',
    path: '/prices/spotify/sweden',
    to: '/prices/spotify',
    actor: 'Founder',
    retired_on: '2026-12-05',
  });
  // Written with the fixed key order, two-space indentation and a newline.
  const text = await readFile(ledgerPath(space), 'utf8');
  assert.match(
    text,
    /\{\n {6}"kind": "retired",\n {6}"path": "\/prices\/spotify\/sweden",\n {6}"to": "\/prices\/spotify",\n {6}"actor": "Founder",\n {6}"retired_on": "2026-12-05"\n {4}\}\n {2}\]\n\}\n$/u,
  );
  assert.equal((await space.cli(['validate'])).status, 0);

  // A full URL on the site's origin names the same path; once retired, it
  // cannot be retired again.
  const again = await space.cli(
    [
      'retire-url',
      'https://valstara.com/prices/spotify/sweden',
      '--to',
      '/prices/spotify',
      '--actor',
      'Founder',
    ],
    { clock: retiredOn },
  );
  assert.equal(again.status, 1);
  assert.match(again.err, /already retired/u);
  assert.equal(await readFile(ledgerPath(space), 'utf8'), text);
});

test('retire-url refuses without --actor, or with an empty one, before anything is written', async (t) => {
  const space = await builtWorkspace();
  t.after(() => space.dispose());
  const before = await readFile(ledgerPath(space), 'utf8');
  for (const args of [
    ['/prices/spotify/sweden', '--to', '/prices/spotify'],
    ['/prices/spotify/sweden', '--to', '/prices/spotify', '--actor', '  '],
    ['/prices/spotify/sweden', '--to', '/prices/spotify', '--actor'],
  ]) {
    const result = await space.cli(['retire-url', ...args], {
      clock: retiredOn,
    });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(
      result.err,
      /needs --actor|--actor needs a value/u,
      args.join(' '),
    );
    assert.equal(await readFile(ledgerPath(space), 'utf8'), before);
  }
});

test('retire-url refuses a URL never published, a target that is not a hub, and a hub the data does not make', async (t) => {
  const space = await builtWorkspace();
  t.after(() => space.dispose());
  const before = await readFile(ledgerPath(space), 'utf8');
  const cases: [string[], RegExp][] = [
    // Never published.
    [
      ['/prices/spotify/norway', '--to', '/prices/spotify'],
      /was never published/u,
    ],
    // Not a price page URL.
    [['/prices/spotify', '--to', '/prices/spotify'], /not a price page URL/u],
    [
      ['https://example.com/prices/spotify/sweden', '--to', '/prices/spotify'],
      /not a price page URL/u,
    ],
    // Not a hub.
    [
      ['/prices/spotify/sweden', '--to', '/prices/spotify/united-kingdom'],
      /is not a hub/u,
    ],
    [['/prices/spotify/sweden', '--to', '/prices'], /is not a hub/u],
    [['/prices/spotify/sweden', '--to', '/prices/countries'], /is not a hub/u],
    // A hub the data does not make.
    [
      ['/prices/spotify/sweden', '--to', '/prices/netflix'],
      /not a hub the published data makes/u,
    ],
    // Sweden's hub holds only this page, so it would be gone once it is
    // retired: the redirect would lead nowhere.
    [
      ['/prices/spotify/sweden', '--to', '/prices/countries/sweden'],
      /not a hub the published data makes/u,
    ],
    // Unknown and repeated flags.
    [
      ['/prices/spotify/sweden', '--to', '/prices/spotify', '--force', 'yes'],
      /--force is not a flag of retire-url/u,
    ],
    [
      [
        '/prices/spotify/sweden',
        '--to',
        '/prices/spotify',
        '--to',
        '/prices/spotify',
      ],
      /--to is given twice/u,
    ],
    [['--to', '/prices/spotify'], /the first word must be the URL/u],
  ];
  for (const [args, message] of cases) {
    const result = await space.cli(
      [
        'retire-url',
        ...args,
        ...(args.includes('--actor') ? [] : ['--actor', 'Founder']),
      ],
      { clock: retiredOn },
    );
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.err, message, args.join(' '));
    assert.equal(
      await readFile(ledgerPath(space), 'utf8'),
      before,
      args.join(' '),
    );
  }
});

test('retire-url retires the URL of a market that has left the configuration, to a hub that remains (D2)', async (t) => {
  const space = await builtWorkspace();
  t.after(() => space.dispose());
  // The United Kingdom leaves the markets: its URL stays in the ledger
  // (temporarily unavailable on the site) until it is retired to the
  // service hub, which Sweden keeps.
  const marketsPath = join(space.root, 'config/markets.json');
  const markets = JSON.parse(
    await readFile(marketsPath, 'utf8'),
  ) as MarketsFile;
  markets.markets = markets.markets.filter((market) => market.code !== 'GB');
  await writeFile(marketsPath, `${JSON.stringify(markets, null, 2)}\n`);
  const result = await space.cli(
    [
      'retire-url',
      '/prices/spotify/united-kingdom',
      '--to',
      '/prices/spotify',
      '--actor',
      'Founder',
    ],
    { clock: retiredOn },
  );
  assert.equal(result.status, 0, result.err);
  assert.equal(
    (await readPublishedUrls(ledgerPath(space)))?.urls.at(-1)?.path,
    '/prices/spotify/united-kingdom',
  );
});

test('retire-url refuses an invalid ledger with exit 3 and writes nothing', async (t) => {
  const space = await builtWorkspace();
  t.after(() => space.dispose());
  const broken =
    '{ "urls": [{ "kind": "retired", "path": "/prices/spotify/norway", "to": "/prices/spotify", "actor": "Founder", "retired_on": "2026-12-01" }] }\n';
  await writeFile(ledgerPath(space), broken);
  const result = await space.cli(
    [
      'retire-url',
      '/prices/spotify/sweden',
      '--to',
      '/prices/spotify',
      '--actor',
      'Founder',
    ],
    { clock: retiredOn },
  );
  assert.equal(result.status, 3);
  assert.match(result.err, /retired before it is published/u);
  assert.equal(await readFile(ledgerPath(space), 'utf8'), broken);
});

test('retire-url exits on its own as a child process, here refusing a retirement without --actor', async (t) => {
  const space = await builtWorkspace();
  t.after(() => space.dispose());
  const child = spawn(
    process.execPath,
    [
      '--import',
      tsxLoader,
      mainScript,
      'retire-url',
      '/prices/spotify/sweden',
      '--to',
      '/prices/spotify',
    ],
    { cwd: space.root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let err = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => (err += chunk));
  const [code, signal] = await new Promise<[number | null, string | null]>(
    (resolve) =>
      child.on('exit', (exitCode, exitSignal) =>
        resolve([exitCode, exitSignal]),
      ),
  );
  assert.equal(signal, null);
  assert.equal(code, 1, err);
  assert.match(err, /needs --actor/u);
});
