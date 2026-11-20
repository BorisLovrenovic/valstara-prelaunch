import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  isPublishable,
  publishedView,
  rankMarkets,
  servicePagePath,
} from '../packages/price-index/src/publish/index.ts';
import { checkRenderedHead } from '../scripts/ci/seo-build-check.ts';
import { canonicalUrl, organisationData } from '../src/server/seo.ts';
import { faqPageIssues } from './helpers/faq-page-data.mjs';
import { sourcePagePaths } from './helpers/page-inventory.mjs';
import {
  committedPriceData,
  documentOf,
  elementWith,
  elements,
  fetchRoutes,
  mainText,
  projectRoot,
  readableText,
  siteLinks,
  startPriceAuditServer,
  structuredData,
} from './helpers/price-audit.mjs';
import {
  breadcrumbListIssues,
  datasetIssues,
} from './helpers/structured-data.mjs';

// E11.6-16: the price-page audit over the committed data of the founder's
// first monthly run (E11.6-15), not a fixture. Every price route the data
// generates is served by the repository's own build and read here over HTTP:
// the internal-link graph, the structured data, the copy and claims rules
// and the number-trace sweep. What a route must show is worked out from the
// raw files through the publish gate (`publishedView`, `rankMarkets`, the
// generation rule), never from the page view model the pages render from.
// The privacy crawl is in test/e11-05-page-inventory.test.mjs; the
// accessibility gate and the lab performance run are in
// test/e11-6-16-price-browser.test.mjs. Evidence:
// docs/testing/e11-6-price-pages-audit.md.

const data = await committedPriceData();
const { inputs, site, pages } = data;
const latest = inputs.latest;
const routePaths = data.routes.map((route) => route.path);
const routeKind = new Map(data.routes.map((route) => [route.path, route.kind]));
const priceRouteSet = new Set(routePaths);
const marketsByCode = new Map(
  inputs.markets.markets.map((market) => [market.code, market]),
);
const enabledMarkets = inputs.markets.markets.filter(
  (market) => market.enabled,
);
const serviceById = new Map(
  inputs.catalogue.services.map((service) => [service.service_id, service]),
);
const published = publishedView(latest).records;
const planKey = (record) =>
  [record.service_id, record.plan_id, record.billing_period].join('/');
const recordKey = (record) => `${record.market}/${planKey(record)}`;
const verifiedOn = (record) =>
  record.source_verified_at ?? record.observed_at.slice(0, 10);
const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** "4 November 2026", as the pages write a date. */
const longDate = (date) => {
  const [year, month, day] = date.split('-');
  return `${Number(day)} ${monthNames[Number(month) - 1]} ${year}`;
};
const dateFigures = (date) => {
  const [year, , day] = date.split('-');
  return [year, String(Number(day))];
};

let server;
let served;
let landing;
let sitemaps;

before(async () => {
  server = await startPriceAuditServer({ label: 'E11.6-16 route audit' });
  served = await fetchRoutes(server.port, routePaths);
  landing = (await fetchRoutes(server.port, ['/'])).get('/');
  sitemaps = await fetchRoutes(server.port, [
    '/sitemap.xml',
    '/sitemaps/pages.xml',
    '/sitemaps/prices-service-market.xml',
    '/sitemaps/prices-index.xml',
    '/sitemaps/prices-service-hubs.xml',
    '/sitemaps/prices-market-hubs.xml',
    '/sitemaps/price-index-monthly.xml',
  ]);
});

after(async () => {
  await server?.dispose();
});

const documents = new Map();
function page(path) {
  if (!documents.has(path)) {
    const response = served.get(path);
    assert.ok(response, `${path} was fetched`);
    documents.set(path, documentOf(response.body));
  }
  return documents.get(path);
}

const pathOf = (href) => new URL(href, 'https://valstara.com').pathname;
const mainOf = (path) => elementWith(page(path), 'main');
/** The site paths `<main>` links to, outside the signup island. */
function mainLinks(path) {
  const main = mainOf(path);
  return elements(
    main,
    (element) =>
      element.name === 'a' &&
      typeof element.attribs.href === 'string' &&
      element.attribs.href.startsWith('/'),
  ).map((element) => pathOf(element.attribs.href));
}
const attributeLinks = (path, attribute) =>
  elements(
    page(path),
    (element) =>
      element.name === 'a' && Object.hasOwn(element.attribs, attribute),
  ).map((element) => pathOf(element.attribs.href));

function sitemapPaths(path) {
  const body = sitemaps.get(path)?.body ?? '';
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) =>
    pathOf(match[1]),
  );
}

// ---------------------------------------------------------------------------
// The route inventory.

test('the committed data is real and generates every kind of price route the audit covers', () => {
  assert.ok(pages.length > 0, `the first run generates ${pages.length} pages`);
  for (const kind of [
    'service-market',
    'service-hub',
    'market-hub',
    'prices',
    'price-index',
    'monthly',
  ])
    assert.ok(
      data.routes.some((route) => route.kind === kind),
      `the committed data has a ${kind} route`,
    );
});

