import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { writeRunObservations } from '../../packages/price-index/src/cli/run-files.ts';
import { runDirectory } from '../../packages/price-index/src/http/raw-store.ts';
import {
  changePercent,
  compareChangeSize,
  detectChanges,
  lastPublishedRecords,
  mergePriceIndex,
  type MergeInput,
} from '../../packages/price-index/src/pipeline/index.ts';
import {
  changeEntrySchema,
  changesFileSchema,
  runLogFileSchema,
  type ChangeEntry,
  type LatestFile,
  type PriceRecord,
  type RunObservationsFile,
} from '../../packages/price-index/src/schema/index.ts';
import {
  appendChanges,
  serialiseChanges,
} from '../../packages/price-index/src/storage/index.ts';
import {
  clockAt,
  decision,
  gap,
  observation,
  oneMarket,
  oneServiceCatalogue,
  priceOverride,
  record,
  run,
  scraper,
  settings,
} from '../helpers/price-index-merge.ts';
import { priceIndexWorkspace } from '../helpers/price-index-run.ts';

// E11.6-09: change detection. A real change is a published value replaced by
// a different published value for the same record and currency. A first
// observation, a status change and a formatting-only difference log nothing;
// an approved needs_review change is logged once, dated by its observation.
// Every expectation is written by hand.

function latest(records: PriceRecord[], builtAt: string): LatestFile {
  return { built_at: builtAt, records };
}

async function detect(
  next: LatestFile,
  history: LatestFile[],
  logged: ChangeEntry[] = [],
): Promise<ChangeEntry[]> {
  const baselines = await lastPublishedRecords(next, history);
  return detectChanges({ next, baselines, logged });
}

const spotifySe129 = record();
const spotifySe149 = record({
  price_local: '149.00',
  price_source_text: 'kr 149',
  price_usd_source: '15.79',
  observed_at: '2026-12-01T09:30:00.000Z',
});

test('changePercent is exact, signed, one decimal, rounded half away from zero', () => {
  assert.equal(changePercent(12900n, 14900n), '15.5'); // 15.503…
  assert.equal(changePercent(14900n, 12900n), '-13.4'); // −13.422…
  assert.equal(changePercent(1000n, 1005n), '0.5');
  assert.equal(changePercent(2000n, 2001n), '0.1'); // 0.05 rounds up
  assert.equal(changePercent(2000n, 1999n), '-0.1'); // −0.05 rounds away
  assert.equal(changePercent(100000n, 99999n), '-0.0'); // a fall keeps its sign
  assert.equal(changePercent(100n, 300n), '200.0');
  assert.throws(() => changePercent(0n, 100n), RangeError);
});

test('a real change is logged with every field', async () => {
  const changes = await detect(
    latest([spotifySe149], '2026-12-01T10:00:00.000Z'),
    [latest([spotifySe129], '2026-11-01T10:00:00.000Z')],
  );
  assert.deepEqual(changes, [
    {
      market: 'SE',
      service_id: 'spotify',
      plan_id: 'individual',
      billing_period: 'month',
      old_price_local: '129.00',
      new_price_local: '149.00',
      currency: 'SEK',
      change_percent: '15.5',
      detected_on: '2026-12-01',
      source: scraper,
    },
  ]);
  assert.ok(changeEntrySchema.safeParse(changes[0]).success);
});

test('a first observation produces no entry', async () => {
  assert.deepEqual(
    await detect(latest([spotifySe149], '2026-12-01T10:00:00.000Z'), []),
    [],
  );
  // Nor does a record whose history never published a value.
  assert.deepEqual(
    await detect(latest([spotifySe149], '2026-12-01T10:00:00.000Z'), [
      latest(
        [
          record({
            status: 'missing',
            missing_reason: 'source_no_price',
            price_local: null,
            price_source_text: null,
            currency: null,
            price_usd_source: null,
          }),
        ],
        '2026-11-01T10:00:00.000Z',
      ),
      latest(
        [record({ status: 'needs_review', price_local: '99.00' })],
        '2026-10-01T10:00:00.000Z',
      ),
    ]),
    [],
  );
});

