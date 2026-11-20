import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { isPublishable } from '../../packages/price-index/src/publish/gate.ts';
import type {
  CatalogueFile,
  ChangesFile,
  LatestFile,
  MarketsFile,
  MonthlyReportFile,
  PublishedUrlsFile,
  ValstaraPricesFile,
} from '../../packages/price-index/src/schema/index.ts';
import { pricesCopy } from '../../src/copy/prices.ts';
import {
  createPriceSite,
  PriceDataError,
  type MonthlyReportPage,
  type PriceSite,
  type TextPart,
} from '../../src/server/prices/site.ts';
import { datasetIssues } from '../helpers/structured-data.mjs';
import { projectRoot } from '../helpers/price-index-run.ts';

// E11.6-13: `/price-index` and the monthly reports at the view-model layer,
// over the price-page fixture dataset (test/fixtures/price-index/pages/)
// and its two monthly reports, 2026-09 (no changes) and 2026-10. The
// rendered pages are in test/price-index-rendered.test.mjs; the
// methodology's reconciliation is in price-index-methodology.test.ts.

const fixtureDirectory = join(projectRoot, 'test/fixtures/price-index/pages');

interface Dataset {
  latest: LatestFile | null;
  catalogue: CatalogueFile;
  markets: MarketsFile;
  ledger: PublishedUrlsFile;
  changes: ChangesFile;
  valstaraPrices: ValstaraPricesFile;
  monthly: Record<string, unknown>;
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8')) as T;
}

async function dataset(): Promise<Dataset> {
  return {
    latest: await fixture('latest.json'),
    catalogue: await fixture('catalogue.json'),
    markets: await fixture('markets.json'),
    ledger: await fixture('published-urls.json'),
    changes: await fixture('changes.json'),
    valstaraPrices: await fixture('valstara-prices.json'),
    monthly: {
      '2026-09.json': await fixture('monthly/2026-09.json'),
      '2026-10.json': await fixture('monthly/2026-10.json'),
    },
  };
}

function report(site: PriceSite, month: string): MonthlyReportPage {
  const page = site.monthlyReport(`/price-index/${month}`);
  assert.ok(page, `${month} has a report page`);
  return page;
}

/** A sentence as it reads, with the path of each linked part. */
function read(parts: readonly TextPart[]) {
  return {
    text: parts.map((part) => part.text).join(''),
    links: parts.flatMap((part) =>
      part.href === null ? [] : [[part.text, part.href]],
    ),
  };
}

/** The verification dates of every published record of the fixture, independently. */
function publishedDates(data: Dataset): string[] {
  const enabled = new Set(
    data.markets.markets.filter((m) => m.enabled).map((m) => m.code),
  );
  const plans = new Set(
    data.catalogue.services.flatMap((service) =>
      service.plans.map(
        (plan) =>
          `${service.service_id}/${plan.plan_id}/${plan.billing_period}`,
      ),
    ),
  );
  return (data.latest?.records ?? [])
    .filter(
      (item) =>
        isPublishable(item) &&
        enabled.has(item.market) &&
        plans.has(`${item.service_id}/${item.plan_id}/${item.billing_period}`),
    )
    .map((item) => item.source_verified_at ?? item.observed_at!.slice(0, 10))
    .sort();
}

test('the Dataset JSON-LD validates and states only what the published data holds', async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  const dataset_ = site.priceIndex.dataset;
  assert.deepEqual(datasetIssues(dataset_), []);
  const dates = publishedDates(data);
  assert.deepEqual(dataset_, {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: pricesCopy.priceIndex.dataset.name,
    description: pricesCopy.priceIndex.dataset.description,
    url: 'https://valstara.com/price-index',
    temporalCoverage: '2026-11-20/2026-11-28',
    spatialCoverage: data.markets.markets
      .filter((market) => market.enabled)
      .map((market) => ({
        '@type': 'Country',
        name: market.name,
        identifier: market.code,
      })),
    dateModified: '2026-11-28',
  });
  // The dates are the oldest and newest verification of a published price.
  assert.equal(dates[0], '2026-11-20');
  assert.equal(dates.at(-1), '2026-11-28');
  // Records the gate refuses (needs_review on 2026-11-28 in GB, stale on
  // 2026-09-01 in FR) widen nothing.
  assert.ok(
    data.latest!.records.some(
      (item) =>
        item.status === 'stale' && item.source_verified_at === '2026-09-01',
    ),
  );
});

