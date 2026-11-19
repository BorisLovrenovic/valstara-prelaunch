import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { writeRunObservations } from '../../packages/price-index/src/cli/run-files.ts';
import { runDirectory } from '../../packages/price-index/src/http/raw-store.ts';
import {
  generatedPages,
  ledgerPathConflicts,
  publishedUrlsFor,
} from '../../packages/price-index/src/publish/index.ts';
import {
  marketsFileSchema,
  publishedUrlsFileSchema,
  type CatalogueFile,
  type ChangesFile,
  type LatestFile,
  type MarketsFile,
  type PublishedUrlsFile,
  type RunObservationsFile,
  type ValstaraPricesFile,
} from '../../packages/price-index/src/schema/index.ts';
import {
  appendPublishedUrls,
  newPublishedUrls,
  readPublishedUrls,
  serialisePublishedUrls,
} from '../../packages/price-index/src/storage/index.ts';
import {
  createPriceSite,
  PriceDataError,
  type GeneratedPriceRoute,
  type PriceSiteInputs,
} from '../../src/server/prices/site.ts';
import { clockAt, observation, scraper } from '../helpers/price-index-merge.ts';
import {
  priceIndexWorkspace,
  projectRoot,
} from '../helpers/price-index-run.ts';

// E11.6-10: the generation rule and the published-URL ledger, at the page
// layer, over the fixture dataset in test/fixtures/price-index/pages/: eight
// generated pages, four ledger URLs without publishable data, and pairs
// that generate nothing (E11.6-11 extended the dataset for the page's
// content blocks; their tests are in price-page-content.test.ts). Catalogue and market additions and removals are
// data, so each is a fixture change with no code change (epic rule 5).

const fixtureDirectory = join(projectRoot, 'test/fixtures/price-index/pages');

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8')) as T;
}

interface Dataset {
  latest: LatestFile;
  catalogue: CatalogueFile;
  markets: MarketsFile;
  ledger: PublishedUrlsFile;
  changes: ChangesFile;
  valstaraPrices: ValstaraPricesFile;
}

async function dataset(): Promise<Dataset> {
  return {
    latest: await fixture('latest.json'),
    catalogue: await fixture('catalogue.json'),
    markets: await fixture('markets.json'),
    ledger: await fixture('published-urls.json'),
    changes: await fixture('changes.json'),
    valstaraPrices: await fixture('valstara-prices.json'),
  };
}

function siteOf(data: Dataset) {
  return createPriceSite(data satisfies PriceSiteInputs);
}

const generatedPaths = [
  '/prices/apple-music/sweden',
  '/prices/duolingo/france',
  '/prices/netflix/sweden',
  '/prices/netflix/united-states',
  '/prices/spotify/france',
  '/prices/spotify/sweden',
  '/prices/spotify/united-kingdom',
  '/prices/spotify/united-states',
];

test('a page is generated only where a plan passes the publish gate', async () => {
  const data = await dataset();
  const pages = generatedPages(data.latest, data.catalogue, data.markets);
  assert.deepEqual(pages.map((page) => page.path).sort(), generatedPaths);
  // Netflix in Sweden: Basic (ok) and Premium (an approved manual override);
  // Standard is needs_review and is left out.
  const netflix = pages.find((page) => page.path === '/prices/netflix/sweden');
  assert.deepEqual(
    netflix?.records.map((record) => [record.plan_id, record.price_local]),
    [
      ['basic', '99.00'],
      ['premium', '229.00'],
    ],
  );
  // Duolingo in France: Super only; Max is stale.
  assert.deepEqual(
    pages
      .find((page) => page.path === '/prices/duolingo/france')
      ?.records.map((record) => record.plan_id),
    ['super'],
  );
  // No latest.json yet generates nothing.
  assert.deepEqual(generatedPages(null, data.catalogue, data.markets), []);
});