test('a status change produces no entry', async () => {
  const builtAt = '2026-12-01T10:00:00.000Z';
  // ok → stale, same value: the stale record is not published.
  assert.deepEqual(
    await detect(latest([record({ status: 'stale' })], builtAt), [
      latest([spotifySe129], '2026-11-01T10:00:00.000Z'),
    ]),
    [],
  );
  // stale → ok, same value, compared with the value it last published.
  assert.deepEqual(
    await detect(latest([spotifySe129], builtAt), [
      latest([record({ status: 'stale' })], '2026-11-15T10:00:00.000Z'),
      latest([spotifySe129], '2026-10-01T10:00:00.000Z'),
    ]),
    [],
  );
  // ok → needs_review with a new value: not published, so nothing yet.
  assert.deepEqual(
    await detect(
      latest(
        [record({ status: 'needs_review', price_local: '199.00' })],
        builtAt,
      ),
      [latest([spotifySe129], '2026-11-01T10:00:00.000Z')],
    ),
    [],
  );
  // ok scraped → manual_override at the same value: a status and source change.
  assert.deepEqual(
    await detect(
      latest(
        [
          record({
            status: 'manual_override',
            source: 'manual',
            observed_at: null,
            price_source_text: null,
            source_verified_at: '2026-11-30',
          }),
        ],
        builtAt,
      ),
      [latest([spotifySe129], '2026-11-01T10:00:00.000Z')],
    ),
    [],
  );
});

test('a formatting-only difference produces no entry', async () => {
  const builtAt = '2026-12-01T10:00:00.000Z';
  assert.deepEqual(
    await detect(
      latest(
        [
          record({
            price_source_text: '129,00 kr',
            observed_at: '2026-12-01T09:30:00.000Z',
          }),
        ],
        builtAt,
      ),
      [latest([spotifySe129], '2026-11-01T10:00:00.000Z')],
    ),
    [],
  );
});

test('a value in another currency than the last published one produces no entry', async () => {
  assert.deepEqual(
    await detect(
      latest(
        [record({ price_local: '13.99', currency: 'EUR' })],
        '2026-12-01T10:00:00.000Z',
      ),
      [latest([spotifySe129], '2026-11-01T10:00:00.000Z')],
    ),
    [],
  );
});

test('a manual override that changes the published value is dated by its verification', async () => {
  const changes = await detect(
    latest(
      [
        record({
          status: 'manual_override',
          source: 'manual',
          price_local: '139.00',
          price_source_text: null,
          observed_at: null,
          source_verified_at: '2026-11-30',
        }),
      ],
      '2026-12-01T10:00:00.000Z',
    ),
    [latest([spotifySe129], '2026-11-01T10:00:00.000Z')],
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.detected_on, '2026-11-30');
  assert.equal(changes[0]!.source, 'manual');
  assert.equal(changes[0]!.change_percent, '7.8');
});

function mergeInput(overrides: Partial<MergeInput>): MergeInput {
  return {
    previous: null,
    run: run(),
    overrides: { overrides: [] },
    approvals: { approvals: [] },
    catalogue: oneServiceCatalogue(),
    markets: oneMarket(),
    settings: settings(),
    clock: clockAt('2026-12-01T10:00:00.000Z'),
    ...overrides,
  };
}

test('an approved needs_review change is logged once, dated by its observation (built before the approval)', async () => {
  // November: 129.00 SEK published.
  const november = latest([spotifySe129], '2026-11-01T10:00:00.000Z');
  // December's run sees 199.00 SEK, more than 40% up: needs_review.
  const decemberRun = run({
    observedAt: '2026-12-01T09:30:00.000Z',
    observations: [
      observation({
        price_local: '199.00',
        price_source_text: 'kr 199',
        price_usd_source: '21.09',
        observed_at: '2026-12-01T09:30:00.000Z',
      }),
    ],
  });
  const flagged = mergePriceIndex(
    mergeInput({ previous: november, run: decemberRun }),
  );
  assert.equal(flagged.records[0]!.status, 'needs_review');
  const log: ChangeEntry[] = [];
  log.push(...(await detect(flagged, [november])));
  assert.equal(log.length, 0, 'an unapproved value was logged');

  // The founder approves the value; the same run is built again on 3 December.
  const approved = mergePriceIndex(
    mergeInput({
      previous: flagged,
      run: decemberRun,
      approvals: {
        approvals: [
          decision({
            price_local: '199.00',
            decided_at: '2026-12-02T10:00:00.000Z',
          }),
        ],
      },
      clock: clockAt('2026-12-03T10:00:00.000Z'),
    }),
  );
  assert.equal(approved.records[0]!.status, 'ok');
  // History, newest first: the flagged build, then November's.
  const first = await detect(approved, [flagged, flagged, november], log);
  assert.deepEqual(first, [
    {
      market: 'SE',
      service_id: 'spotify',
      plan_id: 'individual',
      billing_period: 'month',
      old_price_local: '129.00',
      new_price_local: '199.00',
      currency: 'SEK',
      change_percent: '54.3',
      // Its observation, not the build of 3 December.
      detected_on: '2026-12-01',
      source: scraper,
    },
  ]);
  log.push(...first);

  // Once: the next build after it, and a rebuild that sees the same history
  // again (a build cut short after the append), log nothing more.
  const january = mergePriceIndex(
    mergeInput({
      previous: approved,
      run: run({
        observedAt: '2027-01-01T09:30:00.000Z',
        observations: [
          observation({
            price_local: '199.00',
            price_source_text: 'kr 199',
            price_usd_source: '21.09',
            observed_at: '2027-01-01T09:30:00.000Z',
          }),
        ],
      }),
      clock: clockAt('2027-01-01T10:00:00.000Z'),
    }),
  );
  assert.deepEqual(
    await detect(january, [approved, flagged, november], log),
    [],
  );
  assert.deepEqual(await detect(approved, [flagged, november], log), []);
});