test('the Dataset covers the enabled markets only, follows the data, and is absent with no published price', async () => {
  const data = await dataset();
  // A disabled market leaves the coverage, and its prices the dates.
  const markets = structuredClone(data.markets);
  for (const market of markets.markets) {
    if (market.code === 'SE') market.enabled = false;
  }
  const withoutSweden = createPriceSite({ ...data, markets });
  const dataset_ = withoutSweden.priceIndex.dataset as {
    spatialCoverage: { identifier: string }[];
    temporalCoverage: string;
    dateModified: string;
  };
  assert.deepEqual(datasetIssues(dataset_), []);
  assert.ok(
    !dataset_.spatialCoverage.some((place) => place.identifier === 'SE'),
  );
  assert.equal(dataset_.temporalCoverage, '2026-11-22/2026-11-28');

  // One published price: a single date, not an interval.
  const latest = structuredClone(data.latest!);
  latest.records = latest.records.filter(
    (item) => item.market === 'GB' && item.service_id === 'spotify',
  );
  const single = createPriceSite({ ...data, latest });
  assert.equal(
    (single.priceIndex.dataset as { temporalCoverage: string })
      .temporalCoverage,
    '2026-11-28',
  );

  // No latest.json, or nothing published: no dataset, no verified line.
  for (const empty of [
    null,
    {
      ...data.latest!,
      records: data.latest!.records.filter((item) => !isPublishable(item)),
    },
  ]) {
    const site = createPriceSite({ ...data, latest: empty });
    assert.equal(site.priceIndex.dataset, null);
    assert.equal(site.priceIndex.verifiedLine, null);
  }
});

test('the Dataset check refuses malformed data', async () => {
  const valid = createPriceSite(await dataset()).priceIndex.dataset as Record<
    string,
    unknown
  >;
  assert.deepEqual(datasetIssues(valid), []);
  for (const broken of [
    null,
    { ...valid, '@type': 'WebPage' },
    { ...valid, '@context': 'http://schema.org' },
    { ...valid, name: ' ' },
    { ...valid, description: 'Too short.' },
    { ...valid, url: 'https://valstara.com/prices' },
    { ...valid, temporalCoverage: '2026-11-28/2026-11-20' },
    { ...valid, temporalCoverage: 'November 2026' },
    { ...valid, spatialCoverage: [] },
    { ...valid, spatialCoverage: [{ '@type': 'Place', name: 'Sweden' }] },
    { ...valid, dateModified: '28 November 2026' },
    { ...valid, variableMeasured: 'price_usd_source' },
    { ...valid, size: 9 },
  ]) {
    assert.notDeepEqual(datasetIssues(broken), [], JSON.stringify(broken));
  }
});

test('every page a monthly report mentions is linked if it is generated, and named without a link if it is not', async () => {
  const site = createPriceSite(await dataset());
  const october = report(site, '2026-10');

  assert.deepEqual(
    october.changes.map((row) => [
      row.planLabel,
      row.marketPart.text,
      row.marketPart.href,
    ]),
    [
      // Generated: linked.
      ['Spotify Premium — Individual', 'Sweden', '/prices/spotify/sweden'],
      // A service the catalogue no longer has: named from the ledger, and
      // its plan by its identifier, never linked.
      ['Crunchyroll — mega-fan', 'Sweden', null],
      // A market the configuration no longer has: named from the ledger.
      ['Spotify Premium — Individual', 'Finland', null],
      // Configured, but its record is a conflict today: no page.
      ['Spotify Premium — Individual', 'Norway', null],
    ],
  );
  assert.deepEqual(october.direction.map(read), [
    { text: 'Crunchyroll — mega-fan rose in 1 of 1 market.', links: [] },
    {
      text: 'Spotify Premium — Individual rose in 3 of 6 markets.',
      links: [['Spotify Premium — Individual', '/prices/spotify']],
    },
  ]);
  assert.deepEqual(october.extremes.map(read), [
    {
      // No ChatGPT page is generated (GB is stale, US has no record), so
      // there is no hub and no page to link.
      text: 'ChatGPT — Plus: most expensive in the United Kingdom (20.00 GBP), least expensive in the United States (20.00 USD).',
      links: [],
    },
    {
      text: 'Spotify Premium — Individual: most expensive in Sweden (149.00 SEK), least expensive in the United States (12.99 USD).',
      links: [
        ['Spotify Premium — Individual', '/prices/spotify'],
        ['Sweden', '/prices/spotify/sweden'],
        ['the United States', '/prices/spotify/united-states'],
      ],
    },
  ]);
  assert.equal(
    october.unranked,
    pricesCopy.monthly.unranked(2),
    'Crunchyroll and Netflix Standard are published in one ranked market each',
  );

  // Across every report: each mention links exactly when its page exists.
  for (const page of site.monthlyReports) {
    const parts = [
      ...page.changes.map((row) => ({ part: row.marketPart, row })),
    ];
    for (const { part, row } of parts) {
      const generated = site.routes.find(
        (route) =>
          route.kind === 'generated' &&
          route.serviceId === row.serviceId &&
          route.market === row.market,
      );
      assert.equal(
        part.href,
        generated?.path ?? null,
        `${page.path} ${row.market}`,
      );
    }
    for (const part of [...page.direction, ...page.extremes].flat()) {
      if (part.href === null) continue;
      assert.ok(
        site.route(part.href)?.kind === 'generated' ||
          site.hub(part.href) !== null,
        `${page.path} links ${part.href}, which exists`,
      );
    }
  }
});