test('the site model: generated pages, ledger URLs without data unavailable, every other pair absent', async () => {
  const site = siteOf(await dataset());
  assert.deepEqual(
    site.routes.map((route) => [route.path, route.kind]),
    [
      ['/prices/apple-music/sweden', 'generated'],
      ['/prices/apple-music/united-states', 'unavailable'],
      ['/prices/chatgpt/united-kingdom', 'unavailable'],
      ['/prices/crunchyroll/sweden', 'unavailable'],
      ['/prices/duolingo/france', 'generated'],
      ['/prices/netflix/sweden', 'generated'],
      ['/prices/netflix/united-states', 'generated'],
      ['/prices/spotify/finland', 'unavailable'],
      ['/prices/spotify/france', 'generated'],
      ['/prices/spotify/sweden', 'generated'],
      ['/prices/spotify/united-kingdom', 'generated'],
      ['/prices/spotify/united-states', 'generated'],
    ],
  );
  // Skipped: a conflict (NO), a missing record (DE), a needs_review record
  // (Apple Music in GB), no record at all.
  for (const path of [
    '/prices/spotify/norway',
    '/prices/spotify/germany',
    '/prices/apple-music/united-kingdom',
    '/prices/duolingo/sweden',
    '/prices/chatgpt/sweden',
  ]) {
    assert.equal(site.route(path), null, path);
  }
  // The sitemap lists the generated pages only, each dated by its newest
  // verification, not by the build.
  assert.deepEqual(site.sitemap, [
    { path: '/prices/apple-music/sweden', lastmod: '2026-11-21' },
    { path: '/prices/duolingo/france', lastmod: '2026-11-26' },
    { path: '/prices/netflix/sweden', lastmod: '2026-11-25' },
    { path: '/prices/netflix/united-states', lastmod: '2026-11-27' },
    { path: '/prices/spotify/france', lastmod: '2026-11-22' },
    { path: '/prices/spotify/sweden', lastmod: '2026-11-28' },
    { path: '/prices/spotify/united-kingdom', lastmod: '2026-11-28' },
    { path: '/prices/spotify/united-states', lastmod: '2026-11-27' },
  ]);
});

test('a generated page shows each published record exactly, dated from its verification, in local currency', async () => {
  const site = siteOf(await dataset());
  const netflix = site.route('/prices/netflix/sweden') as GeneratedPriceRoute;
  assert.equal(netflix.heading, 'Netflix price in Sweden (November 2026)');
  assert.equal(
    netflix.meta.title,
    'Netflix price in Sweden (November 2026) — Valstara',
  );
  assert.deepEqual(
    netflix.rows.map((row) => [
      row.planName,
      row.amount,
      row.currency,
      row.priceText,
      row.periodText,
      row.verifiedOn,
      row.verifiedText,
    ]),
    [
      [
        'Basic',
        '99.00',
        'SEK',
        '99.00 SEK',
        'per month',
        '2026-11-20',
        '20 November 2026',
      ],
      [
        'Premium (4K)',
        '229.00',
        'SEK',
        '229.00 SEK',
        'per month',
        '2026-11-25',
        '25 November 2026',
      ],
    ],
  );
  assert.equal(
    netflix.verifiedLine,
    'Prices verified between 20 November 2026 and 25 November 2026.',
  );
  const spotify = site.route('/prices/spotify/sweden') as GeneratedPriceRoute;
  assert.equal(spotify.verifiedLine, 'Prices verified on 28 November 2026.');
  // A market whose name needs an article in a sentence.
  assert.equal(
    site.route('/prices/netflix/united-states')?.heading,
    'Netflix price in the United States (November 2026)',
  );
});

test('the view model holds no USD figure, no unpublished value and no source name', async () => {
  const data = await dataset();
  const serialised = JSON.stringify(siteOf(data).routes);
  for (const record of data.latest.records) {
    if (record.currency !== 'USD' && record.price_usd_source !== null) {
      assert.ok(
        !serialised.includes(record.price_usd_source),
        `the USD figure ${record.price_usd_source} leaked`,
      );
    }
  }
  for (const unpublished of ['139.00', '29.99', '20.00', '10.49']) {
    assert.ok(!serialised.includes(unpublished), unpublished);
  }
  assert.doesNotMatch(serialised, /youfundceo|price_usd_source|notes/iu);
});

