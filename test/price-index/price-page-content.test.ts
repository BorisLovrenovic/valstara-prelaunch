import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { rankMarkets } from '../../packages/price-index/src/publish/index.ts';
import type {
  CatalogueFile,
  ChangesFile,
  LatestFile,
  MarketsFile,
  PublishedUrlsFile,
  ValstaraPricesFile,
} from '../../packages/price-index/src/schema/index.ts';
import { pricesCopy } from '../../src/copy/prices.ts';
import { campaignFlagRegistry } from '../../src/server/flags/registry.ts';
import {
  createPriceSite,
  PriceDataError,
  type GeneratedPriceRoute,
  type PriceSite,
} from '../../src/server/prices/site.ts';
import { faqPageIssues } from '../helpers/faq-page-data.mjs';
import { projectRoot } from '../helpers/price-index-run.ts';

// E11.6-11: the service × market page's content blocks — price history, the
// cross-market comparison, related services, the FAQ and the Valstara price
// — at the view-model layer, over the fixture dataset in
// test/fixtures/price-index/pages/. Every expectation is written by hand
// from the fixture files, never from the code's own output. The served HTML
// is covered by test/price-pages-rendered.test.mjs.
//
// The dataset, as far as these blocks read it:
// - Spotify Premium — Individual: ok in SE (USD 16.78), GB (15.19) and US
//   (12.99); a manual override in FR without a USD figure (unranked); a
//   conflict in NO and a missing record in DE (both left out by the gate).
// - Netflix in SE: Basic ok, Premium (4K) an override without a USD figure,
//   Standard needs_review. Apple Music: ok in SE, needs_review in GB.
// - changes.json: six real changes, two of them for plans the gate leaves
//   off their page (Netflix Standard in SE, Duolingo Max in FR).
// - valstara-prices.json: like-for-like and term-basis entries, one for an
//   unpublished plan and one not below the list price.

const fixtureDirectory = join(projectRoot, 'test/fixtures/price-index/pages');

interface Dataset {
  latest: LatestFile;
  catalogue: CatalogueFile;
  markets: MarketsFile;
  ledger: PublishedUrlsFile;
  changes: ChangesFile;
  valstaraPrices: ValstaraPricesFile;
}

async function dataset(): Promise<Dataset> {
  const read = async (name: string) =>
    JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8'));
  return {
    latest: await read('latest.json'),
    catalogue: await read('catalogue.json'),
    markets: await read('markets.json'),
    ledger: await read('published-urls.json'),
    changes: await read('changes.json'),
    valstaraPrices: await read('valstara-prices.json'),
  };
}

function page(site: PriceSite, path: string): GeneratedPriceRoute {
  const route = site.route(path);
  assert.equal(route?.kind, 'generated', path);
  return route as GeneratedPriceRoute;
}

const spotify = 'Spotify Premium — Individual';

test('history: the real changes of the shown plans, newest first, in the market currency', async () => {
  const site = createPriceSite(await dataset());
  assert.deepEqual(
    page(site, '/prices/spotify/sweden').history.map((item) => [
      item.planName,
      item.direction,
      item.oldAmount,
      item.newAmount,
      item.currency,
      item.detectedOn,
      item.text,
    ]),
    [
      [
        'Individual',
        'raised',
        '129.00',
        '149.00',
        'SEK',
        '2026-10-02',
        'Raised from 129.00 SEK to 149.00 SEK in October 2026.',
      ],
      [
        'Individual',
        'raised',
        '119.00',
        '129.00',
        'SEK',
        '2026-03-03',
        'Raised from 119.00 SEK to 129.00 SEK in March 2026.',
      ],
    ],
  );
  // A fall. Netflix Standard's change (119.00 → 129.00) is not shown: the
  // plan is needs_review today, so the page shows no value of it.
  assert.deepEqual(
    page(site, '/prices/netflix/sweden').history.map((item) => item.text),
    ['Lowered from 109.00 SEK to 99.00 SEK in September 2026.'],
  );
  assert.deepEqual(
    page(site, '/prices/spotify/united-kingdom').history.map(
      (item) => item.text,
    ),
    ['Raised from 10.99 GBP to 11.99 GBP in July 2026.'],
  );
});

