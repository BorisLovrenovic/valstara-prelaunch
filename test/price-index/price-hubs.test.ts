import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  isRetirement,
  publishedUrlsFileSchema,
  type CatalogueFile,
  type ChangesFile,
  type LatestFile,
  type MarketsFile,
  type PublishedUrlsFile,
  type ValstaraPricesFile,
} from '../../packages/price-index/src/schema/index.ts';
import { serialisePublishedUrls } from '../../packages/price-index/src/storage/index.ts';
import { pricesCopy } from '../../src/copy/prices.ts';
import {
  createPriceSite,
  type GeneratedPriceRoute,
  type MarketHub,
  type PriceSite,
  type ServiceHub,
  type ServiceHubPlan,
  type ServiceHubRow,
} from '../../src/server/prices/site.ts';
import { projectRoot } from '../helpers/price-index-run.ts';

// E11.6-12: the service hub, the market hub and `/prices`, at the view-model
// layer, over the price-page fixture dataset (test/fixtures/price-index/
// pages/): eight generated pages, four unavailable ledger URLs and one
// retired URL. The rendered hubs, the 301 and the footer link are in
// test/price-hubs-rendered.test.mjs; `retire-url` is in retire-url.test.ts.

const fixtureDirectory = join(projectRoot, 'test/fixtures/price-index/pages');

interface Dataset {
  latest: LatestFile | null;
  catalogue: CatalogueFile;
  markets: MarketsFile;
  ledger: PublishedUrlsFile;
  changes: ChangesFile;
  valstaraPrices: ValstaraPricesFile;
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
  };
}

function serviceHubOf(site: PriceSite, path: string): ServiceHub {
  const hub = site.hub(path);
  assert.ok(hub?.kind === 'service-hub', `${path} is a service hub`);
  return hub;
}

function marketHubOf(site: PriceSite, path: string): MarketHub {
  const hub = site.hub(path);
  assert.ok(hub?.kind === 'market-hub', `${path} is a market hub`);
  return hub;
}

/** Every link a hub or `/prices` renders, by path. */
function hubLinks(site: PriceSite): string[] {
  return [
    ...site.hubs.flatMap((hub) =>
      hub.kind === 'service-hub'
        ? hub.plans.flatMap((plan) => plan.rows.map((row) => row.path))
        : hub.categories.flatMap((category) =>
            category.rows.map((row) => row.path),
          ),
    ),
    ...site.index.services.flatMap((group) =>
      group.links.map((link) => link.path),
    ),
    ...site.index.markets.map((link) => link.path),
    ...site.hubs.flatMap((hub) =>
      hub.breadcrumbs.map((crumb) => new URL(crumb.url).pathname),
    ),
  ];
}

const servedHubs = [
  '/prices/apple-music',
  '/prices/countries/france',
  '/prices/countries/sweden',
  '/prices/countries/united-kingdom',
  '/prices/countries/united-states',
  '/prices/duolingo',
  '/prices/netflix',
  '/prices/spotify',
];

test('a hub exists exactly for each service and market with a generated page, and its sitemap lists exactly those', async () => {
  const site = createPriceSite(await dataset());
  assert.deepEqual(
    site.hubs.map((hub) => hub.path),
    servedHubs,
  );
  // ChatGPT (stale only), Crunchyroll (left the catalogue), Germany (missing)
  // and Norway (a conflict) have no page, so no hub.
  for (const path of [
    '/prices/chatgpt',
    '/prices/crunchyroll',
    '/prices/countries/germany',
    '/prices/countries/norway',
    '/prices/countries',
  ]) {
    assert.equal(site.hub(path), null, path);
  }
  assert.deepEqual(site.hubSitemaps.services, [
    { path: '/prices/apple-music', lastmod: '2026-11-21' },
    { path: '/prices/duolingo', lastmod: '2026-11-26' },
    { path: '/prices/netflix', lastmod: '2026-11-27' },
    { path: '/prices/spotify', lastmod: '2026-11-28' },
  ]);
  assert.deepEqual(site.hubSitemaps.markets, [
    { path: '/prices/countries/france', lastmod: '2026-11-26' },
    { path: '/prices/countries/sweden', lastmod: '2026-11-28' },
    { path: '/prices/countries/united-kingdom', lastmod: '2026-11-28' },
    { path: '/prices/countries/united-states', lastmod: '2026-11-27' },
  ]);
  assert.deepEqual(site.hubSitemaps.index, [
    { path: '/prices', lastmod: '2026-11-28' },
  ]);
  // Each hub's lastmod is the newest verification date among its rows.
  for (const hub of site.hubs) {
    const dates =
      hub.kind === 'service-hub'
        ? hub.plans.flatMap((plan) => plan.rows.map((row) => row.verifiedOn))
        : hub.categories.flatMap((category) =>
            category.rows.map((row) => row.verifiedOn),
          );
    assert.equal(hub.lastmod, dates.sort().at(-1), hub.path);
  }
});