test('the served price routes are exactly what the committed data generates, and each answers its page', async () => {
  // The generation rule, read without the site model, is the expectation.
  assert.deepEqual(
    site.routes
      .filter((route) => route.kind === 'generated')
      .map((route) => route.path)
      .sort(),
    pages.map((item) => item.path).sort(),
  );
  assert.deepEqual(
    site.hubs.map((hub) => hub.path).sort(),
    [...data.hubs].sort(),
  );
  const reportFiles = (
    await readdir(join(projectRoot, 'data/price-index/monthly'))
  ).filter((name) => name.endsWith('.json'));
  assert.deepEqual(
    site.monthlyReports.map((report) => report.path).sort(),
    reportFiles.map((name) => `/price-index/${name.slice(0, -5)}`).sort(),
  );
  // Every ledger URL still answers: a page, the unavailable state or its 301.
  for (const entry of inputs.ledger.urls) {
    if (entry.kind === 'retired') continue;
    assert.ok(
      priceRouteSet.has(entry.path) || site.redirect(entry.path) !== null,
      `${entry.path} is in the ledger, so it never answers 404`,
    );
  }
  const marker = {
    'service-market': /data-price-page="generated"/u,
    unavailable: /data-price-page="unavailable"/u,
    'service-hub': /data-price-hub="service-hub"/u,
    'market-hub': /data-price-hub="market-hub"/u,
    prices: /data-price-hub="index"/u,
    'price-index': /data-price-report="price-index"/u,
    monthly: /data-price-report="monthly"/u,
  };
  for (const { path, kind } of data.routes) {
    const response = served.get(path);
    assert.equal(response.status, 200, `${path} answers 200`);
    assert.match(response.body, marker[kind], `${path} renders its ${kind}`);
    if (kind === 'unavailable') {
      assert.match(response.body, /<meta name="robots" content="noindex"/u);
    } else {
      assert.doesNotMatch(
        response.body,
        /<meta name="robots"/u,
        `${path} is indexable`,
      );
    }
  }
  // Each route has unique, complete metadata: the E9-06 and E9-07 head check.
  const seen = { titles: new Set(), descriptions: new Set() };
  for (const path of routePaths)
    checkRenderedHead(served.get(path).body, path, seen);
});

test('each child sitemap lists exactly the indexable price routes of its kind', () => {
  const index = sitemapPaths('/sitemap.xml');
  for (const child of [
    '/sitemaps/pages.xml',
    '/sitemaps/prices-service-market.xml',
    '/sitemaps/prices-index.xml',
    '/sitemaps/prices-service-hubs.xml',
    '/sitemaps/prices-market-hubs.xml',
    '/sitemaps/price-index-monthly.xml',
  ])
    assert.ok(index.includes(child), `the sitemap index lists ${child}`);
  const ofKind = (kind) =>
    data.routes
      .filter((route) => route.kind === kind)
      .map((route) => route.path)
      .sort();
  assert.deepEqual(
    sitemapPaths('/sitemaps/prices-service-market.xml').sort(),
    ofKind('service-market'),
  );
  assert.deepEqual(
    sitemapPaths('/sitemaps/prices-service-hubs.xml').sort(),
    ofKind('service-hub'),
  );
  assert.deepEqual(
    sitemapPaths('/sitemaps/prices-market-hubs.xml').sort(),
    ofKind('market-hub'),
  );
  assert.deepEqual(sitemapPaths('/sitemaps/prices-index.xml'), ['/prices']);
  assert.deepEqual(
    sitemapPaths('/sitemaps/price-index-monthly.xml').sort(),
    ofKind('monthly'),
  );
  assert.ok(sitemapPaths('/sitemaps/pages.xml').includes('/price-index'));
});

// ---------------------------------------------------------------------------
// The internal-link graph.

const { routes: siteRouteList } = await sourcePagePaths();
const siteRoutes = new Set(siteRouteList);

/** Every link on a page goes to a generated price route or a page of the site. */
function assertLinksResolve(path, document) {
  for (const href of siteLinks(document)) {
    const target = pathOf(href);
    if (target.startsWith('/prices') || target.startsWith('/price-index')) {
      assert.ok(
        priceRouteSet.has(target),
        `${path} links to ${target}, which the data does not generate`,
      );
    } else {
      assert.ok(
        siteRoutes.has(target),
        `${path} links to ${target}, which is not a page of the site`,
      );
    }
  }
}

test('link graph: no page links to a price route the data does not generate, or to any page the site does not have', () => {
  for (const path of routePaths) assertLinksResolve(path, page(path));
});

test('link graph: every service × market page and its service hub link each other, and only the pages the data generates', () => {
  for (const item of pages) {
    const hub = `/prices/${item.service_id}`;
    assert.ok(
      attributeLinks(item.path, 'data-hub-link').includes(hub),
      `${item.path} links to ${hub}`,
    );
  }
  for (const service of inputs.catalogue.services) {
    const own = pages
      .filter((item) => item.service_id === service.service_id)
      .map((item) => item.path);
    const hub = `/prices/${service.service_id}`;
    if (own.length === 0) {
      assert.ok(!priceRouteSet.has(hub), `${hub} has no page, so no hub`);
      continue;
    }
    const linked = mainLinks(hub).filter(
      (target) => routeKind.get(target) === 'service-market',
    );
    assert.deepEqual(
      [...new Set(linked)].sort(),
      [...own].sort(),
      `${hub} links every page of ${service.name}, and no other`,
    );
  }
});

test('link graph: every service × market page and its market hub link each other, and only the pages the data generates', () => {
  for (const item of pages) {
    const hub = `/prices/countries/${item.market_slug}`;
    assert.ok(
      attributeLinks(item.path, 'data-hub-link').includes(hub),
      `${item.path} links to ${hub}`,
    );
  }
  for (const market of enabledMarkets) {
    const own = pages
      .filter((item) => item.market === market.code)
      .map((item) => item.path);
    const hub = `/prices/countries/${market.slug}`;
    if (own.length === 0) {
      assert.ok(!priceRouteSet.has(hub), `${hub} has no page, so no hub`);
      continue;
    }
    const linked = mainLinks(hub).filter(
      (target) => routeKind.get(target) === 'service-market',
    );
    assert.deepEqual(
      [...new Set(linked)].sort(),
      [...own].sort(),
      `${hub} links every page in ${market.name}, and no other`,
    );
  }
});

test('link graph: each page links exactly its category neighbours in its market, in catalogue order', () => {
  let linked = 0;
  for (const item of pages) {
    const category = serviceById.get(item.service_id).category;
    const expected = pages
      .filter(
        (other) =>
          other.market === item.market &&
          other.path !== item.path &&
          serviceById.get(other.service_id).category === category,
      )
      .map((other) => other.path);
    const actual = attributeLinks(item.path, 'data-related-service');
    assert.deepEqual(actual, expected, `${item.path} category neighbours`);
    assert.equal(
      /data-price-related/u.test(served.get(item.path).body),
      expected.length > 0,
      `${item.path} shows the related block exactly when it has a neighbour`,
    );
    linked += actual.length;
  }
  assert.ok(linked > 0, 'the committed data has category neighbours');
});