test('an unavailable ledger URL names itself from the configuration, or from the ledger once its service or market is gone', async () => {
  const site = siteOf(await dataset());
  assert.equal(
    site.route('/prices/chatgpt/united-kingdom')?.meta.title,
    'ChatGPT price in the United Kingdom — temporarily unavailable — Valstara',
  );
  // Crunchyroll is not in the fixture catalogue; Finland not in its markets.
  assert.equal(
    site.route('/prices/crunchyroll/sweden')?.heading,
    'Crunchyroll price in Sweden',
  );
  assert.equal(
    site.route('/prices/spotify/finland')?.heading,
    'Spotify Premium price in Finland',
  );
  for (const route of site.routes.filter(
    (item) => item.kind === 'unavailable',
  )) {
    assert.ok(!('rows' in route), `${route.path} shows no price`);
  }
});

test('catalogue add and remove at the page layer: an addition generates nothing until it has data, then its page, row and sitemap entry; a removal leaves only its ledger URLs, unavailable', async () => {
  const base = await dataset();

  // Added: a service, a plan and a market, all without data.
  const added: Dataset = structuredClone(base);
  added.catalogue.services.push({
    ...structuredClone(
      added.catalogue.services.find(
        (service) => service.service_id === 'chatgpt',
      )!,
    ),
    service_id: 'notion',
    name: 'Notion',
    source_aliases: { service: [], plans: {} },
  });
  added.catalogue.services
    .find((service) => service.service_id === 'spotify')!
    .plans.push({
      plan_id: 'family',
      name: 'Family',
      billing_period: 'month',
      is_student: false,
      is_family: true,
    });
  added.markets.markets.push({
    code: 'NL',
    name: 'Netherlands',
    name_in_sentence: 'the Netherlands',
    slug: 'netherlands',
    currency: 'EUR',
    enabled: true,
  });
  const withAdditions = siteOf(added);
  assert.deepEqual(
    withAdditions.sitemap.map((entry) => entry.path),
    generatedPaths,
  );
  assert.equal(withAdditions.route('/prices/notion/sweden'), null);
  assert.equal(withAdditions.route('/prices/spotify/netherlands'), null);
  assert.equal(
    (withAdditions.route('/prices/spotify/sweden') as GeneratedPriceRoute).rows
      .length,
    1,
  );

  // The same additions, each given one ok record: the new service and the
  // new market generate their pages and sitemap entries, and the new plan
  // adds its row to an existing page.
  const spotifySweden = added.latest.records.find(
    (record) =>
      record.service_id === 'spotify' &&
      record.market === 'SE' &&
      record.plan_id === 'individual',
  )!;
  added.latest.records.push(
    {
      ...structuredClone(spotifySweden),
      service_id: 'notion',
      plan_id: 'plus',
      price_local: '110.00',
      price_source_text: '110 kr',
      source_url: 'https://www.youfundceo.com/services/notion/sweden',
      source_verified_at: '2026-11-24',
    },
    {
      ...structuredClone(spotifySweden),
      plan_id: 'family',
      price_local: '269.00',
      price_source_text: '269 kr',
      source_verified_at: '2026-11-29',
    },
    {
      ...structuredClone(spotifySweden),
      market: 'NL',
      price_local: '11.99',
      price_source_text: '€11,99',
      currency: 'EUR',
      source_url: 'https://www.youfundceo.com/services/spotify/netherlands',
      source_verified_at: '2026-11-23',
    },
  );
  const withAddedData = siteOf(added);
  assert.equal(withAddedData.route('/prices/notion/sweden')?.kind, 'generated');
  assert.equal(
    withAddedData.route('/prices/spotify/netherlands')?.kind,
    'generated',
  );
  assert.deepEqual(withAddedData.sitemap, [
    { path: '/prices/apple-music/sweden', lastmod: '2026-11-21' },
    { path: '/prices/duolingo/france', lastmod: '2026-11-26' },
    { path: '/prices/netflix/sweden', lastmod: '2026-11-25' },
    { path: '/prices/netflix/united-states', lastmod: '2026-11-27' },
    { path: '/prices/notion/sweden', lastmod: '2026-11-24' },
    { path: '/prices/spotify/france', lastmod: '2026-11-22' },
    { path: '/prices/spotify/netherlands', lastmod: '2026-11-23' },
    { path: '/prices/spotify/sweden', lastmod: '2026-11-29' },
    { path: '/prices/spotify/united-kingdom', lastmod: '2026-11-28' },
    { path: '/prices/spotify/united-states', lastmod: '2026-11-27' },
  ]);
  assert.deepEqual(
    (
      withAddedData.route('/prices/spotify/sweden') as GeneratedPriceRoute
    ).rows.map((row) => [row.planName, row.priceText]),
    [
      ['Individual', '149.00 SEK'],
      ['Family', '269.00 SEK'],
    ],
  );

  // Removed: Netflix leaves the catalogue. Its Swedish URL is in the ledger
  // and stays, unavailable; its US URL never was, so it is simply gone.
  const removedService: Dataset = structuredClone(base);
  removedService.catalogue.services = removedService.catalogue.services.filter(
    (service) => service.service_id !== 'netflix',
  );
  // As `price-index validate` requires, its Valstara prices go with it.
  removedService.valstaraPrices.prices =
    removedService.valstaraPrices.prices.filter(
      (price) => price.service_id !== 'netflix',
    );
  removedService.ledger.urls.push({
    path: '/prices/netflix/sweden',
    service_id: 'netflix',
    market: 'SE',
    service_name: 'Netflix',
    market_name: 'Sweden',
    first_published_on: '2026-11-01',
  });
  const withoutNetflix = siteOf(removedService);
  assert.equal(
    withoutNetflix.route('/prices/netflix/sweden')?.kind,
    'unavailable',
  );
  assert.equal(withoutNetflix.route('/prices/netflix/united-states'), null);
  assert.ok(
    !withoutNetflix.sitemap.some((entry) => entry.path.includes('netflix')),
  );

  // Removed or disabled market: Sweden leaves the markets, France is
  // disabled. Spotify in Sweden is in the ledger and stays, unavailable.
  const removedMarket: Dataset = structuredClone(base);
  removedMarket.markets.markets = removedMarket.markets.markets.filter(
    (market) => market.code !== 'SE',
  );
  removedMarket.valstaraPrices.prices =
    removedMarket.valstaraPrices.prices.filter(
      (price) => price.market !== 'SE',
    );
  removedMarket.markets.markets.find(
    (market) => market.code === 'FR',
  )!.enabled = false;
  const withoutSweden = siteOf(removedMarket);
  assert.equal(
    withoutSweden.route('/prices/spotify/sweden')?.kind,
    'unavailable',
  );
  assert.equal(
    withoutSweden.route('/prices/spotify/sweden')?.heading,
    'Spotify Premium price in Sweden',
  );
  assert.equal(withoutSweden.route('/prices/netflix/sweden'), null);
  assert.equal(withoutSweden.route('/prices/duolingo/france'), null);
  assert.equal(withoutSweden.route('/prices/spotify/france'), null);
  assert.deepEqual(
    withoutSweden.sitemap.map((entry) => entry.path),
    [
      '/prices/netflix/united-states',
      '/prices/spotify/united-kingdom',
      '/prices/spotify/united-states',
    ],
  );
});