test('history: absent when there is none, and never for a plan the gate leaves off the page', async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  for (const path of [
    // Duolingo Max's change (27.99 → 29.99) is not shown: Max is stale.
    '/prices/duolingo/france',
    '/prices/netflix/united-states',
    '/prices/spotify/united-states',
    '/prices/spotify/france',
    '/prices/apple-music/sweden',
  ]) {
    assert.deepEqual(page(site, path).history, [], path);
  }
  const netflix = JSON.stringify(page(site, '/prices/netflix/sweden'));
  assert.ok(!netflix.includes('119.00') && !netflix.includes('139.00'));
  assert.ok(
    !JSON.stringify(page(site, '/prices/duolingo/france')).includes('27.99'),
  );

  // An entry in another currency than the record's is not this record's
  // history (a currency change is not a price change), and an empty change
  // log shows no history anywhere.
  const foreign = structuredClone(data);
  foreign.changes.changes.push({
    market: 'SE',
    service_id: 'apple-music',
    plan_id: 'individual',
    billing_period: 'month',
    old_price_local: '10.99',
    new_price_local: '11.99',
    currency: 'EUR',
    change_percent: '9.1',
    detected_on: '2026-11-02',
    source: 'scraper:youfundceo.com',
  });
  assert.deepEqual(
    page(createPriceSite(foreign), '/prices/apple-music/sweden').history,
    [],
  );
  const empty = structuredClone(data);
  empty.changes.changes = [];
  assert.ok(
    createPriceSite(empty).routes.every(
      (route) => route.kind !== 'generated' || route.history.length === 0,
    ),
  );
});

test('the rank sentence counts only the markets rankMarkets() ranks: a conflict, a missing record and an unranked override are left out', async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  // NO is a conflict, DE missing, FR an override without a USD figure.
  assert.deepEqual(
    rankMarkets(data.latest, {
      service_id: 'spotify',
      plan_id: 'individual',
      billing_period: 'month',
    }).map((ranked) => [ranked.market, ranked.rank]),
    [
      ['SE', 1],
      ['GB', 2],
      ['US', 3],
    ],
  );
  const expected: [string, number, string][] = [
    [
      '/prices/spotify/sweden',
      1,
      `Sweden is the most expensive of our 3 markets for ${spotify}.`,
    ],
    [
      '/prices/spotify/united-kingdom',
      2,
      `The United Kingdom is the 2nd most expensive of our 3 markets for ${spotify}.`,
    ],
    [
      '/prices/spotify/united-states',
      3,
      `The United States is the 3rd most expensive of our 3 markets for ${spotify}.`,
    ],
  ];
  for (const [path, rank, sentence] of expected) {
    const [comparison, ...rest] = page(site, path).comparisons;
    assert.deepEqual(rest, [], path);
    assert.equal(comparison?.rank, rank, path);
    assert.equal(comparison?.rankedMarkets, 3, path);
    assert.equal(comparison?.tied, false, path);
    assert.equal(comparison?.sentence, sentence, path);
    // The mini-table: the most expensive and the cheapest, each in its own
    // market's currency, exactly as the ranked record holds it.
    assert.deepEqual(comparison?.extremes, {
      mostExpensive: {
        market: 'SE',
        marketName: 'Sweden',
        amount: '149.00',
        currency: 'SEK',
        priceText: '149.00 SEK',
      },
      cheapest: {
        market: 'US',
        marketName: 'United States',
        amount: '12.99',
        currency: 'USD',
        priceText: '12.99 USD',
      },
    });
  }
  // Hidden when this market is unranked (France: no USD figure), and for a
  // plan ranked in one market only (Apple Music; Netflix Basic, where the US
  // is missing; Duolingo Super; Netflix Standard in the US). Netflix
  // Premium (4K) in Sweden has no USD figure.
  for (const path of [
    '/prices/spotify/france',
    '/prices/apple-music/sweden',
    '/prices/netflix/sweden',
    '/prices/netflix/united-states',
    '/prices/duolingo/france',
  ]) {
    assert.deepEqual(page(site, path).comparisons, [], path);
  }
});

