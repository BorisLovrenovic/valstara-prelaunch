import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogueFile } from '../../packages/price-index/src/schema/catalogue.ts';
import type {
  RawPage,
  SourceContext,
} from '../../packages/price-index/src/sources/source-adapter.ts';
import { youfundceoAdapter } from '../../packages/price-index/src/sources/index.ts';
import {
  committedCatalogue,
  contextWithMarkets,
  fixtureHtml,
  fixtureName,
  origin,
} from '../helpers/price-index-sources.ts';

// E11.6-05: the request plan over a fixture catalogue. A run asks for the
// three index pages, each enabled market's country page, and a country ×
// service page only for a tracked service the source prices in that country
// (the minimum request set in docs/features/price-index-source-findings.md).
// The pages come from the founder's capture; a page the capture does not
// hold answers as an HTTP error, which ends that unit's requests.

const adapter = youfundceoAdapter;

/** A captured page's HTML, or null when the capture does not hold it. */
function capturedHtml(path: string): string | null {
  try {
    return fixtureHtml(fixtureName(path));
  } catch {
    return null;
  }
}

/** Simulates a run: asks each unit for its pages until it has none left. */
function simulateRun(context: SourceContext): {
  requested: string[];
  byUnit: Map<string, string[]>;
} {
  const pages = new Map<string, RawPage>();
  const requested: string[] = [];
  const byUnit = new Map<string, string[]>();
  for (const unit of adapter.units(context)) {
    const unitRequests: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      const wanted = adapter.requests(unit, context, pages);
      if (wanted.length === 0) {
        break;
      }
      for (const url of wanted) {
        assert.ok(!pages.has(url), `${url} is asked for once`);
        const path = url.slice(origin.length);
        const html = capturedHtml(path);
        pages.set(
          url,
          html === null
            ? { url, outcome: 'http_error', detail: 'not in the capture' }
            : { url, outcome: 'ok', html },
        );
        requested.push(url);
        unitRequests.push(path);
      }
    }
    assert.deepEqual(
      adapter.requests(unit, context, pages),
      [],
      `${unit.id} is complete`,
    );
    byUnit.set(unit.id, unitRequests);
  }
  return { requested, byUnit };
}

const marketSlugs: Record<string, string> = {
  GB: 'united-kingdom',
  DE: 'germany',
  ES: 'spain',
  FR: 'france',
  IT: 'italy',
  PL: 'poland',
  RO: 'romania',
  SE: 'sweden',
  NO: 'norway',
  DK: 'denmark',
  FI: 'finland',
  CH: 'switzerland',
  NL: 'netherlands',
  HR: 'croatia',
  IE: 'ireland',
  AT: 'austria',
  PT: 'portugal',
  CA: 'canada',
  US: 'united-states',
  AU: 'australia',
};

const allSeven = [
  'amazon-prime',
  'apple-tv-plus',
  'apple-music',
  'chatgpt',
  'netflix',
  'spotify',
  'youtube-premium',
];
const withoutAmazon = allSeven.filter((service) => service !== 'amazon-prime');

/**
 * The tracked, aliased services the source prices in each market, by hand
 * from the findings' table ("Priced on the source"), Adobe left out because
 * the seeded catalogue gives it no alias.
 */
const pricedTracked: Record<string, string[]> = {
  GB: allSeven,
  DE: allSeven,
  ES: allSeven,
  FR: allSeven,
  IT: allSeven,
  PL: allSeven,
  SE: allSeven,
  NL: allSeven,
  IE: allSeven,
  AT: allSeven,
  CA: allSeven,
  US: allSeven,
  NO: withoutAmazon,
  DK: withoutAmazon,
  FI: withoutAmazon,
  CH: withoutAmazon,
  PT: withoutAmazon,
  AU: allSeven.filter((service) => service !== 'youtube-premium'),
  RO: ['apple-tv-plus', 'chatgpt', 'netflix', 'spotify'],
  HR: ['apple-tv-plus', 'chatgpt', 'netflix', 'spotify', 'youtube-premium'],
};

function servicePaths(code: string, services: readonly string[]): string[] {
  return services
    .map((service) => `/services/${service}/${marketSlugs[code]}`)
    .sort();
}