test('the service hub lists every market whose page publishes a plan, and leaves out every unpublished record', async () => {
  const site = createPriceSite(await dataset());
  // Netflix: Basic in Sweden (ok), Standard in the United States (ok; the
  // Swedish Standard is needs_review), Premium in Sweden (an approved
  // manual override, with no USD figure).
  const netflix = serviceHubOf(site, '/prices/netflix');
  assert.deepEqual(
    netflix.plans.map((plan) => [
      plan.planId,
      plan.rows.map((row) => [row.market, row.priceText, row.path]),
    ]),
    [
      ['basic', [['SE', '99.00 SEK', '/prices/netflix/sweden']]],
      ['standard', [['US', '17.99 USD', '/prices/netflix/united-states']]],
      ['premium', [['SE', '229.00 SEK', '/prices/netflix/sweden']]],
    ],
  );
  assert.equal(netflix.heading, 'Netflix prices by country (November 2026)');
  assert.equal(
    netflix.verifiedLine,
    pricesCopy.page.verifiedBetween('2026-11-20', '2026-11-27'),
  );
  // One market per plan: no order to explain.
  assert.ok(netflix.plans.every((plan) => plan.orderNote === null));
  // Duolingo in France: Super only; Max is stale.
  assert.deepEqual(
    serviceHubOf(site, '/prices/duolingo').plans.map((plan) => plan.planId),
    ['super'],
  );
});

test('the market hub lists every service with a page there, by category in catalogue order, with each published plan', async () => {
  const site = createPriceSite(await dataset());
  const sweden = marketHubOf(site, '/prices/countries/sweden');
  assert.deepEqual(
    sweden.categories.map((category) => [
      category.heading,
      category.rows.map((row) => [row.planLabel, row.priceText, row.path]),
    ]),
    [
      [
        'Music',
        [
          [
            'Apple Music — Individual',
            '129.00 SEK',
            '/prices/apple-music/sweden',
          ],
          [
            'Spotify Premium — Individual',
            '149.00 SEK',
            '/prices/spotify/sweden',
          ],
        ],
      ],
      [
        'Streaming',
        [
          ['Netflix — Basic', '99.00 SEK', '/prices/netflix/sweden'],
          ['Netflix — Premium (4K)', '229.00 SEK', '/prices/netflix/sweden'],
        ],
      ],
    ],
  );
  assert.equal(
    marketHubOf(site, '/prices/countries/united-states').heading,
    'Subscription prices in the United States (November 2026)',
  );
  // The United Kingdom's ChatGPT is stale and its Apple Music needs review:
  // only Spotify is listed.
  assert.deepEqual(
    marketHubOf(site, '/prices/countries/united-kingdom').categories.map(
      (category) => category.rows.map((row) => row.serviceId),
    ),
    [['spotify']],
  );
});

test('/prices lists the service hubs by category and the market hubs by name, and is empty with no page', async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  assert.deepEqual(
    site.index.services.map((group) => [
      group.heading,
      group.links.map((link) => [link.path, link.label]),
    ]),
    [
      [
        'Music',
        [
          ['/prices/apple-music', 'Apple Music'],
          ['/prices/spotify', 'Spotify Premium'],
        ],
      ],
      ['Learning', [['/prices/duolingo', 'Duolingo']]],
      ['Streaming', [['/prices/netflix', 'Netflix']]],
    ],
  );
  assert.deepEqual(
    site.index.markets.map((link) => [link.path, link.label]),
    [
      ['/prices/countries/france', 'France'],
      ['/prices/countries/sweden', 'Sweden'],
      ['/prices/countries/united-kingdom', 'United Kingdom'],
      ['/prices/countries/united-states', 'United States'],
    ],
  );
  assert.equal(site.index.empty, null);
  assert.equal(
    site.index.verifiedLine,
    pricesCopy.page.verifiedBetween('2026-11-20', '2026-11-28'),
  );

  // Before the first build of data: no hub, an honest empty index, and no
  // sitemap entry for any of them.
  const empty = createPriceSite({ ...data, latest: null });
  assert.deepEqual(empty.hubs, []);
  assert.equal(empty.index.empty, pricesCopy.hubs.index.empty);
  assert.deepEqual(empty.index.services, []);
  assert.deepEqual(empty.index.markets, []);
  assert.equal(empty.index.lastmod, null);
  assert.deepEqual(empty.hubSitemaps, {
    index: [],
    services: [],
    markets: [],
  });
});