test('link graph: /prices links every hub, /price-index every monthly report, and every page the methodology', () => {
  const hubs = data.routes
    .filter(
      (route) => route.kind === 'service-hub' || route.kind === 'market-hub',
    )
    .map((route) => route.path);
  assert.deepEqual(
    [...new Set(attributeLinks('/prices', 'data-hub-link'))].sort(),
    [...hubs].sort(),
  );
  assert.deepEqual(
    attributeLinks('/price-index', 'data-report-link'),
    site.monthlyReports.map((report) => report.path),
  );
  assert.ok(
    attributeLinks('/price-index', 'data-prices-link').includes('/prices'),
  );
  for (const { path, kind } of data.routes)
    if (kind === 'service-market' || kind === 'monthly')
      assert.ok(
        attributeLinks(path, 'data-methodology-link').includes('/price-index'),
        `${path} links the methodology`,
      );
});

test('link graph: each monthly report links every page and hub it mentions that the data generates, and names the rest without a link', async () => {
  for (const report of site.monthlyReports) {
    const file = JSON.parse(
      await readFile(
        join(projectRoot, `data/price-index/monthly/${report.month}.json`),
        'utf8',
      ),
    );
    const expected = new Set();
    let unlinked = 0;
    const mention = (path) => {
      if (priceRouteSet.has(path)) expected.add(path);
      else unlinked += 1;
    };
    const slug = (code) => marketsByCode.get(code)?.slug ?? code;
    for (const change of file.changes)
      mention(servicePagePath(change.service_id, slug(change.market)));
    for (const plan of file.plans) {
      if (plan.rose_in > 0 || plan.fell_in > 0 || plan.most_expensive !== null)
        mention(`/prices/${plan.service_id}`);
      for (const extreme of [plan.most_expensive, plan.least_expensive])
        if (extreme !== null)
          mention(servicePagePath(plan.service_id, slug(extreme.market)));
    }
    const actual = attributeLinks(report.path, 'data-mention-link');
    assert.deepEqual(
      [...new Set(actual)].sort(),
      [...expected].sort(),
      `${report.path} links exactly the generated pages and hubs it mentions`,
    );
    for (const target of actual)
      assert.ok(priceRouteSet.has(target), `${report.path} → ${target}`);
    if (unlinked === 0)
      assert.doesNotMatch(
        served.get(report.path).body,
        /data-mention-unlinked/u,
      );
  }
});