test('ties share a rank and say so; a ranking with a market the configuration does not enable is not shown', async () => {
  const data = await dataset();
  const record = (market: string) =>
    data.latest.records.find(
      (item) => item.service_id === 'spotify' && item.market === market,
    )!;

  const tiedTop = structuredClone(data);
  tiedTop.latest.records.find(
    (item) => item.service_id === 'spotify' && item.market === 'GB',
  )!.price_usd_source = record('SE').price_usd_source;
  let site = createPriceSite(tiedTop);
  assert.equal(
    page(site, '/prices/spotify/sweden').comparisons[0]?.sentence,
    `Sweden is the joint most expensive of our 3 markets for ${spotify}.`,
  );
  assert.equal(
    page(site, '/prices/spotify/united-kingdom').comparisons[0]?.sentence,
    `The United Kingdom is the joint most expensive of our 3 markets for ${spotify}.`,
  );
  assert.equal(
    page(site, '/prices/spotify/united-states').comparisons[0]?.sentence,
    `The United States is the 3rd most expensive of our 3 markets for ${spotify}.`,
  );
  // The most expensive is the first by market code of rank 1.
  assert.equal(
    page(site, '/prices/spotify/united-states').comparisons[0]?.extremes
      ?.mostExpensive.market,
    'GB',
  );

  const tiedLower = structuredClone(data);
  tiedLower.latest.records.find(
    (item) => item.service_id === 'spotify' && item.market === 'US',
  )!.price_usd_source = record('GB').price_usd_source;
  site = createPriceSite(tiedLower);
  assert.equal(
    page(site, '/prices/spotify/united-states').comparisons[0]?.sentence,
    `The United States is the joint 2nd most expensive of our 3 markets for ${spotify}.`,
  );
  // The cheapest is the first by market code of the last rank.
  assert.equal(
    page(site, '/prices/spotify/sweden').comparisons[0]?.extremes?.cheapest
      .market,
    'GB',
  );

  // Every market tied: no extremes table, since none is cheaper.
  const allTied = structuredClone(tiedLower);
  allTied.latest.records.find(
    (item) => item.service_id === 'spotify' && item.market === 'SE',
  )!.price_usd_source = record('GB').price_usd_source;
  const flat = page(createPriceSite(allTied), '/prices/spotify/sweden')
    .comparisons[0];
  assert.equal(flat?.extremes, null);
  assert.equal(
    flat?.sentence,
    `Sweden is the joint most expensive of our 3 markets for ${spotify}.`,
  );

  // The US disabled in the configuration while latest.json still ranks it:
  // M would count a market we do not serve, so nothing is said.
  const disabled = structuredClone(data);
  disabled.markets.markets.find((market) => market.code === 'US')!.enabled =
    false;
  site = createPriceSite(disabled);
  assert.deepEqual(page(site, '/prices/spotify/sweden').comparisons, []);
  assert.deepEqual(
    page(site, '/prices/spotify/united-kingdom').comparisons,
    [],
  );
});

test('no USD figure is in any page: the view holds no price_usd_source, and a USD amount is only the US market price', async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  const serialised = JSON.stringify(site.routes);
  const figures = data.latest.records
    .filter((record) => record.currency !== 'USD')
    .flatMap((record) =>
      record.price_usd_source === null ? [] : [record.price_usd_source],
    );
  assert.ok(figures.length >= 9);
  for (const figure of figures) {
    assert.ok(!serialised.includes(figure), `${figure} leaked`);
  }
  assert.doesNotMatch(serialised, /price_usd_source|≈|\$|US\$/u);
  // Every USD amount on any page is a published US record's own price.
  const usPrices = new Set(
    data.latest.records
      .filter(
        (record) =>
          record.market === 'US' &&
          (record.status === 'ok' || record.status === 'manual_override'),
      )
      .map((record) => `${record.price_local} USD`),
  );
  for (const [amount] of serialised.matchAll(/\d+(?:\.\d+)? USD/gu)) {
    assert.ok(usPrices.has(amount), `${amount} is not a US list price`);
  }
});

test('related services: the same category in the same market, generated pages only', async () => {
  const site = createPriceSite(await dataset());
  assert.deepEqual(page(site, '/prices/spotify/sweden').related, [
    {
      path: '/prices/apple-music/sweden',
      serviceId: 'apple-music',
      label: 'Apple Music price in Sweden',
    },
  ]);
  assert.deepEqual(page(site, '/prices/apple-music/sweden').related, [
    {
      path: '/prices/spotify/sweden',
      serviceId: 'spotify',
      label: 'Spotify Premium price in Sweden',
    },
  ]);
  // Apple Music in the UK is needs_review (no page), and in the US only a
  // ledger URL without data (unavailable, noindex): neither is linked.
  assert.deepEqual(page(site, '/prices/spotify/united-kingdom').related, []);
  assert.deepEqual(page(site, '/prices/spotify/united-states').related, []);
  // Netflix in Sweden shares Sweden with two music services, not a category.
  assert.deepEqual(page(site, '/prices/netflix/sweden').related, []);
  // Every related link on every page resolves to a generated page.
  for (const route of site.routes) {
    if (route.kind !== 'generated') continue;
    for (const link of route.related) {
      assert.equal(site.route(link.path)?.kind, 'generated', link.path);
      assert.notEqual(link.path, route.path);
    }
  }
});

