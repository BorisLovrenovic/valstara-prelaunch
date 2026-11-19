import assert from 'node:assert/strict';
import test from 'node:test';

import * as prettier from 'prettier';

import {
  coveragePercent,
  describeChanges,
  failedMarkets,
  formatSummary,
  runFigures,
  serialiseRunLog,
} from '../../packages/price-index/src/reports/index.ts';
import {
  runLogFileSchema,
  type LatestFile,
  type RunLogFile,
  type RunObservationsFile,
} from '../../packages/price-index/src/schema/index.ts';
import type { SourceGap } from '../../packages/price-index/src/sources/index.ts';
import { record } from '../helpers/price-index-merge.ts';

// E11.6-07: the run's figures, the run log and the console summary. Every
// expectation is computed by hand from the explicit inputs.

const missing = {
  price_local: null,
  price_source_text: null,
  currency: null,
  price_usd_source: null,
  status: 'missing',
} as const;

function latest(records: LatestFile['records']): LatestFile {
  return { built_at: '2026-11-18T12:00:00.000Z', records };
}

function gap(market: string, reason: SourceGap['reason'], plan = 'individual') {
  return {
    market,
    service_id: 'spotify',
    plan_id: plan,
    billing_period: 'month' as const,
    reason,
    source_url: null,
    note: null,
  };
}

function observations(
  overrides: Partial<RunObservationsFile> = {},
): RunObservationsFile {
  return {
    run_id: '20261118T093000Z',
    source: 'scraper:youfundceo.com',
    observed_at: '2026-11-18T09:30:00.000Z',
    fetch_status: 'completed',
    market_scope: null,
    pages_fetched: 0,
    observations: [],
    gaps: [],
    untracked: [],
    price_moves: null,
    failures: [],
    ...overrides,
  };
}

test('coverage is publishable records over all records, floored to one decimal', () => {
  assert.equal(coveragePercent(latest([])), 0);
  assert.equal(
    coveragePercent(
      latest([
        record({ market: 'SE' }),
        record({ market: 'NO', currency: 'NOK' }),
        record({ market: 'DK', ...missing, missing_reason: 'not_on_source' }),
      ]),
    ),
    66.6,
  );
  // needs_review, stale and conflict do not count; manual_override does.
  assert.equal(
    coveragePercent(
      latest([
        record({ market: 'SE', status: 'needs_review' }),
        record({ market: 'NO', currency: 'NOK', status: 'stale' }),
        record({
          market: 'DK',
          currency: 'DKK',
          status: 'manual_override',
          source: 'manual',
        }),
      ]),
    ),
    33.3,
  );
  // A nearly complete index never rounds up to 100%.
  const many = Array.from({ length: 1999 }, (_, index) =>
    record({ plan_id: `plan-${index}` }),
  );
  assert.equal(
    coveragePercent(
      latest([
        ...many,
        record({ plan_id: 'last', ...missing, missing_reason: 'parse_failed' }),
      ]),
    ),
    99.9,
  );
});

test('failed markets are those with a failed page, counted by record and sorted', () => {
  assert.deepEqual(
    failedMarkets(
      observations({
        gaps: [
          gap('US', 'market_failed'),
          gap('DE', 'parse_failed'),
          gap('US', 'parse_failed', 'family'),
          gap('SE', 'not_on_source'),
          gap('SE', 'source_no_price', 'family'),
        ],
      }),
    ),
    [
      { market: 'DE', failed_records: 1 },
      { market: 'US', failed_records: 2 },
    ],
  );
});

test('the figures count pages, matches, untracked entries, statuses and the changes logged', () => {
  const figures = runFigures(
    observations({
      pages_fetched: 7,
      untracked: [
        {
          kind: 'service',
          source_service: 'disney-plus',
          source_name: 'Disney+',
          suggestion: null,
        },
      ],
      gaps: [gap('US', 'market_failed')],
      failures: [
        {
          url: 'https://www.youfundceo.com/countries/united-states',
          market: 'US',
          reason: 'market_failed',
          detail: 'HTTP 429',
        },
      ],
    }),
    latest([
      record({ market: 'SE' }),
      record({
        market: 'US',
        currency: 'USD',
        status: 'conflict',
        price_local: '11.99',
      }),
    ]),
    2,
  );
  assert.deepEqual(figures.counts, {
    fetched: 7,
    matched: 0,
    unmatched: 1,
    records_by_status: {
      ok: 1,
      missing: 0,
      not_offered: 0,
      needs_review: 0,
      manual_override: 0,
      stale: 0,
      conflict: 1,
    },
    failed_markets: 1,
    changed: 2,
  });
  assert.equal(figures.coverage_percent, 50);
});