test('link graph: every price route is reachable by links from the landing page', () => {
  const reached = new Set();
  const queue = ['/'];
  const linksOf = (path) =>
    path === '/' ? siteLinks(documentOf(landing.body)) : siteLinks(page(path));
  while (queue.length > 0) {
    const path = queue.shift();
    for (const href of linksOf(path)) {
      const target = pathOf(href);
      if (priceRouteSet.has(target) && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  assert.deepEqual(
    routePaths.filter((path) => !reached.has(path)),
    [],
    'every price route is crawlable from the site',
  );
});

// ---------------------------------------------------------------------------
// Structured data.

/** The visible breadcrumb: each item's name, and its path or the page's own. */
function visibleBreadcrumb(path) {
  const nav = elements(
    page(path),
    (element) =>
      element.name === 'nav' && element.attribs['aria-label'] === 'Breadcrumb',
  );
  assert.equal(nav.length, 1, `${path} has one visible breadcrumb`);
  return elements(nav[0], (element) => element.name === 'li').map((item) => {
    const link = elementWith(item, 'a');
    return {
      name: readableText(item),
      path: link === null ? path : pathOf(link.attribs.href),
    };
  });
}

const breadcrumbTrail = {
  'service-market': (path) => ['/', path],
  unavailable: (path) => ['/', path],
  'service-hub': (path) => ['/', '/prices', path],
  'market-hub': (path) => ['/', '/prices', path],
  prices: () => ['/', '/prices'],
  'price-index': () => ['/', '/price-index'],
  monthly: (path) => ['/', '/price-index', path],
};

/** The published records a Dataset covers: enabled markets, catalogue plans. */
const datasetRecords = published.filter(
  (record) =>
    marketsByCode.get(record.market)?.enabled === true &&
    serviceById
      .get(record.service_id)
      ?.plans.some(
        (plan) =>
          plan.plan_id === record.plan_id &&
          plan.billing_period === record.billing_period,
      ),
);

test('structured data validates on every price route: Organization, BreadcrumbList matching the visible breadcrumb, FAQPage with the visible FAQ, Dataset on /price-index', () => {
  let faqPages = 0;
  for (const { path, kind } of data.routes) {
    const blocks = structuredData(page(path));
    const types = blocks.map((block) => block['@type']);
    const faqVisible = /data-price-faq/u.test(served.get(path).body);
    const expected = [
      'Organization',
      'BreadcrumbList',
      ...(faqVisible ? ['FAQPage'] : []),
      ...(kind === 'price-index' ? ['Dataset'] : []),
    ];
    assert.deepEqual(types, expected, `${path} carries ${expected.join(', ')}`);

    assert.deepEqual(blocks[0], organisationData(), `${path} Organization`);

    const breadcrumb = blocks[1];
    assert.deepEqual(breadcrumbListIssues(breadcrumb, path), [], path);
    const visible = visibleBreadcrumb(path);
    assert.deepEqual(
      breadcrumb.itemListElement.map((item) => ({
        name: item.name,
        path: pathOf(item.item),
      })),
      visible,
      `${path} BreadcrumbList mirrors the visible breadcrumb`,
    );
    assert.deepEqual(
      visible.map((item) => item.path),
      breadcrumbTrail[kind](path),
      `${path} breadcrumb trail`,
    );

    if (faqVisible) {
      faqPages += 1;
      const faq = blocks[2];
      assert.deepEqual(faqPageIssues(faq), [], path);
      const section = elements(page(path), (element) =>
        Object.hasOwn(element.attribs ?? {}, 'data-price-faq'),
      )[0];
      const questions = elements(section, (element) => element.name === 'dt');
      const answers = elements(section, (element) => element.name === 'dd');
      assert.deepEqual(
        faq.mainEntity.map((entry) => ({
          question: entry.name,
          answer: entry.acceptedAnswer.text,
        })),
        questions.map((question, index) => ({
          question: readableText(question),
          answer: readableText(answers[index]),
        })),
        `${path} FAQPage states exactly the visible FAQ`,
      );
    }

    if (kind === 'price-index') {
      const dataset = blocks.at(-1);
      assert.deepEqual(datasetIssues(dataset), [], path);
      const dates = datasetRecords.map(verifiedOn).sort();
      assert.equal(
        dataset.temporalCoverage,
        `${dates[0]}/${dates.at(-1)}`,
        'the Dataset covers the verification dates the data holds',
      );
      assert.equal(dataset.dateModified, dates.at(-1));
      assert.deepEqual(
        dataset.spatialCoverage,
        enabledMarkets.map((market) => ({
          '@type': 'Country',
          name: market.name,
          identifier: market.code,
        })),
        'the Dataset covers exactly the enabled markets',
      );
      assert.equal(dataset.url, canonicalUrl('/price-index'));
    }
  }
  assert.equal(
    faqPages,
    data.routes.filter((route) => route.kind === 'service-market').length,
    'every generated page has its FAQ and its FAQPage',
  );
});

// ---------------------------------------------------------------------------
// The copy and claims rules.

const forbidden = JSON.parse(
  await readFile(join(projectRoot, 'scripts/forbidden-copy.json'), 'utf8'),
).entries;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const priceIndexConfig = JSON.parse(
  await readFile(join(projectRoot, 'config/price-index.json'), 'utf8'),
);
// The data source, however a page might name it: its host, its bare name,
// every record's source and source URL host.
const sourceNames = (() => {
  const hosts = new Set([
    new URL(priceIndexConfig.fetcher.source_origin).host,
    ...latest.records
      .map((record) => record.source_url)
      .filter((url) => url !== null)
      .map((url) => new URL(url).host),
  ]);
  const names = new Set();
  for (const host of hosts) {
    names.add(host);
    names.add(host.replace(/^www\./u, ''));
    names.add(host.replace(/^www\./u, '').split('.')[0]);
  }
  for (const record of latest.records) names.add(record.source);
  return [...names];
})();

test('copy and claims: no forbidden or placeholder copy on any rendered price route', () => {
  assert.ok(forbidden.length > 0);
  for (const path of routePaths) {
    const text = readableText(page(path));
    for (const { term, replacement } of forbidden)
      assert.ok(
        !new RegExp(`\\b${escape(term)}\\b`, 'iu').test(text),
        `${path} says "${term}"; the copy rules say "${replacement}"`,
      );
    assert.doesNotMatch(
      text,
      /\b(?:TODO|TBD|lorem ipsum|dummy|placeholder|insert (?:text|copy)|replace this text|undefined|null|NaN)\b/iu,
      `${path} has placeholder or broken copy`,
    );
  }
});

/** No part of a page's HTML names the data source. */
function assertNoSourceCredit(path, body) {
  const html = body.toLowerCase();
  for (const name of sourceNames)
    assert.ok(
      !html.includes(name.toLowerCase()),
      `${path} names the data source (${name})`,
    );
}

test('copy and claims: no price route credits the data source, anywhere in its HTML', () => {
  assert.ok(sourceNames.includes('youfundceo'), sourceNames.join(', '));
  for (const path of routePaths)
    assertNoSourceCredit(path, served.get(path).body);
});

test('copy and claims: every route states its independence, names each provider as the catalogue does, and shows no Valstara price with the comparison off', () => {
  for (const { path, kind } of data.routes) {
    const text = mainText(page(path));
    assert.match(
      text,
      /Valstara is an independent seller\. It is not affiliated with or endorsed by/u,
      `${path} states its independence`,
    );
    assert.doesNotMatch(
      served.get(path).body,
      /data-valstara-comparison|data-valstara-amount/u,
      `${path} shows no Valstara price`,
    );
    assert.doesNotMatch(text, /\bbelow list price\b/iu, path);
    if (kind === 'service-market') {
      const item = pages.find((candidate) => candidate.path === path);
      const h1 = readableText(elementWith(page(path), 'h1'));
      assert.ok(
        h1.startsWith(
          `${item.service_name} price in ${item.market_name_in_sentence}`,
        ),
        `${path} names ${item.service_name} unaltered: ${h1}`,
      );
      for (const record of item.records) {
        const plan = serviceById
          .get(record.service_id)
          .plans.find((candidate) => candidate.plan_id === record.plan_id);
        assert.ok(
          text.includes(plan.name),
          `${path} names the plan ${plan.name}`,
        );
      }
    }
    if (kind === 'service-hub') {
      const service = serviceById.get(path.split('/')[2]);
      assert.ok(
        readableText(elementWith(page(path), 'h1')).startsWith(service.name),
        `${path} names ${service.name} unaltered`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The number-trace sweep.

/** Every "<amount> <currency>" a text shows. */
const moneyIn = (text) =>
  [...text.matchAll(/(\d+(?:\.\d+)?) ([A-Z]{3})\b/gu)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
const money = (record) => `${record.price_local} ${record.currency}`;
/** Names the configuration writes with a digit in them (n8n, "Premium (4K)"). */
const namedWithDigits = [
  ...inputs.catalogue.services.flatMap((service) => [
    service.name,
    ...service.plans.map((plan) => plan.name),
  ]),
  ...inputs.markets.markets.map((market) => market.name),
]
  .filter((name) => /\d/u.test(name))
  .sort((a, b) => b.length - a.length);
/** Every number a text shows, names with digits removed. */
function numbersIn(text) {
  let scan = text;
  for (const name of namedWithDigits) scan = scan.replaceAll(name, ' ');
  return [...scan.matchAll(/\d+(?:[.,]\d+)*/gu)].map((match) => match[0]);
}

/** Asserts that every amount and every number in `text` is allowed. */
function assertTraced(path, text, { money: amounts, numbers }) {
  const shown = moneyIn(text);
  for (const amount of shown)
    assert.ok(
      amounts.has(amount),
      `${path} shows ${amount}, which no published record behind it holds`,
    );
  for (const number of numbersIn(text))
    assert.ok(
      numbers.has(number),
      `${path} shows the number ${number}, which nothing it is traced to holds`,
    );
  assert.doesNotMatch(
    text,
    /[$€£¥≈]|\bapprox/iu,
    `${path} shows a converted figure`,
  );
  return shown.length;
}

function allowed() {
  return { money: new Set(), numbers: new Set() };
}
function allowRecord(set, record) {
  set.money.add(money(record));
  set.numbers.add(record.price_local);
  for (const figure of dateFigures(verifiedOn(record))) set.numbers.add(figure);
}

/** The rows of a price table: one per `<tr>` holding `data-price-amount`. */
function amountRows(root) {
  return elements(root, (element) => element.name === 'tr')
    .map((row) => ({
      row,
      amount: elements(row, (element) =>
        Object.hasOwn(element.attribs, 'data-price-amount'),
      )[0],
      time: elementWith(row, 'time'),
    }))
    .filter(({ amount }) => amount !== undefined);
}

/** The comparison this market should get for a plan, from rankMarkets() alone. */
function expectedComparison(record) {
  const ranking = rankMarkets(latest, record);
  const own = ranking.find((ranked) => ranked.market === record.market);
  if (
    own === undefined ||
    ranking.length < 2 ||
    ranking.some((ranked) => marketsByCode.get(ranked.market)?.enabled !== true)
  )
    return null;
  const lastRank = ranking.at(-1).rank;
  return {
    rank: own.rank,
    markets: ranking.length,
    extremes:
      lastRank === 1
        ? []
        : [ranking[0], ranking.find((ranked) => ranked.rank === lastRank)],
  };
}

const unpublished = latest.records.filter(
  (record) => record.price_local !== null && !isPublishable(record),
);

/**
 * The sweep of one service × market page: its plan table is its published
 * records exactly, its comparisons are rankMarkets()'s, its history is
 * changes.json's, every amount and number traces to one of those, and no
 * value the gate holds back shows. Returns how many amounts it traced.
 */
function assertServiceMarketTrace(item, document) {
  const path = item.path;
  const main = elementWith(document, 'main');
  const table = elements(main, (element) =>
    Object.hasOwn(element.attribs, 'data-price-table'),
  )[0];
  const rows = amountRows(table);
  assert.deepEqual(
    rows.map(({ row, amount, time }) => ({
      plan: row.attribs['data-plan'],
      period: row.attribs['data-billing-period'],
      amount: amount.attribs['data-price-amount'],
      currency: amount.attribs['data-price-currency'],
      shown: readableText(amount),
      verifiedOn: time.attribs.datetime,
      verifiedText: readableText(time),
    })),
    item.records.map((record) => ({
      plan: record.plan_id,
      period: record.billing_period,
      amount: record.price_local,
      currency: record.currency,
      shown: money(record),
      verifiedOn: verifiedOn(record),
      verifiedText: longDate(verifiedOn(record)),
    })),
    `${path} shows exactly its published records`,
  );
  for (const record of item.records)
    assert.equal(
      record.currency,
      marketsByCode.get(item.market).currency,
      `${path} is in its market's own currency`,
    );
  const newest = item.records.map(verifiedOn).sort().at(-1);
  assert.equal(
    readableText(
      elements(main, (element) =>
        Object.hasOwn(element.attribs, 'data-verified-line'),
      )[0],
    ),
    `Prices verified on ${longDate(newest)}.`,
    `${path} is dated by its newest verification`,
  );

  const permitted = allowed();
  for (const record of item.records) allowRecord(permitted, record);

  // The comparison: rank, M and both extremes, from rankMarkets() alone.
  const comparisons = elements(main, (element) =>
    Object.hasOwn(element.attribs, 'data-comparison-plan'),
  );
  const expected = item.records
    .map((record) => ({ record, comparison: expectedComparison(record) }))
    .filter(({ comparison }) => comparison !== null);
  assert.deepEqual(
    comparisons.map((element) => ({
      plan: element.attribs['data-comparison-plan'],
      rank: Number(element.attribs['data-comparison-rank']),
      markets: Number(element.attribs['data-comparison-markets']),
      extremes: elements(element, (row) =>
        Object.hasOwn(row.attribs, 'data-extreme-market'),
      ).map((row) => {
        const amount = elements(row, (cell) =>
          Object.hasOwn(cell.attribs, 'data-extreme-amount'),
        )[0];
        return {
          market: row.attribs['data-extreme-market'],
          amount: amount.attribs['data-extreme-amount'],
          currency: amount.attribs['data-extreme-currency'],
          shown: readableText(amount),
        };
      }),
    })),
    expected.map(({ record, comparison }) => ({
      plan: record.plan_id,
      rank: comparison.rank,
      markets: comparison.markets,
      extremes: comparison.extremes.map((ranked) => ({
        market: ranked.market,
        amount: ranked.record.price_local,
        currency: ranked.record.currency,
        shown: money(ranked.record),
      })),
    })),
    `${path} compares only as rankMarkets() ranks`,
  );
  for (const { comparison } of expected) {
    permitted.numbers.add(String(comparison.rank));
    permitted.numbers.add(String(comparison.markets));
    for (const ranked of comparison.extremes) {
      permitted.money.add(money(ranked.record));
      permitted.numbers.add(ranked.record.price_local);
    }
  }

  // History: only real changes of the shown plans (changes.json).
  const changes = inputs.changes.changes.filter((change) =>
    item.records.some(
      (record) =>
        recordKey(record) === recordKey(change) &&
        change.currency === record.currency,
    ),
  );
  assert.equal(
    elements(main, (element) =>
      Object.hasOwn(element.attribs, 'data-history-plan'),
    ).length,
    changes.length,
    `${path} shows its real changes only`,
  );
  for (const change of changes) {
    permitted.money.add(`${change.old_price_local} ${change.currency}`);
    permitted.money.add(`${change.new_price_local} ${change.currency}`);
    permitted.numbers.add(change.old_price_local);
    permitted.numbers.add(change.new_price_local);
    for (const figure of dateFigures(change.detected_on))
      permitted.numbers.add(figure);
  }

  const traced = assertTraced(path, mainText(document), permitted);

  // A value the gate holds back never shows on its own pair's page, and
  // the pair's plan has no row there.
  for (const record of unpublished.filter(
    (candidate) =>
      candidate.service_id === item.service_id &&
      candidate.market === item.market,
  )) {
    assert.ok(
      !rows.some(({ row }) => row.attribs['data-plan'] === record.plan_id),
      `${path} has a row for the unpublished ${record.plan_id}`,
    );
    assert.ok(
      !moneyIn(mainText(document)).includes(money(record)) ||
        permitted.money.has(money(record)),
      `${path} shows the unpublished ${money(record)}`,
    );
  }
  return traced;
}

test('number trace: every price on every service × market page is its published record, exactly, and nothing unpublished shows', () => {
  let traced = 0;
  assert.ok(unpublished.length > 0, 'the run has values the gate holds back');
  for (const item of pages)
    traced += assertServiceMarketTrace(item, page(item.path));
  // A pair whose every value is held back has no page at all.
  for (const record of unpublished) {
    const market = marketsByCode.get(record.market);
    const path = servicePagePath(record.service_id, market.slug);
    if (!pages.some((item) => item.path === path))
      assert.ok(!priceRouteSet.has(path), `${path} generates nothing`);
  }
  assert.ok(traced > pages.length, `${traced} amounts traced`);
});

test('number trace: every price on every hub is the published record of its row, in its market currency, in rankMarkets() order', () => {
  for (const { path, kind } of data.routes) {
    if (kind !== 'service-hub' && kind !== 'market-hub') continue;
    const main = mainOf(path);
    const permitted = allowed();
    const shown = [];
    if (kind === 'service-hub') {
      const service = serviceById.get(path.split('/')[2]);
      for (const block of elements(main, (element) =>
        Object.hasOwn(element.attribs, 'data-hub-billing-period'),
      )) {
        const plan = {
          service_id: service.service_id,
          plan_id: block.attribs['data-hub-plan'],
          billing_period: block.attribs['data-hub-billing-period'],
        };
        const records = pages
          .filter((item) => item.service_id === service.service_id)
          .flatMap((item) => item.records)
          .filter((record) => planKey(record) === planKey(plan));
        const ranking = rankMarkets(latest, plan);
        const ranked = ranking
          .map((entry) =>
            records.find((record) => record.market === entry.market),
          )
          .filter((record) => record !== undefined);
        const unranked = records
          .filter(
            (record) =>
              !ranking.some((entry) => entry.market === record.market),
          )
          .sort((a, b) =>
            marketsByCode
              .get(a.market)
              .name.localeCompare(marketsByCode.get(b.market).name),
          );
        const rows = amountRows(block);
        assert.deepEqual(
          rows.map(({ row, amount, time }) => ({
            market: row.attribs['data-hub-market'],
            rank: row.attribs['data-hub-rank'],
            shown: readableText(amount),
            amount: amount.attribs['data-price-amount'],
            currency: amount.attribs['data-price-currency'],
            verifiedOn: time.attribs.datetime,
          })),
          [...ranked, ...unranked].map((record) => {
            const entry = ranking.find(
              (candidate) => candidate.market === record.market,
            );
            return {
              market: record.market,
              rank: entry === undefined ? 'unranked' : String(entry.rank),
              shown: money(record),
              amount: record.price_local,
              currency: record.currency,
              verifiedOn: verifiedOn(record),
            };
          }),
          `${path} ${plan.plan_id}: every market's published price, ranked`,
        );
        for (const record of records) allowRecord(permitted, record);
        shown.push(...records);
      }
      assert.deepEqual(
        [...new Set(shown.map(planKey))].sort(),
        [
          ...new Set(
            pages
              .filter((item) => item.service_id === service.service_id)
              .flatMap((item) => item.records.map(planKey)),
          ),
        ].sort(),
        `${path} shows every published plan of ${service.name}`,
      );
    } else {
      const market = inputs.markets.markets.find(
        (candidate) => `/prices/countries/${candidate.slug}` === path,
      );
      const expected = pages
        .filter((item) => item.market === market.code)
        .sort(
          (a, b) =>
            inputs.catalogue.services.findIndex(
              (service) => service.service_id === a.service_id,
            ) -
            inputs.catalogue.services.findIndex(
              (service) => service.service_id === b.service_id,
            ),
        );
      const rows = amountRows(main);
      assert.deepEqual(
        rows
          .map(({ row, amount, time }) => ({
            service: row.attribs['data-hub-service'],
            plan: row.attribs['data-hub-plan'],
            shown: readableText(amount),
            amount: amount.attribs['data-price-amount'],
            currency: amount.attribs['data-price-currency'],
            verifiedOn: time.attribs.datetime,
          }))
          .sort((a, b) =>
            `${a.service}/${a.plan}`.localeCompare(`${b.service}/${b.plan}`),
          ),
        expected
          .flatMap((item) => item.records)
          .map((record) => ({
            service: record.service_id,
            plan: record.plan_id,
            shown: money(record),
            amount: record.price_local,
            currency: record.currency,
            verifiedOn: verifiedOn(record),
          }))
          .sort((a, b) =>
            `${a.service}/${a.plan}`.localeCompare(`${b.service}/${b.plan}`),
          ),
        `${path}: every published plan in ${market.name}`,
      );
      for (const item of expected)
        for (const record of item.records) {
          allowRecord(permitted, record);
          assert.equal(record.currency, market.currency);
          shown.push(record);
        }
    }
    const dates = shown.map(verifiedOn).sort();
    const line = elements(main, (element) =>
      Object.hasOwn(element.attribs, 'data-verified-line'),
    )[0];
    if (line !== undefined)
      assert.match(
        readableText(line),
        new RegExp(longDate(dates.at(-1))),
        path,
      );
    assertTraced(path, mainText(page(path)), permitted);
  }
});

test('number trace: /prices and /price-index state only dates the data holds and the settings the methodology describes', () => {
  const dates = datasetRecords.map(verifiedOn).sort();
  const range =
    dates[0] === dates.at(-1)
      ? `Prices verified on ${longDate(dates[0])}.`
      : `Prices verified between ${longDate(dates[0])} and ${longDate(dates.at(-1))}.`;
  for (const path of ['/prices', '/price-index']) {
    const text = mainText(page(path));
    assert.ok(
      text.includes(range),
      `${path} states the data's dates: ${range}`,
    );
    const permitted = allowed();
    for (const figure of [
      ...dateFigures(dates[0]),
      ...dateFigures(dates.at(-1)),
    ])
      permitted.numbers.add(figure);
    if (path === '/price-index') {
      // The methodology's settings (E11.6-13's reconciliation) and each report's year.
      permitted.numbers.add(
        String(priceIndexConfig.merge.change_threshold_percent),
      );
      permitted.numbers.add(
        String(priceIndexConfig.merge.stale_after_days.scraped),
      );
      permitted.numbers.add(
        String(priceIndexConfig.merge.stale_after_days.manual),
      );
      for (const report of site.monthlyReports)
        permitted.numbers.add(report.month.slice(0, 4));
    }
    assertTraced(path, text, permitted);
  }
});

test('number trace: every monthly report figure is its file’s, and each traces to the published records of the snapshot it names', async () => {
  const usdCents = (value) => BigInt(value.replace('.', ''));
  const ratio = (a, b) => {
    const tenths = (a * 20n + b) / (2n * b);
    return `${tenths / 10n}.${tenths % 10n}`;
  };
  for (const report of site.monthlyReports) {
    const file = JSON.parse(
      await readFile(
        join(projectRoot, `data/price-index/monthly/${report.month}.json`),
        'utf8',
      ),
    );
    const snapshot = JSON.parse(
      await readFile(
        join(projectRoot, 'data/price-index/snapshots', file.snapshot),
        'utf8',
      ),
    );
    const snapshotRecords = new Map(
      snapshot.records
        .filter((record) => isPublishable(record))
        .map((record) => [recordKey(record), record]),
    );
    assert.equal(
      file.markets,
      enabledMarkets.length,
      'the report counts the enabled markets',
    );
    const permitted = allowed();
    permitted.numbers.add(String(file.markets));
    permitted.numbers.add(report.month.slice(0, 4));
    for (const figure of dateFigures(file.built_at.slice(0, 10)))
      permitted.numbers.add(figure);
    for (const change of file.changes) {
      for (const amount of [change.old_price_local, change.new_price_local]) {
        permitted.money.add(`${amount} ${change.currency}`);
        permitted.numbers.add(amount);
      }
      permitted.numbers.add(change.change_percent.replace(/^[+-]/u, ''));
      const now = snapshotRecords.get(recordKey(change));
      assert.ok(
        now === undefined || now.currency === change.currency,
        `${report.path}: a change is in its market's currency`,
      );
    }
    for (const plan of file.plans) {
      permitted.numbers.add(String(plan.published_markets));
      permitted.numbers.add(String(plan.rose_in));
      permitted.numbers.add(String(plan.fell_in));
      if (plan.most_expensive === null) continue;
      const ranking = rankMarkets(snapshot, plan).filter(
        (entry) => marketsByCode.get(entry.market)?.enabled === true,
      );
      const lastRank = ranking.at(-1).rank;
      const top = ranking[0];
      const bottom = ranking.find((entry) => entry.rank === lastRank);
      for (const [extreme, ranked] of [
        [plan.most_expensive, top],
        [plan.least_expensive, bottom],
      ]) {
        assert.deepEqual(
          extreme,
          {
            market: ranked.market,
            price_local: ranked.record.price_local,
            currency: ranked.record.currency,
          },
          `${report.path}: ${planKey(plan)} extreme is the snapshot's published record`,
        );
        permitted.money.add(money(ranked.record));
        permitted.numbers.add(ranked.record.price_local);
      }
      // The spread is the one figure derived from the source's USD figures
      // (E11.6-09, docs/features/price-index.md): recomputed here from the
      // two records the report names, so it can be nothing else. Its
      // standing as a "converted figure" is finding P1 in the audit record.
      const expectedRatio = ratio(
        usdCents(
          snapshotRecords.get(recordKey({ ...plan, market: top.market }))
            .price_usd_source,
        ),
        usdCents(
          snapshotRecords.get(recordKey({ ...plan, market: bottom.market }))
            .price_usd_source,
        ),
      );
      assert.equal(
        plan.spread_ratio,
        expectedRatio,
        `${report.path}: ${planKey(plan)} spread`,
      );
      permitted.numbers.add(plan.spread_ratio);
    }
    const shown = assertTraced(
      report.path,
      mainText(page(report.path)),
      permitted,
    );
    assert.ok(shown > 0, `${report.path} shows its extremes`);
    // No USD figure of the source reaches the report, except where a US list
    // price is itself in USD.
    const text = mainText(page(report.path));
    for (const record of snapshot.records)
      if (record.price_usd_source !== null && record.currency !== 'USD')
        assert.ok(
          !text.includes(`${record.price_usd_source} USD`),
          `${report.path} shows the USD figure of ${recordKey(record)}`,
        );
  }
});

test('number trace: no USD figure appears on any price route except a US list price', () => {
  const usPrices = new Set(
    published.filter((record) => record.market === 'US').map(money),
  );
  for (const path of routePaths) {
    const text = readableText(page(path));
    for (const amount of moneyIn(text).filter((value) =>
      value.endsWith(' USD'),
    ))
      assert.ok(
        usPrices.has(amount),
        `${path} shows ${amount}, not a US list price`,
      );
    assert.doesNotMatch(served.get(path).body, /price_usd_source/iu, path);
  }
});

// ---------------------------------------------------------------------------
// Red paths: each check above, run on a served page with a planted defect,
// must fail. A sweep that passes these pages unchanged would pass them too.

/** A served page's HTML with `html` planted in its own content. */
function planted(path, html) {
  const body = served.get(path).body;
  const anchor = '<p class="price-page__independent"';
  assert.ok(body.includes(anchor), `${path} has its independence line`);
  return body.replace(anchor, `${html}${anchor}`);
}

test('red paths: the sweep fails a mismatched price, a converted figure, a held-back value and an untraced number', () => {
  const item = pages.find(
    (candidate) => candidate.market !== 'US' && candidate.records.length > 1,
  );
  assert.ok(item, 'a multi-plan page outside the US');
  assert.ok(
    assertServiceMarketTrace(item, documentOf(served.get(item.path).body)) > 0,
  );

  const record = item.records[0];
  const wrong = `${(Number(record.price_local) + 1).toFixed(record.price_local.split('.')[1]?.length ?? 0)}`;
  const mismatched = served
    .get(item.path)
    .body.replace(
      `data-price-currency="${record.currency}" data-astro-cid-fy5fejda>${money(record)}<`,
      `data-price-currency="${record.currency}" data-astro-cid-fy5fejda>${wrong} ${record.currency}<`,
    );
  assert.notEqual(
    mismatched,
    served.get(item.path).body,
    'the price was replaced',
  );
  assert.throws(
    () => assertServiceMarketTrace(item, documentOf(mismatched)),
    /shows exactly its published records/u,
  );

  assert.throws(
    () =>
      assertServiceMarketTrace(
        item,
        documentOf(planted(item.path, '<p>About 13.22 USD a month.</p>')),
      ),
    /shows 13\.22 USD, which no published record behind it holds/u,
  );
  assert.throws(
    () =>
      assertServiceMarketTrace(
        item,
        documentOf(planted(item.path, '<p>Roughly ≈ the same.</p>')),
      ),
    /shows a converted figure/u,
  );
  assert.throws(
    () =>
      assertServiceMarketTrace(
        item,
        documentOf(planted(item.path, '<p>Save 20% today.</p>')),
      ),
    /shows the number 20,/u,
  );

  // A value the gate held back (needs_review), planted on a page in its
  // currency where no published record holds it.
  const held = unpublished.find((candidate) => candidate.currency !== null);
  const host = pages.find(
    (candidate) =>
      marketsByCode.get(candidate.market).currency === held.currency &&
      !candidate.records.some((shown) => money(shown) === money(held)),
  );
  assert.ok(host, `a ${held.currency} page to plant ${money(held)} on`);
  assert.throws(
    () =>
      assertServiceMarketTrace(
        host,
        documentOf(planted(host.path, `<p>${money(held)} per month</p>`)),
      ),
    new RegExp(`shows ${escape(money(held))}, which no published record`, 'u'),
  );
});

test('red paths: the link graph fails a link to an ungenerated pair, and the copy check a source credit', () => {
  const item = pages[0];
  const ungenerated = unpublished
    .map((record) =>
      servicePagePath(record.service_id, marketsByCode.get(record.market).slug),
    )
    .find((path) => !priceRouteSet.has(path));
  assert.ok(ungenerated, 'a held-back pair with no page');
  assertLinksResolve(item.path, page(item.path));
  assert.throws(
    () =>
      assertLinksResolve(
        item.path,
        documentOf(planted(item.path, `<a href="${ungenerated}">More</a>`)),
      ),
    /which the data does not generate/u,
  );
  assert.throws(
    () =>
      assertLinksResolve(
        item.path,
        documentOf(planted(item.path, '<a href="/not-a-page">More</a>')),
      ),
    /which is not a page of the site/u,
  );
  assertNoSourceCredit(item.path, served.get(item.path).body);
  for (const name of sourceNames)
    assert.throws(
      () =>
        assertNoSourceCredit(
          item.path,
          planted(item.path, `<p>Data: ${name.toUpperCase()}</p>`),
        ),
      /names the data source/u,
    );
});

test('red paths: the breadcrumb check refuses malformed BreadcrumbList data', () => {
  const path = pages[0].path;
  const valid = structuredData(page(path))[1];
  assert.deepEqual(breadcrumbListIssues(valid, path), []);
  const broken = [
    { ...valid, '@type': 'ItemList' },
    { ...valid, itemListElement: [] },
    { ...valid, itemListElement: [...valid.itemListElement].reverse() },
    { ...valid, itemListElement: valid.itemListElement.slice(0, 1) },
    {
      ...valid,
      itemListElement: valid.itemListElement.map((item) => ({
        ...item,
        name: '',
      })),
    },
    {
      ...valid,
      itemListElement: valid.itemListElement.map((item) => ({
        ...item,
        item: item.item.replace('https://valstara.com', 'https://example.com'),
      })),
    },
    { ...valid, extra: true },
  ];
  for (const data of broken)
    assert.notDeepEqual(
      breadcrumbListIssues(data, path),
      [],
      JSON.stringify(data),
    );
});