test('the FAQ asks only what the data answers, and its FAQPage data validates and matches it exactly', async () => {
  const site = createPriceSite(await dataset());
  assert.deepEqual(page(site, '/prices/spotify/sweden').faq, [
    {
      question: 'How much does Spotify Premium cost in Sweden?',
      answer: `${spotify} costs 149.00 SEK per month. Prices verified on 28 November 2026.`,
    },
    {
      question:
        'How does the Spotify Premium price in Sweden compare with other markets?',
      answer: `Sweden is the most expensive of our 3 markets for ${spotify}.`,
    },
    {
      question: 'Has the Spotify Premium price in Sweden changed?',
      answer: `${spotify} rose from 129.00 SEK to 149.00 SEK in October 2026.`,
    },
  ]);
  assert.deepEqual(page(site, '/prices/netflix/sweden').faq, [
    {
      question: 'How much does Netflix cost in Sweden?',
      answer:
        'Netflix — Basic costs 99.00 SEK per month. Netflix — Premium (4K) costs 229.00 SEK per month. Prices verified between 20 November 2026 and 25 November 2026.',
    },
    {
      question: 'Has the Netflix price in Sweden changed?',
      answer:
        'Netflix — Basic fell from 109.00 SEK to 99.00 SEK in September 2026.',
    },
  ]);
  // No comparison and no history: the price question only.
  assert.deepEqual(
    page(site, '/prices/spotify/france').faq.map((entry) => entry.question),
    ['How much does Spotify Premium cost in France?'],
  );

  for (const route of site.routes) {
    if (route.kind !== 'generated') {
      assert.ok(!('faq' in route), `${route.path} has no FAQ`);
      continue;
    }
    assert.ok(route.faq.length > 0);
    assert.deepEqual(faqPageIssues(route.faqStructuredData), [], route.path);
    assert.deepEqual(
      (
        route.faqStructuredData as {
          mainEntity: {
            name: string;
            acceptedAnswer: { text: string };
          }[];
        }
      ).mainEntity.map((entry) => ({
        question: entry.name,
        answer: entry.acceptedAnswer.text,
      })),
      route.faq,
      `${route.path}: the FAQPage data is exactly the visible FAQ`,
    );
  }
});

test('the FAQPage check refuses malformed data', () => {
  const valid = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'A question?',
        acceptedAnswer: { '@type': 'Answer', text: 'An answer.' },
      },
    ],
  };
  assert.deepEqual(faqPageIssues(valid), []);
  const question = valid.mainEntity[0]!;
  for (const broken of [
    null,
    { ...valid, '@type': 'WebPage' },
    { ...valid, '@context': 'http://schema.org' },
    { ...valid, mainEntity: [] },
    { ...valid, mainEntity: [{ ...question, name: ' ' }] },
    { ...valid, mainEntity: [question, question] },
    {
      ...valid,
      mainEntity: [{ ...question, acceptedAnswer: { '@type': 'Answer' } }],
    },
    {
      ...valid,
      mainEntity: [
        { ...question, acceptedAnswer: { '@type': 'Text', text: 'x' } },
      ],
    },
    { ...valid, mainEntity: [{ ...question, '@type': 'Thing' }] },
    { ...valid, mainEntity: [{ ...question, dateCreated: '2026-11-19' }] },
  ]) {
    assert.notDeepEqual(faqPageIssues(broken), [], JSON.stringify(broken));
  }
});

