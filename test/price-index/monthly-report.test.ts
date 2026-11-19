import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import * as prettier from 'prettier';

import { monthlyReportCopy } from '../../packages/price-index/copy/monthly-report.ts';
import {
  buildMonthlyReport,
  crossCheckPriceMoves,
  renderMonthlyMarkdown,
  serialiseMonthlyReport,
  type CrossCheckInput,
} from '../../packages/price-index/src/reports/index.ts';
import {
  monthlyReportFileSchema,
  type CatalogueFile,
  type ChangeEntry,
  type LatestFile,
  type MarketsFile,
  type PriceRecord,
  type RunObservationsFile,
} from '../../packages/price-index/src/schema/index.ts';
import { record, scraper } from '../helpers/price-index-merge.ts';
import { projectRoot } from '../helpers/price-index-run.ts';

// E11.6-09: the monthly report over a fixture month, November 2026. Every
// expected figure below is computed by hand from the explicit inputs:
//
// Markets: SE (SEK), NO (NOK), DK (DKK), DE (EUR), all enabled; US disabled.
// The month's last snapshot holds:
//   spotify individual  SE ok 149.00 SEK (USD 15.79)
//                       NO ok 139.00 NOK (USD 12.50)
//                       DK ok 119.00 DKK (USD 17.40)
//                       DE needs_review 25.00 EUR (USD 28.88) — gated out
//   netflix basic       SE ok 99.00 SEK (USD 10.49)
//                       NO ok 109.00 NOK (USD 9.80)
//                       DK manual_override 79.00 DKK (no USD: unranked)
//   netflix premium     SE ok 199.00 SEK (USD 21.09): one ranked market
//   netflix standard    SE stale 149.00 SEK: gated out, so no plan figure

type PriceMove = NonNullable<RunObservationsFile['price_moves']>[number];

const month = '2026-11';

function catalogue(): CatalogueFile {
  const plan = (plan_id: string, name: string) => ({
    plan_id,
    name,
    billing_period: 'month' as const,
    is_student: false,
    is_family: false,
  });
  return {
    services: [
      {
        service_id: 'spotify',
        name: 'Spotify Premium',
        category: 'music',
        website_url: 'https://www.spotify.com/',
        status: 'launch',
        plans: [plan('individual', 'Individual')],
        source_aliases: { service: ['Spotify'], plans: {} },
      },
      {
        service_id: 'netflix',
        name: 'Netflix',
        category: 'streaming',
        website_url: 'https://www.netflix.com/',
        status: 'launch',
        plans: [
          plan('basic', 'Basic'),
          plan('standard', 'Standard'),
          plan('premium', 'Premium (4K)'),
        ],
        source_aliases: { service: ['Netflix'], plans: {} },
      },
    ],
  };
}

function markets(): MarketsFile {
  const market = (
    code: string,
    name: string,
    currency: string,
    enabled = true,
  ) => ({ code, name, slug: name.toLowerCase(), currency, enabled });
  return {
    markets: [
      market('SE', 'Sweden', 'SEK'),
      market('NO', 'Norway', 'NOK'),
      market('DK', 'Denmark', 'DKK'),
      market('DE', 'Germany', 'EUR'),
      market('US', 'United States', 'USD', false),
    ],
  };
}

function priced(
  service_id: string,
  plan_id: string,
  market: string,
  price_local: string,
  currency: string,
  price_usd_source: string | null,
  status: PriceRecord['status'] = 'ok',
): PriceRecord {
  return record({
    service_id,
    plan_id,
    market,
    price_local,
    price_source_text: `${price_local} ${currency}`,
    currency,
    price_usd_source,
    status,
    ...(status === 'manual_override'
      ? { source: 'manual', price_source_text: null, observed_at: null }
      : {}),
  });
}

function snapshot(): LatestFile {
  return {
    built_at: '2026-11-20T10:00:00.000Z',
    records: [
      priced('spotify', 'individual', 'SE', '149.00', 'SEK', '15.79'),
      priced('spotify', 'individual', 'NO', '139.00', 'NOK', '12.50'),
      priced('spotify', 'individual', 'DK', '119.00', 'DKK', '17.40'),
      priced(
        'spotify',
        'individual',
        'DE',
        '25.00',
        'EUR',
        '28.88',
        'needs_review',
      ),
      priced('netflix', 'basic', 'SE', '99.00', 'SEK', '10.49'),
      priced('netflix', 'basic', 'NO', '109.00', 'NOK', '9.80'),
      priced('netflix', 'basic', 'DK', '79.00', 'DKK', null, 'manual_override'),
      priced('netflix', 'premium', 'SE', '199.00', 'SEK', '21.09'),
      priced('netflix', 'standard', 'SE', '149.00', 'SEK', '16.88', 'stale'),
    ],
  };
}