test('every link on a hub and on /prices resolves to a generated page or a hub', async () => {
  const site = createPriceSite(await dataset());
  const links = hubLinks(site);
  assert.ok(links.length > 20);
  for (const path of links) {
    const page = site.route(path);
    assert.ok(
      path === '/' ||
        path === '/prices' ||
        site.hub(path) !== null ||
        page?.kind === 'generated',
      `${path} resolves to a generated page or a hub`,
    );
    assert.equal(site.redirect(path), null, `${path} is not retired`);
  }
  // No hub links an unavailable ledger URL.
  for (const route of site.routes.filter(
    (item) => item.kind === 'unavailable',
  )) {
    assert.ok(!links.includes(route.path), route.path);
  }
});

test('every service × market page links to both of its hubs; an unavailable one to those that exist', async () => {
  const site = createPriceSite(await dataset());
  for (const route of site.routes) {
    for (const link of route.hubLinks) {
      assert.notEqual(
        site.hub(link.path),
        null,
        `${route.path} → ${link.path}`,
      );
    }
    if (route.kind === 'generated') {
      const slug = route.path.split('/')[3];
      assert.deepEqual(
        route.hubLinks.map((link) => link.path),
        [`/prices/${route.serviceId}`, `/prices/countries/${slug}`],
        route.path,
      );
    }
  }
  const links = (path: string) =>
    site.route(path)?.hubLinks.map((link) => [link.path, link.label]);
  assert.deepEqual(links('/prices/spotify/united-states'), [
    ['/prices/spotify', 'Spotify Premium prices by country'],
    [
      '/prices/countries/united-states',
      'Subscription prices in the United States',
    ],
  ]);
  // Crunchyroll has left the catalogue: only Sweden's market hub remains.
  assert.deepEqual(links('/prices/crunchyroll/sweden'), [
    ['/prices/countries/sweden', 'Subscription prices in Sweden'],
  ]);
  // Spotify has no page in Finland, so Finland has no hub.
  assert.deepEqual(links('/prices/spotify/finland'), [
    ['/prices/spotify', 'Spotify Premium prices by country'],
  ]);
});

test('the service hub order agrees with every page’s own rank sentence, across the fixture dataset', async () => {
  const site = createPriceSite(await dataset());
  let compared = 0;
  for (const route of site.routes) {
    if (route.kind !== 'generated') continue;
    for (const comparison of (route as GeneratedPriceRoute).comparisons) {
      const plan: ServiceHubPlan | undefined = serviceHubOf(
        site,
        `/prices/${route.serviceId}`,
      ).plans.find(
        (item) =>
          item.planId === comparison.planId &&
          item.billingPeriod === comparison.billingPeriod,
      );
      assert.ok(plan, `${route.path} ${comparison.planId} is on its hub`);
      const rows: readonly ServiceHubRow[] = plan.rows;
      const ranked = rows.filter((item) => item.rank !== null);
      const row: ServiceHubRow | undefined = rows.find(
        (item) => item.market === route.market,
      );
      // The hub ranks the market exactly as the page's sentence does…
      assert.equal(row?.rank, comparison.rank, route.path);
      assert.equal(ranked.length, comparison.rankedMarkets, route.path);
      // …and lists the ranked markets in that order, before any unranked.
      assert.equal(
        ranked.filter((other) => other.rank! < comparison.rank).length,
        comparison.rank - 1,
        route.path,
      );
      assert.deepEqual(
        plan.rows.slice(0, ranked.length),
        ranked,
        `${route.path}: ranked markets come first`,
      );
      compared += 1;
    }
  }
  // Spotify Premium — Individual is ranked in Sweden, the United Kingdom and
  // the United States.
  assert.equal(compared, 3);
  assert.deepEqual(
    serviceHubOf(site, '/prices/spotify').plans[0]!.rows.map((row) => [
      row.market,
      row.rank,
    ]),
    [
      ['SE', 1],
      ['GB', 2],
      ['US', 3],
      ['FR', null],
    ],
  );
});