test('an approved needs_review change is logged once when the approval comes before the build', async () => {
  const november = latest([spotifySe129], '2026-11-01T10:00:00.000Z');
  const built = mergePriceIndex(
    mergeInput({
      previous: november,
      run: run({
        observations: [
          observation({ price_local: '199.00', price_source_text: 'kr 199' }),
        ],
      }),
      approvals: { approvals: [decision({ price_local: '199.00' })] },
    }),
  );
  assert.equal(built.records[0]!.status, 'ok');
  const changes = await detect(built, [november]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.detected_on, '2026-12-01');
  assert.deepEqual(await detect(built, [built, november], changes), []);
});

test('the history walk reads newest first and stops once every record has its baseline', async () => {
  const read: string[] = [];
  function* history(): Generator<LatestFile> {
    for (const file of [
      latest([record({ status: 'stale' })], '2026-11-20T10:00:00.000Z'),
      latest([spotifySe129], '2026-11-01T10:00:00.000Z'),
      latest([record({ price_local: '119.00' })], '2026-10-01T10:00:00.000Z'),
    ]) {
      read.push(file.built_at);
      yield file;
    }
  }
  const baselines = await lastPublishedRecords(
    latest([spotifySe149], '2026-12-01T10:00:00.000Z'),
    history(),
  );
  assert.equal(baselines.size, 1);
  assert.equal([...baselines.values()][0]!.price_local, '129.00');
  assert.deepEqual(read, [
    '2026-11-20T10:00:00.000Z',
    '2026-11-01T10:00:00.000Z',
  ]);
});

test('changes sort largest percentage first, by size, with ties in identity order', () => {
  const entry = (
    market: string,
    old: string,
    now: string,
    currency: string,
  ): ChangeEntry => ({
    market,
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    old_price_local: old,
    new_price_local: now,
    currency,
    change_percent: '0.0',
    detected_on: '2026-12-01',
    source: scraper,
  });
  const sorted = [
    entry('NO', '129.00', '139.00', 'NOK'), // +7.75%
    entry('SE', '129.00', '149.00', 'SEK'), // +15.5%
    entry('DK', '129.00', '119.00', 'DKK'), // −7.75%, ties with NO
    entry('IS', '1190', '1590', 'ISK'), // +33.6%, no decimals
    entry('DE', '12.99', '13.99', 'EUR'), // +7.70%
  ].sort(compareChangeSize);
  assert.deepEqual(
    sorted.map((item) => item.market),
    ['IS', 'SE', 'DK', 'NO', 'DE'],
  );
});

test('appendChanges adds at the end, writes nothing for no change, and refuses an invalid entry', async (t) => {
  const space = await priceIndexWorkspace();
  t.after(() => space.dispose());
  const path = join(space.dataDirectory, 'changes.json');
  const before = await readFile(path, 'utf8');
  assert.equal(before, '{\n  "changes": []\n}\n');
  await appendChanges(path, []);
  assert.equal(await readFile(path, 'utf8'), before);

  const changes = await detect(
    latest([spotifySe149], '2026-12-01T10:00:00.000Z'),
    [latest([spotifySe129], '2026-11-01T10:00:00.000Z')],
  );
  await appendChanges(path, changes);
  await assert.rejects(
    appendChanges(path, [{ ...changes[0]!, new_price_local: '129.00' }]),
    /a change needs two different prices/,
  );
  await assert.rejects(
    appendChanges(path, [{ ...changes[0]!, change_percent: '15.53' }]),
    /signed percentage/,
  );
  const text = await readFile(path, 'utf8');
  assert.equal(text, serialiseChanges({ changes }));
  assert.deepEqual(changesFileSchema.parse(JSON.parse(text)).changes, changes);
});

async function writeRun(
  rawRoot: string,
  observations: RunObservationsFile,
): Promise<void> {
  await mkdir(runDirectory(rawRoot, observations.run_id), { recursive: true });
  await writeRunObservations(rawRoot, observations);
}

function runObservations(
  runId: string,
  observedAt: string,
  priceLocal: string,
): RunObservationsFile {
  return {
    run_id: runId,
    source: scraper,
    observed_at: observedAt,
    fetch_status: 'completed',
    market_scope: null,
    pages_fetched: 1,
    observations: [
      observation({
        price_local: priceLocal,
        price_source_text: `kr ${priceLocal.replace('.00', '')}`,
        observed_at: observedAt,
      }),
    ],
    gaps: [],
    untracked: [],
    price_moves: null,
    failures: [],
  };
}