const usdFigures = [
  '15.79',
  '12.50',
  '17.40',
  '28.88',
  '10.49',
  '9.80',
  '21.09',
  '16.88',
];

function change(
  service_id: string,
  plan_id: string,
  market: string,
  old_price_local: string,
  new_price_local: string,
  currency: string,
  change_percent: string,
  detected_on: string,
): ChangeEntry {
  return {
    market,
    service_id,
    plan_id,
    billing_period: 'month',
    old_price_local,
    new_price_local,
    currency,
    change_percent,
    detected_on,
    source: scraper,
  };
}

/** The whole log, in append order. */
function changeLog(): ChangeEntry[] {
  return [
    // October: outside the month.
    change(
      'spotify',
      'individual',
      'SE',
      '119.00',
      '129.00',
      'SEK',
      '8.4',
      '2026-10-05',
    ),
    change(
      'spotify',
      'individual',
      'SE',
      '129.00',
      '149.00',
      'SEK',
      '15.5',
      '2026-11-03',
    ),
    change(
      'spotify',
      'individual',
      'NO',
      '129.00',
      '139.00',
      'NOK',
      '7.8',
      '2026-11-03',
    ),
    change(
      'spotify',
      'individual',
      'DK',
      '129.00',
      '119.00',
      'DKK',
      '-7.8',
      '2026-11-03',
    ),
    // DE's record is needs_review in the snapshot: gated out.
    change(
      'spotify',
      'individual',
      'DE',
      '12.99',
      '13.99',
      'EUR',
      '7.7',
      '2026-11-03',
    ),
    change(
      'netflix',
      'basic',
      'NO',
      '99.00',
      '109.00',
      'NOK',
      '10.1',
      '2026-11-04',
    ),
    // The stale record is gated out too.
    change(
      'netflix',
      'standard',
      'SE',
      '139.00',
      '149.00',
      'SEK',
      '7.2',
      '2026-11-04',
    ),
    // December: outside the month.
    change(
      'netflix',
      'basic',
      'SE',
      '99.00',
      '109.00',
      'SEK',
      '10.1',
      '2026-12-01',
    ),
  ];
}

function report(changes = changeLog(), file = snapshot(), forMonth = month) {
  return buildMonthlyReport({
    month: forMonth,
    snapshot: { name: '2026-11-20.json', file },
    changes,
    catalogue: catalogue(),
    markets: markets(),
  });
}

function move(overrides: Partial<PriceMove>): PriceMove {
  return {
    source_service: 'spotify',
    source_plan: 'individual',
    service_id: 'spotify',
    plan_id: 'individual',
    market: 'SE',
    period: 'm',
    currency: 'SEK',
    old_price: '129.00',
    new_price: '149.00',
    date: '2026-11-02',
    after_date: null,
    evidence_url: 'https://www.spotify.com/se/premium/',
    source_flag: false,
    old_usd: '13.67',
    new_usd: '15.79',
    ...overrides,
  };
}

function crossCheckInput(
  overrides: Partial<CrossCheckInput> = {},
): CrossCheckInput {
  return {
    month,
    runs: [
      {
        runId: '20261101T093000Z',
        priceMoves: [
          // Matches our SE change, though dated a day earlier.
          move({}),
          // Not in our log: an undetected move.
          move({
            source_service: 'netflix',
            source_plan: 'basic',
            service_id: 'netflix',
            plan_id: 'basic',
            market: 'DK',
            currency: 'DKK',
            old_price: '79.00',
            new_price: '89.00',
            date: '2026-11-10',
            old_usd: '11.40',
            new_usd: '12.84',
          }),
          // Dated October: not this month's.
          move({
            source_service: 'netflix',
            source_plan: 'basic',
            service_id: 'netflix',
            plan_id: 'basic',
            old_price: '89.00',
            new_price: '99.00',
            date: '2026-10-15',
          }),
          // A service the catalogue does not track.
          move({
            source_service: 'apple-music',
            service_id: null,
            plan_id: null,
            date: '2026-11-12',
          }),
          // A disabled market.
          move({
            market: 'US',
            currency: 'USD',
            old_price: '11.99',
            new_price: '12.99',
            date: '2026-11-12',
          }),
        ],
      },
      { runId: '20261115T093000Z', priceMoves: null },
    ],
    changes: changeLog(),
    catalogue: catalogue(),
    markets: markets(),
    ...overrides,
  };
}