/** The country × service URLs a page's JSON-LD ItemList names, read without the parser. */
function itemListUrls(slug: string): Set<string> {
  const html = fixtureHtml(`countries__${slug}`);
  const list =
    /<script type="application\/ld\+json">(\{"@context":"https:\/\/schema.org","@type":"ItemList".*?)<\/script>/.exec(
      html,
    );
  assert.ok(list, `${slug} has an ItemList`);
  const parsed = JSON.parse(list[1]) as { itemListElement: { url: string }[] };
  return new Set(parsed.itemListElement.map((item) => item.url));
}

function withAdobeAlias(catalogue: CatalogueFile): CatalogueFile {
  return {
    services: catalogue.services.map((service) =>
      service.service_id === 'adobe-creative-cloud'
        ? {
            ...service,
            source_aliases: {
              service: ['Adobe Creative Cloud', 'adobe'],
              plans: { individual: ['cc-pro'] },
            },
          }
        : service,
    ),
  };
}

test('the units are the index, then each enabled market in config order', () => {
  const units = adapter.units(contextWithMarkets('all'));
  assert.deepEqual(units[0], { id: 'index', market: null });
  assert.deepEqual(
    units.slice(1).map((unit) => unit.market),
    Object.keys(marketSlugs),
  );
  assert.ok(
    units.slice(1).every((unit) => unit.id === `market:${unit.market}`),
  );
  assert.deepEqual(
    adapter.units(contextWithMarkets(['US', 'SE'])).map((unit) => unit.id),
    ['index', 'market:SE', 'market:US'],
  );
});

test('a unit asks for each page in turn, and only once it can know it', () => {
  const context = contextWithMarkets(['SE']);
  const [index, sweden] = adapter.units(context);
  const pages = new Map<string, RawPage>();
  const fetch = (path: string) =>
    pages.set(`${origin}${path}`, {
      url: `${origin}${path}`,
      outcome: 'ok',
      html: fixtureHtml(fixtureName(path)),
    });

  assert.deepEqual(adapter.requests(index, context, pages), [
    `${origin}/countries`,
    `${origin}/services`,
    `${origin}/price-moves`,
  ]);
  // Before the indexes, a market cannot know its country's slug or the
  // services' slugs, so it asks for nothing.
  assert.deepEqual(adapter.requests(sweden, context, pages), []);
  fetch('/countries');
  fetch('/services');
  assert.deepEqual(adapter.requests(index, context, pages), [
    `${origin}/price-moves`,
  ]);
  assert.deepEqual(adapter.requests(sweden, context, pages), [
    `${origin}/countries/sweden`,
  ]);
  fetch('/countries/sweden');
  assert.deepEqual(
    adapter
      .requests(sweden, context, pages)
      .map((url) => url.slice(origin.length))
      .sort(),
    servicePaths('SE', pricedTracked.SE),
  );
  fetch('/services/netflix/sweden');
  assert.ok(
    !adapter
      .requests(sweden, context, pages)
      .includes(`${origin}/services/netflix/sweden`),
    'a fetched page is not asked for again',
  );
});

test('a full run over the 20 markets asks for the minimum request set, and nothing else', () => {
  const context = contextWithMarkets('all');
  const { requested, byUnit } = simulateRun(context);
  assert.deepEqual(byUnit.get('index'), [
    '/countries',
    '/services',
    '/price-moves',
  ]);
  let servicePages = 0;
  for (const [code, slug] of Object.entries(marketSlugs)) {
    const [countryPage, ...rest] = byUnit.get(`market:${code}`) ?? [];
    assert.equal(countryPage, `/countries/${slug}`, code);
    assert.deepEqual(
      [...rest].sort(),
      servicePaths(code, pricedTracked[code]),
      code,
    );
    // Every country × service page asked for is one the country page prices.
    const listed = itemListUrls(slug);
    for (const path of rest) {
      assert.ok(listed.has(`${origin}${path}`), `${path} is priced in ${code}`);
    }
    servicePages += rest.length;
  }
  assert.equal(servicePages, 129);
  assert.equal(requested.length, 3 + 20 + 129);
  for (const url of requested) {
    assert.ok(url.startsWith(`${origin}/`), url);
    assert.ok(!/^\/(api|go)\//.test(url.slice(origin.length)), url);
  }
});

test('no country × service page for a service the source does not price in that country', () => {
  const { requested } = simulateRun(contextWithMarkets('all'));
  for (const path of [
    '/services/amazon-prime/norway', // not listed in Norway
    '/services/amazon-prime/croatia', // not listed in Croatia
    '/services/youtube-premium/australia', // "No price shown"
    '/services/apple-music/romania', // "No price shown"
    '/services/apple-music/croatia', // "No price shown"
    '/services/prime-video/united-states', // priced, but not tracked
    '/services/adobe/sweden', // priced, but Adobe has no alias
  ]) {
    assert.ok(!requested.includes(`${origin}${path}`), path);
  }
  assert.ok(
    !requested.some((url) => /\/services\/(bolt|canva|figma|notion)/.test(url)),
  );
});

test("a new alias adds its pages with no code change: the findings' 148 with Adobe mapped", () => {
  const context = contextWithMarkets(
    'all',
    withAdobeAlias(committedCatalogue()),
  );
  const { byUnit } = simulateRun(context);
  let servicePages = 0;
  for (const [code, slug] of Object.entries(marketSlugs)) {
    const rest = (byUnit.get(`market:${code}`) ?? []).slice(1);
    const adobe = rest.includes(`/services/adobe/${slug}`);
    assert.equal(
      adobe,
      code !== 'HR',
      `${code}: Adobe is "No price shown" only in Croatia`,
    );
    servicePages += rest.length;
  }
  assert.equal(servicePages, 148);
});

test('a disabled market is never requested', () => {
  const context = contextWithMarkets(
    Object.keys(marketSlugs).filter((code) => code !== 'SE' && code !== 'GB'),
  );
  const { requested } = simulateRun(context);
  assert.ok(!requested.some((url) => /\/(sweden|united-kingdom)$/.test(url)));
  assert.equal(requested.length, 3 + 18 + 129 - 7 - 7);
  // Asked directly, a disabled market's unit has nothing to fetch.
  const pages = new Map<string, RawPage>(
    ['/countries', '/services', '/countries/sweden'].map((path) => [
      `${origin}${path}`,
      {
        url: `${origin}${path}`,
        outcome: 'ok',
        html: fixtureHtml(fixtureName(path)),
      },
    ]),
  );
  assert.deepEqual(
    adapter.requests({ id: 'market:SE', market: 'SE' }, context, pages),
    [],
  );
  assert.deepEqual(
    adapter.requests({ id: 'market:XX', market: 'XX' }, context, pages),
    [],
  );
});

test('the request plan follows the catalogue: a removed service is not asked for, an added one is', () => {
  const catalogue = committedCatalogue();
  const removed = simulateRun(
    contextWithMarkets('all', {
      services: catalogue.services.filter(
        (service) => service.service_id !== 'netflix',
      ),
    }),
  );
  assert.ok(
    !removed.requested.some((url) => url.includes('/services/netflix/')),
  );
  assert.equal(removed.requested.length, 3 + 20 + 129 - 20);

  const added = simulateRun(
    contextWithMarkets('all', {
      services: [
        ...catalogue.services,
        {
          service_id: 'disney-plus',
          name: 'Disney+',
          category: 'streaming',
          website_url: 'https://www.disneyplus.com/',
          status: 'planned',
          plans: [
            {
              plan_id: 'standard',
              name: 'Standard',
              billing_period: 'month',
              is_student: false,
              is_family: false,
            },
          ],
          source_aliases: { service: ['Disney+', 'disney-plus'], plans: {} },
        },
      ],
    }),
  );
  const disney = added.requested.filter((url) =>
    url.includes('/services/disney-plus/'),
  );
  const expected = Object.values(marketSlugs)
    .map((slug) => `${origin}/services/disney-plus/${slug}`)
    .filter((url) => itemListUrls(url.split('/').at(-1) ?? '').has(url));
  assert.ok(expected.length > 0);
  assert.deepEqual(disney.sort(), expected.sort());
});