test('the Valstara comparison: like for like, or the monthly price × the term with the basis stated', async () => {
  const site = createPriceSite(await dataset());
  const rows = (path: string) =>
    page(site, path).valstara?.rows.map((row) => [
      row.planName,
      row.termText,
      row.listText,
      row.valstaraText,
      row.belowText,
      row.basis,
    ]);
  assert.deepEqual(rows('/prices/spotify/sweden'), [
    // (149.00 − 119.00) / 149.00 = 20.13…%
    [
      'Individual',
      '1 month',
      '149.00 SEK',
      '119.00 SEK',
      '20.1% below list price',
      null,
    ],
    // 12 × 149.00 = 1788.00; (1788.00 − 1490.00) / 1788.00 = 16.66…%,
    // floored, never rounded up.
    [
      'Individual',
      '12 months',
      '1788.00 SEK',
      '1490.00 SEK',
      '16.6% below list price',
      `For 12 months of ${spotify}, the list price shown is the monthly list price, 149.00 SEK, multiplied by 12.`,
    ],
  ]);
  assert.deepEqual(rows('/prices/spotify/united-kingdom'), [
    // 3 × 11.99 = 35.97; (35.97 − 33.00) / 35.97 = 8.25…%
    [
      'Individual',
      '3 months',
      '35.97 GBP',
      '33.00 GBP',
      '8.2% below list price',
      `For 3 months of ${spotify}, the list price shown is the monthly list price, 11.99 GBP, multiplied by 3.`,
    ],
  ]);
  // Netflix Standard's entry has no published list price (needs_review).
  assert.deepEqual(rows('/prices/netflix/sweden'), [
    [
      'Premium (4K)',
      '1 month',
      '229.00 SEK',
      '199.00 SEK',
      '13.1% below list price',
      null,
    ],
  ]);
  assert.equal(
    page(site, '/prices/spotify/sweden').valstara?.tableCaption,
    'Spotify Premium list prices and Valstara prices in Sweden',
  );
  // No entry, or an entry that is not below the list price (Duolingo Super
  // at 8.99 EUR, the list price itself): no comparison.
  for (const path of [
    '/prices/spotify/united-states',
    '/prices/spotify/france',
    '/prices/apple-music/sweden',
    '/prices/netflix/united-states',
    '/prices/duolingo/france',
  ]) {
    assert.equal(page(site, path).valstara, null, path);
  }
});

test('the Valstara comparison: no entry anywhere shows nothing; a yearly plan compares only a 12-month term; an inexact or foreign price publishes nothing', async () => {
  const data = await dataset();
  const empty = structuredClone(data);
  empty.valstaraPrices.prices = [];
  assert.ok(
    createPriceSite(empty).routes.every(
      (route) => route.kind !== 'generated' || route.valstara === null,
    ),
  );

  // Spotify Individual billed yearly: a 12-month entry is like for like; a
  // 1-month or 24-month entry has no stated basis, so it is not shown.
  const yearly = structuredClone(data);
  yearly.catalogue.services.find(
    (service) => service.service_id === 'spotify',
  )!.plans[0]!.billing_period = 'year';
  for (const record of yearly.latest.records) {
    if (record.service_id === 'spotify') record.billing_period = 'year';
  }
  for (const change of yearly.changes.changes) {
    if (change.service_id === 'spotify') change.billing_period = 'year';
  }
  yearly.valstaraPrices.prices = [
    {
      service_id: 'spotify',
      plan_id: 'individual',
      market: 'SE',
      term_months: 12,
      price_local: '129.50',
      currency: 'SEK',
    },
    {
      service_id: 'spotify',
      plan_id: 'individual',
      market: 'SE',
      term_months: 1,
      price_local: '9.00',
      currency: 'SEK',
    },
    {
      service_id: 'spotify',
      plan_id: 'individual',
      market: 'SE',
      term_months: 24,
      price_local: '200.00',
      currency: 'SEK',
    },
  ];
  assert.deepEqual(
    page(createPriceSite(yearly), '/prices/spotify/sweden').valstara?.rows.map(
      (row) => [row.termText, row.listText, row.valstaraText, row.basis],
    ),
    [['12 months', '149.00 SEK', '129.50 SEK', null]],
  );

  // An entry with more decimals than its currency has is refused by the
  // cross-file configuration rules before any page is built (D-034 Q2) ...
  const inexact = structuredClone(data);
  inexact.valstaraPrices.prices[0]!.price_local = '119.005';
  assert.throws(
    () => createPriceSite(inexact),
    (error) =>
      error instanceof PriceDataError &&
      /config\/valstara-prices\.json \(prices\.0\): Valstara price 119\.005 must be written at the minor-unit exponent of SEK \(2 decimals\)/u.test(
        error.message,
      ),
  );
  // ... even for a plan that publishes no page today (Netflix Standard is
  // needs_review), so it cannot break a later build when the plan publishes.
  const unpublished = structuredClone(data);
  const standard = unpublished.valstaraPrices.prices.find(
    (entry) => entry.service_id === 'netflix' && entry.plan_id === 'standard',
  )!;
  standard.price_local = '119.001';
  assert.throws(
    () => createPriceSite(unpublished),
    (error) =>
      error instanceof PriceDataError &&
      /config\/valstara-prices\.json \(prices\.4\): Valstara price 119\.001 must be written at the minor-unit exponent of SEK \(2 decimals\)/u.test(
        error.message,
      ),
  );

  const foreign = structuredClone(data);
  foreign.valstaraPrices.prices[0]!.currency = 'EUR';
  assert.throws(
    () => createPriceSite(foreign),
    (error) =>
      error instanceof PriceDataError &&
      /config\/valstara-prices\.json \(prices\.0\): Valstara price in EUR, but market SE uses SEK/u.test(
        error.message,
      ),
  );
});