test('the report figures match the hand-computed fixture month', () => {
  const built = report();
  assert.deepEqual(built, {
    month: '2026-11',
    snapshot: '2026-11-20.json',
    built_at: '2026-11-20T10:00:00.000Z',
    markets: 4,
    // Largest % first, by size: 15.5, 10.1, then DK and NO tie at 10/129
    // and are in identity order.
    changes: [
      {
        market: 'SE',
        service_id: 'spotify',
        plan_id: 'individual',
        billing_period: 'month',
        old_price_local: '129.00',
        new_price_local: '149.00',
        currency: 'SEK',
        change_percent: '15.5',
        detected_on: '2026-11-03',
      },
      {
        market: 'NO',
        service_id: 'netflix',
        plan_id: 'basic',
        billing_period: 'month',
        old_price_local: '99.00',
        new_price_local: '109.00',
        currency: 'NOK',
        change_percent: '10.1',
        detected_on: '2026-11-04',
      },
      {
        market: 'DK',
        service_id: 'spotify',
        plan_id: 'individual',
        billing_period: 'month',
        old_price_local: '129.00',
        new_price_local: '119.00',
        currency: 'DKK',
        change_percent: '-7.8',
        detected_on: '2026-11-03',
      },
      {
        market: 'NO',
        service_id: 'spotify',
        plan_id: 'individual',
        billing_period: 'month',
        old_price_local: '129.00',
        new_price_local: '139.00',
        currency: 'NOK',
        change_percent: '7.8',
        detected_on: '2026-11-03',
      },
    ],
    plans: [
      {
        service_id: 'netflix',
        plan_id: 'basic',
        billing_period: 'month',
        published_markets: 3,
        ranked_markets: 2,
        most_expensive: { market: 'SE', price_local: '99.00', currency: 'SEK' },
        least_expensive: {
          market: 'NO',
          price_local: '109.00',
          currency: 'NOK',
        },
        // 10.49 / 9.80 = 1.0704…
        spread_ratio: '1.1',
        rose_in: 1,
        fell_in: 0,
      },
      {
        service_id: 'netflix',
        plan_id: 'premium',
        billing_period: 'month',
        published_markets: 1,
        ranked_markets: 1,
        most_expensive: null,
        least_expensive: null,
        spread_ratio: null,
        rose_in: 0,
        fell_in: 0,
      },
      {
        service_id: 'spotify',
        plan_id: 'individual',
        billing_period: 'month',
        published_markets: 3,
        ranked_markets: 3,
        most_expensive: {
          market: 'DK',
          price_local: '119.00',
          currency: 'DKK',
        },
        least_expensive: {
          market: 'NO',
          price_local: '139.00',
          currency: 'NOK',
        },
        // 17.40 / 12.50 = 1.392
        spread_ratio: '1.4',
        rose_in: 2,
        fell_in: 1,
      },
    ],
  });
  assert.ok(monthlyReportFileSchema.safeParse(built).success);
});

test('the Markdown carries the same figures in sentences and local prices', () => {
  const markdown = renderMonthlyMarkdown(
    report(),
    {
      catalogue: catalogue(),
      markets: markets(),
    },
    crossCheckPriceMoves(crossCheckInput()),
  );
  for (const expected of [
    '# Price index: November 2026',
    'Official list prices across our 4 markets, from the price index as built on 20 November 2026.',
    '| Spotify Premium — Individual | Sweden  | 129.00 SEK | 149.00 SEK | +15.5% |',
    '| Spotify Premium — Individual | Denmark | 129.00 DKK | 119.00 DKK | -7.8%  |',
    '- Netflix — Basic rose in 1 of 3 markets.',
    '- Spotify Premium — Individual rose in 2 of 3 markets.',
    '- Spotify Premium — Individual fell in 1 of 3 markets.',
    '- Netflix — Basic: most expensive in Sweden (99.00 SEK), least expensive in Norway (109.00 NOK). The most expensive market costs 1.1 times the cheapest.',
    '- Spotify Premium — Individual: most expensive in Denmark (119.00 DKK), least expensive in Norway (139.00 NOK). The most expensive market costs 1.4 times the cheapest.',
    '1 more plan has a published price in fewer than two comparable markets, so it is not ranked.',
  ]) {
    assert.ok(markdown.includes(expected), `missing: ${expected}\n${markdown}`);
  }
});