test('describeChanges lists new, changed and leaving records, and ignores a refreshed time', () => {
  const before = latest([
    record({ market: 'SE', observed_at: '2026-10-18T09:00:00.000Z' }),
    record({ market: 'NO', currency: 'NOK', price_local: '129.00' }),
    record({ market: 'DK', currency: 'DKK', price_local: '99.00' }),
  ]);
  const after = latest([
    record({
      market: 'SE',
      observed_at: '2026-11-18T09:30:00.000Z',
      notes: 'A new note.',
    }),
    record({
      market: 'NO',
      currency: 'NOK',
      price_local: '199.00',
      status: 'needs_review',
    }),
    record({ market: 'FI', currency: 'EUR', price_local: '11.99' }),
  ]);
  assert.deepEqual(describeChanges(before, after), [
    '- DK/spotify/individual/month: ok 99.00 DKK from scraper:youfundceo.com, leaves latest.json',
    '+ FI/spotify/individual/month: ok 11.99 EUR from scraper:youfundceo.com',
    '~ NO/spotify/individual/month: ok 129.00 NOK from scraper:youfundceo.com → needs_review 199.00 NOK from scraper:youfundceo.com',
  ]);
  assert.deepEqual(describeChanges(after, after), []);
  assert.deepEqual(
    describeChanges(
      null,
      latest([record({ ...missing, missing_reason: 'not_on_source' })]),
    ),
    ['+ SE/spotify/individual/month: missing (not_on_source)'],
  );
});

const log: RunLogFile = {
  run_id: '20261118T093000Z',
  source: 'scraper:youfundceo.com',
  fetch_status: 'stopped_by_source',
  market_scope: null,
  observed_at: '2026-11-18T09:30:00.000Z',
  built_at: '2026-11-18T12:00:00.000Z',
  snapshot: '2026-11-18.json',
  coverage_percent: 81.2,
  counts: {
    fetched: 15,
    matched: 13,
    unmatched: 49,
    records_by_status: {
      ok: 13,
      missing: 3,
      not_offered: 0,
      needs_review: 0,
      manual_override: 0,
      stale: 0,
      conflict: 0,
    },
    failed_markets: 1,
    changed: 0,
  },
  failed_markets: [{ market: 'US', failed_records: 8 }],
  failures: [
    {
      url: 'https://www.youfundceo.com/countries/united-states',
      market: 'US',
      reason: 'market_failed',
      detail: 'the page was not fetched',
    },
  ],
};

test('the run log is deterministic, passes Prettier and carries no not-modified count', async () => {
  const text = serialiseRunLog(log);
  const shuffled = Object.fromEntries(
    Object.entries(log).reverse(),
  ) as RunLogFile;
  assert.equal(serialiseRunLog(shuffled), text);
  assert.ok(text.endsWith('}\n'));
  const path = 'reports/runs/20261118T093000Z.json';
  const options = (await prettier.resolveConfig(path)) ?? {};
  assert.ok(await prettier.check(text, { ...options, filepath: path }));

  assert.equal(
    runLogFileSchema.safeParse({
      ...log,
      counts: { ...log.counts, not_modified: 0 },
    }).success,
    false,
  );
  assert.equal(
    runLogFileSchema.safeParse({ ...log, fx: { EUR: '1.00' } }).success,
    false,
  );
  assert.throws(() =>
    serialiseRunLog({ ...log, coverage_percent: 101 } as RunLogFile),
  );
});

test('the summary prints coverage, every count, the failed markets and the reports', () => {
  const text = formatSummary({
    heading: 'price-index build-data: built run 20261118T093000Z.',
    marketScope: 'SE',
    figures: log,
    reports: ['data/price-index/latest.json', 'reports/runs/x.json'],
  });
  assert.equal(
    text,
    [
      'price-index build-data: built run 20261118T093000Z.',
      '  Markets: SE',
      '  Coverage: 81.2% (13 of 16 records publishable)',
      '  Fetched 15 · matched 13 · unmatched 49 · changed 0',
      '  Records by status: ok 13 · missing 3 · not_offered 0 · needs_review 0 · manual_override 0 · stale 0 · conflict 0',
      '  Failed markets: US (8)',
      '  Reports:',
      '    data/price-index/latest.json',
      '    reports/runs/x.json',
      '',
    ].join('\n'),
  );
});