test("a report's figures are its file's, exactly, with no USD figure", async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  const file = data.monthly['2026-10.json'] as MonthlyReportFile;
  const october = report(site, '2026-10');
  assert.deepEqual(
    october.changes.map((row) => [
      row.market,
      row.oldAmount,
      row.newAmount,
      row.currency,
      row.changePercent,
      row.oldText,
      row.newText,
      row.percentText,
    ]),
    file.changes.map((entry) => [
      entry.market,
      entry.old_price_local,
      entry.new_price_local,
      entry.currency,
      entry.change_percent,
      `${entry.old_price_local} ${entry.currency}`,
      `${entry.new_price_local} ${entry.currency}`,
      `+${entry.change_percent}%`,
    ]),
  );
  assert.equal(
    october.intro,
    "List prices across our 6 markets, from the price index as updated on 30 October 2026. Every price is in its market's own currency.",
  );
  const text = JSON.stringify(site.monthlyReports);
  // The fixture's USD figures (16.78, 12.99 as a USD price is the US list
  // price itself) never appear as a figure for another market.
  assert.doesNotMatch(text, /16\.78|price_usd_source|≈/u);
  assert.equal(october.lastmod, '2026-10-30');
  assert.equal(
    october.meta.title,
    'Price index report: October 2026 — Valstara',
  );
  assert.deepEqual(
    october.breadcrumbs.map((crumb) => [crumb.name, crumb.url]),
    [
      ['Valstara', 'https://valstara.com/'],
      ['Price index', 'https://valstara.com/price-index'],
      [
        'Price index report: October 2026',
        'https://valstara.com/price-index/2026-10',
      ],
    ],
  );
});

test('a month with no changes says so honestly', async () => {
  const september = report(createPriceSite(await dataset()), '2026-09');
  assert.deepEqual(september.changes, []);
  assert.equal(
    september.noChanges,
    'No list price we track changed in September 2026.',
  );
  assert.deepEqual(september.direction, []);
  assert.equal(september.extremes.length, 1);
});

test('a month with no report file has no page', async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  for (const path of [
    '/price-index/2026-11',
    '/price-index/2026-08',
    '/price-index/2026-13',
    '/price-index/2026-1',
    '/price-index/october',
    '/price-index/2026-10/',
    '/price-index',
  ]) {
    assert.equal(site.monthlyReport(path), null, path);
  }
  assert.deepEqual(
    site.monthlyReports.map((page) => page.path),
    ['/price-index/2026-10', '/price-index/2026-09'],
  );
  assert.deepEqual(site.monthlySitemap, [
    { path: '/price-index/2026-09', lastmod: '2026-09-29' },
    { path: '/price-index/2026-10', lastmod: '2026-10-30' },
  ]);
  assert.deepEqual(site.priceIndex.reports, [
    { path: '/price-index/2026-10', label: 'October 2026' },
    { path: '/price-index/2026-09', label: 'September 2026' },
  ]);

  // Removing a file removes its page, its sitemap entry and its link.
  const withoutOctober = createPriceSite({
    ...data,
    monthly: { '2026-09.json': data.monthly['2026-09.json'] },
  });
  assert.equal(withoutOctober.monthlyReport('/price-index/2026-10'), null);
  assert.deepEqual(
    withoutOctober.monthlySitemap.map((entry) => entry.path),
    ['/price-index/2026-09'],
  );
  // With none, `/price-index` lists none.
  const none = createPriceSite({ ...data, monthly: {} });
  assert.deepEqual(none.monthlyReports, []);
  assert.deepEqual(none.priceIndex.reports, []);
  assert.deepEqual(none.monthlySitemap, []);
  assert.deepEqual(
    createPriceSite({ ...data, monthly: undefined }).monthlyReports,
    [],
  );
});