test('unranked markets follow the ranked ones, alphabetically by name, not by code', async () => {
  const data = await dataset();
  // Sweden and the United Kingdom lose their USD figures: only the United
  // States stays ranked. By name: France, Sweden, United Kingdom (by code
  // it would be FR, GB, SE).
  for (const record of data.latest!.records) {
    if (
      record.service_id === 'spotify' &&
      (record.market === 'SE' || record.market === 'GB')
    ) {
      record.price_usd_source = null;
    }
  }
  const spotify = serviceHubOf(createPriceSite(data), '/prices/spotify');
  assert.deepEqual(
    spotify.plans[0]!.rows.map((row) => [row.market, row.rank]),
    [
      ['US', 1],
      ['FR', null],
      ['SE', null],
      ['GB', null],
    ],
  );
  assert.equal(
    spotify.plans[0]!.orderNote,
    pricesCopy.hubs.service.orderNote(1, 3),
  );

  // With nothing ranked, the whole table is alphabetical.
  for (const record of data.latest!.records) {
    if (record.service_id === 'spotify') record.price_usd_source = null;
  }
  const unranked = serviceHubOf(createPriceSite(data), '/prices/spotify');
  assert.deepEqual(
    unranked.plans[0]!.rows.map((row) => row.marketName),
    ['France', 'Sweden', 'United Kingdom', 'United States'],
  );
  assert.equal(
    unranked.plans[0]!.orderNote,
    pricesCopy.hubs.service.orderNote(0, 4),
  );
});

test('no hub shows a USD figure or a converted price: every price is its market’s own published record', async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  const currencyOf = new Map(
    data.markets.markets.map((market) => [market.code, market.currency]),
  );
  const records = data.latest!.records;
  const published = (market: string, service: string, plan: string) =>
    records.find(
      (record) =>
        record.market === market &&
        record.service_id === service &&
        record.plan_id === plan &&
        (record.status === 'ok' || record.status === 'manual_override'),
    );
  for (const hub of site.hubs) {
    const rows =
      hub.kind === 'service-hub'
        ? hub.plans.flatMap((plan) =>
            plan.rows.map((row) => ({
              ...row,
              service: hub.serviceId,
            })),
          )
        : hub.categories.flatMap((category) =>
            category.rows.map((row) => ({
              ...row,
              service: row.serviceId,
              market: hub.market,
            })),
          );
    for (const row of rows) {
      const record = published(row.market, row.service, row.planId);
      assert.ok(
        record,
        `${hub.path}: ${row.market}/${row.planId} is published`,
      );
      assert.equal(row.amount, record.price_local);
      assert.equal(row.currency, currencyOf.get(row.market));
      assert.equal(row.priceText, `${record.price_local} ${record.currency}`);
    }
    // The source's USD figures appear nowhere, except where a US price is
    // itself the figure (12.99 and 17.99 USD are US list prices).
    const text = JSON.stringify(hub);
    for (const record of records) {
      if (record.price_usd_source !== null && record.currency !== 'USD') {
        assert.ok(
          !text.includes(record.price_usd_source),
          `${hub.path} shows ${record.price_usd_source}`,
        );
      }
    }
    assert.doesNotMatch(text, /price_usd_source|\$/u, hub.path);
  }
  // USD appears only on United States rows.
  for (const hub of site.hubs) {
    if (hub.kind === 'service-hub') {
      for (const row of hub.plans.flatMap((plan) => plan.rows)) {
        assert.equal(row.currency === 'USD', row.market === 'US', hub.path);
      }
    } else {
      assert.equal(
        hub.categories.some((category) =>
          category.rows.some((row) => row.currency === 'USD'),
        ),
        hub.market === 'US',
        hub.path,
      );
    }
  }
});