test('no USD figure and no converted price appears in the report or the feed', () => {
  const built = report();
  const json = serialiseMonthlyReport(built);
  const markdown = renderMonthlyMarkdown(
    built,
    {
      catalogue: catalogue(),
      markets: markets(),
    },
    crossCheckPriceMoves(crossCheckInput()),
  );
  for (const text of [json, markdown]) {
    for (const figure of [...usdFigures, '13.67', '11.40', '12.84']) {
      assert.ok(!text.includes(figure), `a USD figure ${figure} appears`);
    }
    assert.doesNotMatch(text, /usd/i);
    assert.doesNotMatch(text, /\$/);
  }
  // Every price in the feed is a local price of its own market's currency.
  const currencies = new Map(
    markets().markets.map((market) => [market.code, market.currency]),
  );
  for (const plan of built.plans) {
    for (const extreme of [plan.most_expensive, plan.least_expensive]) {
      if (extreme !== null) {
        assert.equal(extreme.currency, currencies.get(extreme.market));
      }
    }
  }
  for (const entry of built.changes) {
    assert.equal(entry.currency, currencies.get(entry.market));
  }
});

test('a record excluded by the publish gate contributes to no figure', () => {
  const built = report();
  // DE's needs_review spotify record would be the most expensive (USD 28.88)
  // and DE's change would count as a rise; the stale netflix standard record
  // would add a plan and a change. None of them does.
  assert.ok(!built.changes.some((entry) => entry.market === 'DE'));
  assert.ok(!built.changes.some((entry) => entry.plan_id === 'standard'));
  assert.ok(!built.plans.some((plan) => plan.plan_id === 'standard'));
  const spotify = built.plans.find((plan) => plan.service_id === 'spotify')!;
  assert.equal(spotify.most_expensive?.market, 'DK');
  assert.equal(spotify.published_markets, 3);
  assert.equal(spotify.rose_in, 2);
  const markdown = renderMonthlyMarkdown(
    built,
    {
      catalogue: catalogue(),
      markets: markets(),
    },
    crossCheckPriceMoves(crossCheckInput({ runs: [] })),
  );
  assert.ok(!markdown.includes('Germany'));
  assert.ok(!markdown.includes('25.00'));
  assert.ok(!markdown.includes('Standard'));

  // Publishing the same records makes them count, so the exclusion is the gate's.
  const opened = snapshot();
  opened.records = opened.records.map((item) =>
    item.status === 'needs_review' || item.status === 'stale'
      ? { ...item, status: 'ok' }
      : item,
  );
  const ungated = report(changeLog(), opened);
  const ungatedSpotify = ungated.plans.find(
    (plan) => plan.service_id === 'spotify',
  )!;
  assert.equal(ungatedSpotify.most_expensive?.market, 'DE');
  assert.equal(ungatedSpotify.rose_in, 3);
  assert.ok(ungated.plans.some((plan) => plan.plan_id === 'standard'));
});