test('build-data appends the real changes to changes.json and counts them in the run log', async (t) => {
  const space = await priceIndexWorkspace({
    services: ['spotify'],
    markets: ['SE'],
  });
  t.after(() => space.dispose());
  const changesPath = join(space.dataDirectory, 'changes.json');

  // The first build: a first observation, nothing to log.
  await writeRun(
    space.rawRoot,
    runObservations('20261101T093000Z', '2026-11-01T09:30:00.000Z', '129.00'),
  );
  let result = await space.cli(['build-data'], {
    clock: clockAt('2026-11-01T10:00:00.000Z'),
  });
  assert.equal(result.status, 0, result.err);
  assert.equal(
    (await readFile(changesPath, 'utf8')).trim(),
    '{\n  "changes": []\n}',
  );
  const firstLog = runLogFileSchema.parse(
    JSON.parse(
      await readFile(
        join(space.root, 'reports/runs/20261101T093000Z.json'),
        'utf8',
      ),
    ),
  );
  assert.equal(firstLog.counts.changed, 0);

  // December: 149.00 SEK, within 40%, so published and logged.
  await writeRun(
    space.rawRoot,
    runObservations('20261201T093000Z', '2026-12-01T09:30:00.000Z', '149.00'),
  );
  result = await space.cli(['build-data'], {
    clock: clockAt('2026-12-01T10:00:00.000Z'),
  });
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /changed 1/);
  assert.match(result.out, /data\/price-index\/changes\.json/);
  const logged = changesFileSchema.parse(
    JSON.parse(await readFile(changesPath, 'utf8')),
  ).changes;
  assert.deepEqual(logged, [
    {
      market: 'SE',
      service_id: 'spotify',
      plan_id: 'individual',
      billing_period: 'month',
      old_price_local: '129.00',
      new_price_local: '149.00',
      currency: 'SEK',
      change_percent: '15.5',
      detected_on: '2026-12-01',
      source: scraper,
    },
  ]);
  const secondLog = runLogFileSchema.parse(
    JSON.parse(
      await readFile(
        join(space.root, 'reports/runs/20261201T093000Z.json'),
        'utf8',
      ),
    ),
  );
  assert.equal(secondLog.counts.changed, 1);

  // Building the same run again logs nothing more.
  const text = await readFile(changesPath, 'utf8');
  result = await space.cli(['build-data'], {
    clock: clockAt('2026-12-01T11:00:00.000Z'),
  });
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /changed 0/);
  assert.equal(await readFile(changesPath, 'utf8'), text);
  assert.equal((await space.cli(['validate'])).status, 0);
});

test('build-data refuses an invalid changes.json and writes nothing', async (t) => {
  const space = await priceIndexWorkspace({
    services: ['spotify'],
    markets: ['SE'],
  });
  t.after(() => space.dispose());
  await writeRun(
    space.rawRoot,
    runObservations('20261101T093000Z', '2026-11-01T09:30:00.000Z', '129.00'),
  );
  const changesPath = join(space.dataDirectory, 'changes.json');
  await writeFile(changesPath, '{ "changes": [{ "market": "SE" }] }\n');
  const result = await space.cli(['build-data'], {
    clock: clockAt('2026-11-01T10:00:00.000Z'),
  });
  assert.equal(result.status, 3);
  assert.match(result.err, /changes\.json/);
  await assert.rejects(readFile(join(space.dataDirectory, 'latest.json')));
});

// The manual path through the merge: an override within 40% of the last
// published value publishes as manual_override, and its change is logged.
test('a manual override within the threshold publishes through the merge and is logged', async () => {
  // November published a manual 129.00 SEK; the source does not list the plan.
  const november = latest(
    [
      record({
        status: 'manual_override',
        source: 'manual',
        price_source_text: null,
        price_usd_source: null,
        observed_at: null,
        source_url: 'https://www.spotify.com/se/premium/',
        source_verified_at: '2026-10-30',
      }),
    ],
    '2026-11-01T10:00:00.000Z',
  );
  const built = mergePriceIndex(
    mergeInput({
      previous: november,
      run: run({ gaps: [gap({ reason: 'not_on_source' })] }),
      overrides: {
        overrides: [priceOverride({ price_local: '139.00' })],
      },
    }),
  );
  assert.equal(built.records[0]!.status, 'manual_override');
  const changes = await detect(built, [november]);
  assert.deepEqual(
    changes.map((item) => [
      item.old_price_local,
      item.new_price_local,
      item.detected_on,
      item.source,
    ]),
    [['129.00', '139.00', '2026-11-30', 'manual']],
  );
});