test('an invalid input publishes nothing: a broken ledger, a page in a foreign currency, a record with no verification date', async () => {
  const base = await dataset();
  const brokenLedger = structuredClone(base) as unknown as {
    ledger: { urls: unknown[] };
  } & Dataset;
  brokenLedger.ledger.urls.push({ path: '/prices/Spotify/sweden' });
  assert.throws(() => siteOf(brokenLedger), PriceDataError);

  // The gate passes only the market's currency in practice (the merge flags
  // any other); the view refuses one anyway rather than show it.
  const foreign = structuredClone(base);
  foreign.markets.markets.find((market) => market.code === 'SE')!.currency =
    'NOK';
  // Without the Valstara prices, which the configuration check would refuse
  // first (price-page-content.test.ts covers that refusal).
  foreign.valstaraPrices.prices = [];
  assert.throws(() => siteOf(foreign), /not Sweden's currency NOK/u);

  const undated = structuredClone(base);
  const spotify = undated.latest.records.find(
    (record) => record.service_id === 'spotify' && record.market === 'SE',
  )!;
  spotify.source_verified_at = null;
  spotify.observed_at = null;
  assert.throws(() => siteOf(undated), /has no verification date/u);
});

test('the ledger takes each generated page once, in path order, with the names it was published under', async () => {
  const data = await dataset();
  const pages = generatedPages(data.latest, data.catalogue, data.markets);
  const candidates = publishedUrlsFor(pages, '2026-12-01');
  const fresh = newPublishedUrls(data.ledger, candidates);
  // Spotify in Sweden is already in the ledger.
  assert.deepEqual(
    fresh.map((entry) => [entry.path, entry.market_name]),
    [
      ['/prices/apple-music/sweden', 'Sweden'],
      ['/prices/duolingo/france', 'France'],
      ['/prices/netflix/sweden', 'Sweden'],
      ['/prices/netflix/united-states', 'the United States'],
      ['/prices/spotify/france', 'France'],
      ['/prices/spotify/united-kingdom', 'the United Kingdom'],
      ['/prices/spotify/united-states', 'the United States'],
    ],
  );
  assert.ok(fresh.every((entry) => entry.first_published_on === '2026-12-01'));
  assert.deepEqual(
    newPublishedUrls({ urls: [...data.ledger.urls, ...fresh] }, candidates),
    [],
  );
  const written = serialisePublishedUrls({ urls: fresh });
  assert.equal(written, serialisePublishedUrls(JSON.parse(written)));
  assert.ok(written.endsWith('}\n'));
});

test('a published slug never changes: the ledger reports a configured pair whose path has moved', async () => {
  const data = await dataset();
  assert.deepEqual(
    ledgerPathConflicts(data.ledger, data.catalogue, data.markets),
    [],
  );
  data.markets.markets.find((market) => market.code === 'SE')!.slug = 'sverige';
  assert.deepEqual(
    ledgerPathConflicts(data.ledger, data.catalogue, data.markets).map(
      (conflict) => [conflict.entry.path, conflict.expected],
    ),
    [['/prices/spotify/sweden', '/prices/spotify/sverige']],
  );
});

test('the ledger schema refuses a malformed entry, a path naming another service and a duplicate URL', () => {
  const entry = {
    path: '/prices/spotify/sweden',
    service_id: 'spotify',
    market: 'SE',
    service_name: 'Spotify Premium',
    market_name: 'Sweden',
    first_published_on: '2026-12-01',
  };
  assert.equal(
    publishedUrlsFileSchema.safeParse({ urls: [entry] }).success,
    true,
  );
  for (const urls of [
    [{ ...entry, path: '/prices/spotify' }],
    [{ ...entry, path: '/prices/Spotify/sweden' }],
    [{ ...entry, service_id: 'netflix' }],
    [{ ...entry, market: 'se' }],
    [{ ...entry, service_name: '' }],
    [{ ...entry, first_published_on: '2026-13-01' }],
    [{ ...entry, retired_to: '/prices' }],
    [entry, entry],
  ]) {
    assert.equal(
      publishedUrlsFileSchema.safeParse({ urls }).success,
      false,
      JSON.stringify(urls),
    );
  }
});

test('a market name in a sentence must contain the name', () => {
  const market = {
    code: 'US',
    name: 'United States',
    slug: 'united-states',
    currency: 'USD',
    enabled: true,
  };
  assert.equal(
    marketsFileSchema.safeParse({
      markets: [{ ...market, name_in_sentence: 'the United States' }],
    }).success,
    true,
  );
  assert.equal(
    marketsFileSchema.safeParse({ markets: [market] }).success,
    true,
  );
  assert.equal(
    marketsFileSchema.safeParse({
      markets: [{ ...market, name_in_sentence: 'America' }],
    }).success,
    false,
  );
});

async function writeRun(
  rawRoot: string,
  observations: RunObservationsFile,
): Promise<void> {
  await mkdir(runDirectory(rawRoot, observations.run_id), { recursive: true });
  await writeRunObservations(rawRoot, observations);
}

function spotifySweden(runId: string, observedAt: string): RunObservationsFile {
  return {
    run_id: runId,
    source: scraper,
    observed_at: observedAt,
    fetch_status: 'completed',
    market_scope: null,
    pages_fetched: 1,
    observations: [
      observation({
        price_local: '149.00',
        price_source_text: 'kr 149',
        observed_at: observedAt,
      }),
    ],
    gaps: [],
    untracked: [],
    price_moves: null,
    failures: [],
  };
}

test('build-data appends each newly generated page to the ledger once, and validate guards the ledger', async (t) => {
  const space = await priceIndexWorkspace({
    services: ['spotify'],
    markets: ['SE'],
  });
  t.after(() => space.dispose());
  const ledgerPath = join(space.dataDirectory, 'published-urls.json');
  assert.deepEqual(await readPublishedUrls(ledgerPath), { urls: [] });

  await writeRun(
    space.rawRoot,
    spotifySweden('20261201T093000Z', '2026-12-01T09:30:00.000Z'),
  );
  let result = await space.cli(['build-data'], {
    clock: clockAt('2026-12-01T10:00:00.000Z'),
  });
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /data\/price-index\/published-urls\.json/u);
  assert.deepEqual(await readPublishedUrls(ledgerPath), {
    urls: [
      {
        path: '/prices/spotify/sweden',
        service_id: 'spotify',
        market: 'SE',
        service_name: 'Spotify Premium',
        market_name: 'Sweden',
        first_published_on: '2026-12-01',
      },
    ],
  });

  // A rebuild appends nothing.
  const text = await readFile(ledgerPath, 'utf8');
  result = await space.cli(['build-data'], {
    clock: clockAt('2026-12-01T11:00:00.000Z'),
  });
  assert.equal(result.status, 0, result.err);
  assert.doesNotMatch(result.out, /published-urls\.json/u);
  assert.equal(await readFile(ledgerPath, 'utf8'), text);
  assert.equal((await space.cli(['validate'])).status, 0);

  // Renaming the market's slug would move a published URL: refused.
  const marketsPath = join(space.root, 'config/markets.json');
  const markets = JSON.parse(
    await readFile(marketsPath, 'utf8'),
  ) as MarketsFile;
  markets.markets.find((market) => market.code === 'SE')!.slug = 'sverige';
  await writeFile(marketsPath, `${JSON.stringify(markets, null, 2)}\n`);
  const validate = await space.cli(['validate']);
  assert.equal(validate.status, 3);
  assert.match(
    validate.err,
    /published-urls\.json \(urls\.0\.path\): \/prices\/spotify\/sweden was published, but the configuration now gives spotify in SE the path \/prices\/spotify\/sverige/u,
  );
});

