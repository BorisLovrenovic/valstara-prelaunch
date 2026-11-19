import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parseMonthArgument } from '../../packages/price-index/src/cli/monthly-report.ts';
import { writeRunObservations } from '../../packages/price-index/src/cli/run-files.ts';
import { runDirectory } from '../../packages/price-index/src/http/raw-store.ts';
import {
  buildRunLog,
  serialiseRunLog,
} from '../../packages/price-index/src/reports/index.ts';
import {
  monthlyReportFileSchema,
  type ChangeEntry,
  type LatestFile,
  type RunObservationsFile,
} from '../../packages/price-index/src/schema/index.ts';
import { serialiseChanges } from '../../packages/price-index/src/storage/index.ts';
import { record, scraper } from '../helpers/price-index-merge.ts';
import {
  priceIndexWorkspace,
  treeDigest,
  type Workspace,
} from '../helpers/price-index-run.ts';

// E11.6-09: `price-index monthly-report --month YYYY-MM` reads the month's
// last snapshot, the change log and, for the cross-check, the price moves of
// the runs built that month, and writes data/price-index/monthly/YYYY-MM.json
// and reports/monthly/YYYY-MM.md. It writes nothing else, and a refusal
// writes nothing at all.

const runId = '20261125T093000Z';

function latest(priceSe: string, builtAt: string): LatestFile {
  return {
    built_at: builtAt,
    records: [
      record({ market: 'SE', price_local: priceSe, price_usd_source: '15.79' }),
      record({
        market: 'NO',
        currency: 'NOK',
        price_local: '139.00',
        price_source_text: 'kr 139',
        price_usd_source: '12.50',
      }),
    ],
  };
}

const seChange: ChangeEntry = {
  market: 'SE',
  service_id: 'spotify',
  plan_id: 'individual',
  billing_period: 'month',
  old_price_local: '129.00',
  new_price_local: '149.00',
  currency: 'SEK',
  change_percent: '15.5',
  detected_on: '2026-11-25',
  source: scraper,
};

function observations(): RunObservationsFile {
  return {
    run_id: runId,
    source: scraper,
    observed_at: '2026-11-25T09:30:00.000Z',
    fetch_status: 'completed',
    market_scope: null,
    pages_fetched: 1,
    observations: [],
    gaps: [],
    untracked: [],
    price_moves: [
      {
        source_service: 'spotify',
        source_plan: 'individual',
        service_id: 'spotify',
        plan_id: 'individual',
        market: 'NO',
        period: 'm',
        currency: 'NOK',
        old_price: '129.00',
        new_price: '139.00',
        date: '2026-11-20',
        after_date: null,
        evidence_url: 'https://www.spotify.com/no/premium/',
        source_flag: false,
        old_usd: '11.60',
        new_usd: '12.50',
      },
    ],
    failures: [],
  };
}

/** A workspace with an October and two November builds, a log and a run. */
async function november(): Promise<Workspace> {
  const space = await priceIndexWorkspace({
    services: ['spotify'],
    markets: ['SE', 'NO'],
  });
  await space.writeLatest(
    latest('129.00', '2026-10-20T10:00:00.000Z'),
    '2026-10-20',
  );
  await space.writeLatest(
    latest('129.00', '2026-11-02T10:00:00.000Z'),
    '2026-11-02',
  );
  const last = latest('149.00', '2026-11-25T10:00:00.000Z');
  await space.writeLatest(last, '2026-11-25');
  await writeFile(
    join(space.dataDirectory, 'changes.json'),
    serialiseChanges({ changes: [seChange] }),
  );
  await mkdir(runDirectory(space.rawRoot, runId), { recursive: true });
  await writeRunObservations(space.rawRoot, observations());
  await mkdir(join(space.root, 'reports/runs'), { recursive: true });
  await writeFile(
    join(space.root, `reports/runs/${runId}.json`),
    serialiseRunLog(
      buildRunLog({
        observations: observations(),
        latest: last,
        snapshot: '2026-11-25.json',
        changed: 1,
      }),
    ),
  );
  return space;
}

test('--month takes exactly one real month', () => {
  assert.equal(parseMonthArgument(['--month', '2026-11']), '2026-11');
  for (const args of [
    [],
    ['--month'],
    ['--month', '2026-13'],
    ['--month', '2026-1'],
    ['--month', '2026-11', '--dry-run'],
    ['--month=2026-11'],
    ['2026-11'],
  ]) {
    assert.equal(parseMonthArgument(args), null, args.join(' '));
  }
});