test('a retired URL answers its hub, is no page, and leaves every hub, related link and sitemap', async () => {
  const data = await dataset();
  // The fixture's retired URL: Crunchyroll in the United States.
  let site = createPriceSite(data);
  assert.equal(
    site.redirect('/prices/crunchyroll/united-states'),
    '/prices/countries/united-states',
  );
  assert.equal(site.route('/prices/crunchyroll/united-states'), null);
  assert.equal(site.redirect('/prices/spotify/sweden'), null);

  // A retired URL whose data publishes again stays retired: Spotify in
  // France is no longer a page, a hub row, a related link or a sitemap entry.
  data.ledger.urls.push(
    {
      path: '/prices/spotify/france',
      service_id: 'spotify',
      market: 'FR',
      service_name: 'Spotify Premium',
      market_name: 'France',
      first_published_on: '2026-11-01',
    },
    {
      kind: 'retired',
      path: '/prices/spotify/france',
      to: '/prices/spotify',
      actor: 'Founder',
      retired_on: '2026-12-02',
    },
  );
  site = createPriceSite(data);
  assert.equal(site.redirect('/prices/spotify/france'), '/prices/spotify');
  assert.equal(site.route('/prices/spotify/france'), null);
  assert.ok(
    !site.sitemap.some((entry) => entry.path === '/prices/spotify/france'),
  );
  assert.ok(!hubLinks(site).includes('/prices/spotify/france'));
  assert.deepEqual(
    serviceHubOf(site, '/prices/spotify').plans[0]!.rows.map(
      (row) => row.market,
    ),
    ['SE', 'GB', 'US'],
  );
  // France keeps its hub for Duolingo.
  assert.deepEqual(
    marketHubOf(site, '/prices/countries/france').categories.flatMap(
      (category) => category.rows.map((row) => row.serviceId),
    ),
    ['duolingo'],
  );
});

test('the ledger takes a retirement after its publication, at most once, to a hub, with an actor', async () => {
  const ledger = await fixture<PublishedUrlsFile>('published-urls.json');
  assert.equal(publishedUrlsFileSchema.safeParse(ledger).success, true);
  const publication = ledger.urls.find((entry) => !isRetirement(entry))!;
  const retirement = {
    kind: 'retired',
    path: publication.path,
    to: '/prices/countries/united-states',
    actor: 'Founder',
    retired_on: '2026-12-01',
  };
  const accepts = (urls: unknown[]) =>
    publishedUrlsFileSchema.safeParse({ urls }).success;
  assert.equal(accepts([publication, retirement]), true);
  assert.equal(
    accepts([publication, { ...retirement, to: '/prices/spotify' }]),
    true,
  );
  // Before its publication, twice, or for a URL never published.
  assert.equal(accepts([retirement, publication]), false);
  assert.equal(accepts([publication, retirement, retirement]), false);
  assert.equal(
    accepts([publication, { ...retirement, path: '/prices/notion/sweden' }]),
    false,
  );
  // `to` must be a hub.
  for (const to of [
    '/prices',
    '/prices/countries',
    '/prices/spotify/sweden',
    '/prices/Spotify',
    'https://valstara.com/prices/spotify',
    '/price-index',
  ]) {
    assert.equal(accepts([publication, { ...retirement, to }]), false, to);
  }
  // An actor, a date and no other field.
  assert.equal(accepts([publication, { ...retirement, actor: '' }]), false);
  assert.equal(accepts([publication, { ...retirement, actor: ' ' }]), false);
  const withoutActor: Partial<typeof retirement> = { ...retirement };
  delete withoutActor.actor;
  assert.equal(accepts([publication, withoutActor]), false);
  assert.equal(
    accepts([publication, { ...retirement, retired_on: '1 December' }]),
    false,
  );
  assert.equal(accepts([publication, { ...retirement, note: 'x' }]), false);
  // A publication entry keeps its E11.6-10 shape: no `kind`.
  assert.equal(accepts([{ ...publication, kind: 'published' }]), false);

  // Each kind is written with its own fixed key order.
  const parsed = publishedUrlsFileSchema.parse({
    urls: [
      publication,
      {
        retired_on: '2026-12-01',
        actor: 'Founder',
        to: retirement.to,
        path: retirement.path,
        kind: 'retired',
      },
    ],
  });
  const written = JSON.parse(serialisePublishedUrls(parsed)) as {
    urls: object[];
  };
  assert.deepEqual(Object.keys(written.urls[1]!), [
    'kind',
    'path',
    'to',
    'actor',
    'retired_on',
  ]);
  assert.deepEqual(Object.keys(written.urls[0]!), [
    'path',
    'service_id',
    'market',
    'service_name',
    'market_name',
    'first_published_on',
  ]);
});