test('the Valstara comparison: a price above list, or less than 0.1% below it, is not shown, so the figure is never negative or 0.0% (D-033 Q2)', async () => {
  const data = await dataset();
  const only = (price_local: string) => {
    const one = structuredClone(data);
    one.valstaraPrices.prices = [
      {
        service_id: 'spotify',
        plan_id: 'individual',
        market: 'SE',
        term_months: 1,
        price_local,
        currency: 'SEK',
      },
    ];
    return page(createPriceSite(one), '/prices/spotify/sweden').valstara;
  };
  // Above the list price, (149.00 − 165.00) / 149.00 = −10.7…%: no row, and
  // with no row left, no comparison block; never a negative figure.
  assert.equal(only('165.00'), null);
  // (149.00 − 148.90) / 149.00 = 0.067…%, floored to 0.0: no row, and with
  // no row left, no comparison block.
  assert.equal(only('148.90'), null);
  // (149.00 − 148.85) / 149.00 = 0.100…%: shown, floored to 0.1.
  assert.deepEqual(
    only('148.85')?.rows.map((row) => [
      row.listText,
      row.valstaraText,
      row.belowText,
    ]),
    [['149.00 SEK', '148.85 SEK', '0.1% below list price']],
  );
});

test('prices.valstara_comparison is registered and off by default', () => {
  assert.equal(campaignFlagRegistry['prices.valstara_comparison'], false);
});

test('an invalid change log publishes nothing', async () => {
  const data = await dataset();
  const broken = structuredClone(data) as unknown as {
    changes: { changes: unknown[] };
  } & Dataset;
  broken.changes.changes.push({ market: 'SE' });
  assert.throws(
    () => createPriceSite(broken),
    /data\/price-index\/changes\.json is invalid/u,
  );
});

test('the copy rules hold: "below list price", provider names as the catalogue writes them, local currency only', async () => {
  const data = await dataset();
  const site = createPriceSite(data);
  const text = JSON.stringify(site.routes);
  assert.doesNotMatch(
    text,
    /!|insane deal|dirt cheap|unbeatable|digital products|≈|approx|converted/iu,
  );
  for (const route of site.routes) {
    if (route.kind !== 'generated' || route.valstara === null) continue;
    for (const row of route.valstara.rows) {
      assert.match(row.belowText, /^\d+\.\d% below list price$/u);
    }
  }
  // Every plan label is the catalogue's service and plan names, unaltered.
  const labels = new Set(
    data.catalogue.services.flatMap((service) =>
      service.plans.map((plan) =>
        pricesCopy.planLabel(service.name, plan.name),
      ),
    ),
  );
  for (const [label] of text.matchAll(
    /(?:Apple Music|Spotify Premium|Netflix|Duolingo|ChatGPT) — [A-Z][A-Za-z]*(?: \(4K\))?/gu,
  )) {
    assert.ok(labels.has(label), label);
  }
  // Every price on every block carries its market's own currency.
  for (const route of site.routes) {
    if (route.kind !== 'generated') continue;
    const currency = data.markets.markets.find(
      (market) => market.code === route.market,
    )!.currency;
    for (const item of route.history) assert.equal(item.currency, currency);
    for (const row of route.valstara?.rows ?? []) {
      assert.equal(row.currency, currency);
    }
  }
});

test('ordinals and a sentence-initial market name', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(pricesCopy.ordinal),
    [
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th',
    ],
  );
  assert.equal(
    pricesCopy.page.comparison.rank('the Netherlands', 4, false, 20, spotify),
    `The Netherlands is the 4th most expensive of our 20 markets for ${spotify}.`,
  );
});