test('build-data refuses an invalid ledger and writes nothing', async (t) => {
  const space = await priceIndexWorkspace({
    services: ['spotify'],
    markets: ['SE'],
  });
  t.after(() => space.dispose());
  await writeRun(
    space.rawRoot,
    spotifySweden('20261201T093000Z', '2026-12-01T09:30:00.000Z'),
  );
  await writeFile(
    join(space.dataDirectory, 'published-urls.json'),
    '{ "urls": [{ "path": "/prices/spotify" }] }\n',
  );
  const result = await space.cli(['build-data'], {
    clock: clockAt('2026-12-01T10:00:00.000Z'),
  });
  assert.equal(result.status, 3);
  assert.match(result.err, /published-urls\.json/u);
  await assert.rejects(readFile(join(space.dataDirectory, 'latest.json')));
});

test('appendPublishedUrls adds at the end and refuses a URL the ledger already holds', async (t) => {
  const space = await priceIndexWorkspace();
  t.after(() => space.dispose());
  const ledgerPath = join(space.dataDirectory, 'published-urls.json');
  const data = await dataset();
  await appendPublishedUrls(ledgerPath, data.ledger.urls.slice(0, 2));
  await appendPublishedUrls(ledgerPath, data.ledger.urls.slice(2));
  assert.deepEqual(await readPublishedUrls(ledgerPath), data.ledger);
  await assert.rejects(
    appendPublishedUrls(ledgerPath, [data.ledger.urls[0]!]),
    /duplicate URL/u,
  );
  assert.deepEqual(await readPublishedUrls(ledgerPath), data.ledger);
});