test('monthly-report writes the feed and the Markdown from the month’s last build', async (t) => {
  const space = await november();
  t.after(() => space.dispose());
  const before = await treeDigest(space.root, [
    'data/price-index',
    'config',
    'reports/runs',
  ]);

  const result = await space.cli(['monthly-report', '--month', '2026-11']);
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /2026-11, from snapshot 2026-11-25\.json/);
  assert.match(result.out, /data\/price-index\/monthly\/2026-11\.json/);
  assert.match(result.out, /reports\/monthly\/2026-11\.md/);

  const feed = monthlyReportFileSchema.parse(
    JSON.parse(
      await readFile(join(space.dataDirectory, 'monthly/2026-11.json'), 'utf8'),
    ),
  );
  assert.equal(feed.snapshot, '2026-11-25.json');
  assert.equal(feed.markets, 2);
  assert.deepEqual(
    feed.changes.map((entry) => [
      entry.market,
      entry.old_price_local,
      entry.new_price_local,
    ]),
    [['SE', '129.00', '149.00']],
  );
  assert.deepEqual(feed.plans[0]!.most_expensive, {
    market: 'SE',
    price_local: '149.00',
    currency: 'SEK',
  });
  // 15.79 / 12.50 = 1.2632
  assert.equal(feed.plans[0]!.spread_ratio, '1.3');

  const markdown = await readFile(
    join(space.root, 'reports/monthly/2026-11.md'),
    'utf8',
  );
  assert.match(markdown, /^# Price index: November 2026\n/);
  assert.match(markdown, /Price moves read from: 20261125T093000Z\./);
  assert.match(
    markdown,
    /- Spotify Premium — Individual, Norway: 129\.00 NOK to 139\.00 NOK, dated 2026-11-20 by the source\./,
  );
  assert.match(
    markdown,
    /- Spotify Premium — Individual, Sweden: 129\.00 SEK to 149\.00 SEK, detected 2026-11-25\./,
  );

  // Nothing else changed, and every file still validates.
  const after = await treeDigest(space.root, [
    'data/price-index',
    'config',
    'reports/runs',
  ]);
  delete after['data/price-index/monthly/2026-11.json'];
  assert.deepEqual(after, before);
  assert.equal((await space.cli(['validate'])).status, 0);

  // A second run replaces both files with the same bytes.
  const feedText = await readFile(
    join(space.dataDirectory, 'monthly/2026-11.json'),
    'utf8',
  );
  assert.equal(
    (await space.cli(['monthly-report', '--month', '2026-11'])).status,
    0,
  );
  assert.equal(
    await readFile(join(space.dataDirectory, 'monthly/2026-11.json'), 'utf8'),
    feedText,
  );
  assert.equal(
    await readFile(join(space.root, 'reports/monthly/2026-11.md'), 'utf8'),
    markdown,
  );
});

test('a month with no changes gets an honest report; a broken raw run is refused, a lost one leaves the cross-check unavailable', async (t) => {
  const space = await november();
  t.after(() => space.dispose());
  await writeFile(
    join(space.dataDirectory, 'changes.json'),
    serialiseChanges({ changes: [] }),
  );
  // The raw store holds a broken copy of the run's observations.
  await writeFile(
    join(runDirectory(space.rawRoot, runId), 'observations.json'),
    '',
  );
  const result = await space.cli(['monthly-report', '--month', '2026-11']);
  // An unreadable raw run is refused rather than read as "no moves".
  assert.equal(result.status, 3);
  assert.match(result.err, /a raw run is invalid/);

  // With the observations gone altogether, the report says so.
  await rm(join(runDirectory(space.rawRoot, runId), 'observations.json'));
  const ok = await space.cli(['monthly-report', '--month', '2026-11']);
  assert.equal(ok.status, 0, ok.err);
  const markdown = await readFile(
    join(space.root, 'reports/monthly/2026-11.md'),
    'utf8',
  );
  assert.match(markdown, /No list price we track changed in November 2026\./);
  assert.match(
    markdown,
    /The cross-check could not run: no build of this month still has its price moves in the raw store\./,
  );
});

test('monthly-report refuses, writing nothing', async (t) => {
  const space = await november();
  t.after(() => space.dispose());
  const before = await treeDigest(space.root);

  for (const args of [
    ['monthly-report'],
    ['monthly-report', '--month', '2026-13'],
    ['monthly-report', '--month', '2026-11', '--force'],
  ]) {
    const result = await space.cli(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.err, /it takes exactly --month YYYY-MM/);
  }
  const noBuild = await space.cli(['monthly-report', '--month', '2026-09']);
  assert.equal(noBuild.status, 1);
  assert.match(noBuild.err, /there is no build in 2026-09/);
  assert.deepEqual(await treeDigest(space.root), before);

  await writeFile(
    join(space.dataDirectory, 'changes.json'),
    '{ "changes": [{ "market": "SE" }] }\n',
  );
  const invalid = await space.cli(['monthly-report', '--month', '2026-11']);
  assert.equal(invalid.status, 3);
  assert.match(invalid.err, /changes\.json/);
  assert.match(invalid.err, /No report was written/);
  const after = await treeDigest(space.root);
  delete after['data/price-index/changes.json'];
  delete before['data/price-index/changes.json'];
  assert.deepEqual(after, before);
});