test('a misnamed, mismatched or invalid report file fails the build', async () => {
  const data = await dataset();
  const october = data.monthly['2026-10.json'] as MonthlyReportFile;
  for (const [monthly, pattern] of [
    [{ 'october.json': october }, /not named YYYY-MM\.json/u],
    [{ '2026-11.json': october }, /reports 2026-10, not 2026-11/u],
    [
      {
        '2026-10.json': {
          ...october,
          changes: [{ ...october.changes[0], price_usd_source: '16.78' }],
        },
      },
      /2026-10\.json is invalid/u,
    ],
  ] as const) {
    assert.throws(
      () => createPriceSite({ ...data, monthly }),
      (error: unknown) =>
        error instanceof PriceDataError && pattern.test(error.message),
    );
  }
});

test('a catalogue or market change reaches the reports with no code change', async () => {
  const data = await dataset();
  // Spotify removed: its pages go, so its mentions are named from the
  // ledger and never linked; its plan by its identifier.
  const catalogue = structuredClone(data.catalogue);
  catalogue.services = catalogue.services.filter(
    (service) => service.service_id !== 'spotify',
  );
  const valstaraPrices = {
    prices: data.valstaraPrices.prices.filter(
      (entry) => entry.service_id !== 'spotify',
    ),
  };
  const withoutSpotify = report(
    createPriceSite({ ...data, catalogue, valstaraPrices }),
    '2026-10',
  );
  assert.deepEqual(
    withoutSpotify.changes.map((row) => [row.planLabel, row.marketPart.href]),
    [
      ['Spotify Premium — individual', null],
      ['Crunchyroll — mega-fan', null],
      ['Spotify Premium — individual', null],
      ['Spotify Premium — individual', null],
    ],
  );
  assert.ok(
    [...withoutSpotify.direction, ...withoutSpotify.extremes]
      .flat()
      .every((part) => part.href === null),
  );

  // An added service changes nothing in a report that never mentions it.
  const added = structuredClone(data.catalogue);
  added.services.push({
    ...structuredClone(added.services[0]!),
    service_id: 'new-service',
    name: 'New Service',
    source_aliases: {
      service: ['New Service'],
      plans: { individual: ['Individual'] },
    },
  });
  assert.deepEqual(
    report(createPriceSite({ ...data, catalogue: added }), '2026-10'),
    report(createPriceSite(data), '2026-10'),
  );

  // The United States removed from the markets: named as the ledger
  // recorded it, unlinked; an added market changes nothing.
  const markets = structuredClone(data.markets);
  markets.markets = markets.markets.filter((market) => market.code !== 'US');
  const withoutUs = report(createPriceSite({ ...data, markets }), '2026-10');
  const spotify = read(withoutUs.extremes[1]!);
  assert.match(
    spotify.text,
    /least expensive in the United States \(12\.99 USD\)/u,
  );
  assert.ok(!spotify.links.some(([, href]) => href.includes('united-states')));
  const moreMarkets = structuredClone(data.markets);
  moreMarkets.markets.push({
    ...structuredClone(moreMarkets.markets[1]!),
    code: 'AT',
    name: 'Austria',
    slug: 'austria',
  });
  assert.deepEqual(
    report(createPriceSite({ ...data, markets: moreMarkets }), '2026-10'),
    report(createPriceSite(data), '2026-10'),
  );
});

test('every service × market page, generated or unavailable, links the methodology', async () => {
  const site = createPriceSite(await dataset());
  assert.ok(site.routes.some((route) => route.kind === 'unavailable'));
  for (const route of site.routes) {
    assert.deepEqual(
      route.methodologyLink,
      { path: '/price-index', label: pricesCopy.page.methodologyLink },
      route.path,
    );
  }
  assert.deepEqual(
    site.priceIndex.breadcrumbs.map((crumb) => crumb.url),
    ['https://valstara.com/', 'https://valstara.com/price-index'],
  );
  assert.equal(
    site.priceIndex.verifiedLine,
    'Prices verified between 20 November 2026 and 28 November 2026.',
  );
});