test('the cross-check lists both kinds of disagreement, and is absent from the feed', () => {
  const check = crossCheckPriceMoves(crossCheckInput());
  assert.deepEqual(check.readRuns, ['20261101T093000Z']);
  assert.deepEqual(check.missingRuns, ['20261115T093000Z']);
  // Moves we did not detect: only the tracked, enabled, November DK move.
  assert.deepEqual(
    check.undetected.map((item) => [
      item.service_id,
      item.plan_id,
      item.market,
      item.old_price,
      item.new_price,
      item.date,
    ]),
    [['netflix', 'basic', 'DK', '79.00', '89.00', '2026-11-10']],
  );
  // Changes the source does not list: every November entry but SE's
  // spotify change, the gated ones included, largest first.
  assert.deepEqual(
    check.unlisted.map((item) => [item.service_id, item.plan_id, item.market]),
    [
      ['netflix', 'basic', 'NO'], // 10.1%
      ['spotify', 'individual', 'DK'], // 7.75%
      ['spotify', 'individual', 'NO'], // 7.75%
      ['spotify', 'individual', 'DE'], // 7.70%
      ['netflix', 'standard', 'SE'], // 7.19%
    ],
  );

  const markdown = renderMonthlyMarkdown(
    report(),
    { catalogue: catalogue(), markets: markets() },
    check,
  );
  assert.ok(
    markdown.includes(
      "## Cross-check against the source's price moves (founder only)",
    ),
  );
  assert.ok(
    markdown.includes(
      '- Netflix — Basic, Denmark: 79.00 DKK to 89.00 DKK, dated 2026-11-10 by the source.',
    ),
  );
  assert.ok(
    markdown.includes(
      '- Spotify Premium — Individual, Germany: 12.99 EUR to 13.99 EUR, detected 2026-11-03.',
    ),
  );
  assert.ok(
    markdown.includes('No price moves in the raw store for: 20261115T093000Z.'),
  );

  // The feed holds none of it, and does not change with it.
  const json = serialiseMonthlyReport(report());
  assert.deepEqual(Object.keys(JSON.parse(json)), [
    'month',
    'snapshot',
    'built_at',
    'markets',
    'changes',
    'plans',
  ]);
  for (const absent of ['89.00', '2026-11-10', 'cross', 'source', 'moves']) {
    assert.ok(!json.includes(absent), `the feed holds ${absent}`);
  }
  assert.ok(
    monthlyReportFileSchema.safeParse({
      ...JSON.parse(json),
      cross_check: check,
    }).success === false,
  );
});

test('the cross-check says so when no price moves are left to read', () => {
  const check = crossCheckPriceMoves(crossCheckInput({ runs: [] }));
  assert.deepEqual(check.readRuns, []);
  assert.deepEqual(check.missingRuns, []);
  assert.deepEqual(check.undetected, []);
  const markdown = renderMonthlyMarkdown(
    report(),
    { catalogue: catalogue(), markets: markets() },
    check,
  );
  assert.ok(markdown.includes(monthlyReportCopy.crossCheckUnavailable));
  assert.ok(!markdown.includes(monthlyReportCopy.undetectedHeading));
});

test('a month with no changes produces an honest "no changes" report', () => {
  const empty = report(
    changeLog().filter((item) => !item.detected_on.startsWith('2026-11')),
  );
  assert.deepEqual(empty.changes, []);
  assert.ok(
    empty.plans.every((plan) => plan.rose_in === 0 && plan.fell_in === 0),
  );
  // The extremes are still the month's published prices.
  assert.equal(empty.plans.length, 3);
  const markdown = renderMonthlyMarkdown(
    empty,
    { catalogue: catalogue(), markets: markets() },
    crossCheckPriceMoves(crossCheckInput({ changes: [] })),
  );
  assert.ok(
    markdown.includes('No list price we track changed in November 2026.'),
  );
  assert.ok(markdown.includes('No plan rose or fell this month.'));
  assert.ok(!markdown.includes('| Plan'));
});

test('both files are byte-stable and in Prettier format', async () => {
  const built = report();
  const json = serialiseMonthlyReport(built);
  assert.equal(serialiseMonthlyReport(report()), json);
  const markdown = renderMonthlyMarkdown(
    built,
    { catalogue: catalogue(), markets: markets() },
    crossCheckPriceMoves(crossCheckInput()),
  );
  for (const [path, text] of [
    ['data/price-index/monthly/2026-11.json', json],
    ['reports/monthly/2026-11.md', markdown],
  ] as const) {
    const filepath = join(projectRoot, path);
    const options = (await prettier.resolveConfig(filepath)) ?? {};
    assert.equal(
      await prettier.format(text, { ...options, filepath }),
      text,
      `${path} is not in Prettier's format`,
    );
  }
});

test("the report's templates hold no forbidden copy", async () => {
  const policy = JSON.parse(
    await readFile(join(projectRoot, 'scripts/forbidden-copy.json'), 'utf8'),
  ) as { entries: { term: string }[] };
  const text = await readFile(
    join(projectRoot, 'packages/price-index/copy/monthly-report.ts'),
    'utf8',
  );
  for (const { term } of policy.entries) {
    assert.doesNotMatch(text, new RegExp(`\\b${term}\\b`, 'i'));
  }
  // No exclamation mark in any sentence, and the source is never named.
  assert.doesNotMatch(text, /!['`]/);
  assert.doesNotMatch(text, /youfundceo/i);
});