test('adding or removing a service or a market changes the hubs with no code change', async () => {
  const base = await dataset();
  const spotifySweden = base.latest!.records.find(
    (record) => record.service_id === 'spotify' && record.market === 'SE',
  )!;

  // Added: Notion (productivity) in Sweden, and the Netherlands for Spotify.
  const added = structuredClone(base);
  // Notion takes ChatGPT's shape (one monthly plan, "plus"), in its own
  // category.
  added.catalogue.services.push({
    ...structuredClone(
      added.catalogue.services.find(
        (service) => service.service_id === 'chatgpt',
      )!,
    ),
    service_id: 'notion',
    name: 'Notion',
    category: 'productivity',
    source_aliases: { service: [], plans: {} },
  });
  added.markets.markets.push({
    code: 'NL',
    name: 'Netherlands',
    name_in_sentence: 'the Netherlands',
    slug: 'netherlands',
    currency: 'EUR',
    enabled: true,
  });
  added.latest!.records.push(
    {
      ...structuredClone(spotifySweden),
      service_id: 'notion',
      plan_id: 'plus',
      price_local: '110.00',
      price_source_text: '110 kr',
      price_usd_source: '12.39',
      source_verified_at: '2026-11-24',
    },
    {
      ...structuredClone(spotifySweden),
      market: 'NL',
      currency: 'EUR',
      price_local: '11.99',
      price_source_text: '€11.99',
      price_usd_source: '13.98',
      source_verified_at: '2026-11-29',
    },
  );
  const grown = createPriceSite(added);
  assert.deepEqual(
    grown.hubs.map((hub) => hub.path),
    [
      '/prices/apple-music',
      '/prices/countries/france',
      '/prices/countries/netherlands',
      '/prices/countries/sweden',
      '/prices/countries/united-kingdom',
      '/prices/countries/united-states',
      '/prices/duolingo',
      '/prices/netflix',
      '/prices/notion',
      '/prices/spotify',
    ],
  );
  assert.deepEqual(
    marketHubOf(grown, '/prices/countries/sweden').categories.map(
      (category) => category.category,
    ),
    ['music', 'streaming', 'productivity'],
  );
  assert.deepEqual(
    serviceHubOf(grown, '/prices/spotify').plans[0]!.rows.map((row) => [
      row.market,
      row.rank,
    ]),
    [
      ['SE', 1],
      ['GB', 2],
      ['NL', 3],
      ['US', 4],
      ['FR', null],
    ],
  );
  assert.ok(
    grown.index.markets.some(
      (link) => link.path === '/prices/countries/netherlands',
    ),
  );
  assert.ok(
    grown.index.services.some((group) =>
      group.links.some((link) => link.path === '/prices/notion'),
    ),
  );
  assert.ok(
    grown.hubSitemaps.markets.some(
      (entry) =>
        entry.path === '/prices/countries/netherlands' &&
        entry.lastmod === '2026-11-29',
    ),
  );

  // Removed: Spotify from the catalogue, and the United States from the
  // markets. The United Kingdom had only Spotify, so its hub goes too.
  const removed = structuredClone(base);
  removed.catalogue.services = removed.catalogue.services.filter(
    (service) => service.service_id !== 'spotify',
  );
  removed.markets.markets = removed.markets.markets.filter(
    (market) => market.code !== 'US',
  );
  // The fixture's Valstara prices are all Spotify's, which the configuration
  // check would refuse once Spotify is gone.
  removed.valstaraPrices.prices = [];
  const shrunk = createPriceSite(removed);
  assert.deepEqual(
    shrunk.hubs.map((hub) => hub.path),
    [
      '/prices/apple-music',
      '/prices/countries/france',
      '/prices/countries/sweden',
      '/prices/duolingo',
      '/prices/netflix',
    ],
  );
  assert.deepEqual(
    serviceHubOf(shrunk, '/prices/netflix').plans.map((plan) => plan.planId),
    ['basic', 'premium'],
  );
  assert.ok(!hubLinks(shrunk).some((path) => path.includes('spotify')));
  assert.deepEqual(
    shrunk.index.markets.map((link) => link.label),
    ['France', 'Sweden'],
  );
});
