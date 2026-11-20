import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';

import {
  generatedPages,
  publishedView,
  rankMarkets,
} from '../packages/price-index/src/publish/index.ts';
import {
  checkRenderedHead,
  priceCardTitle,
  socialCardCacheDirectory,
  socialCardManifestFile,
} from '../scripts/ci/seo-build-check.ts';
import { createPriceSite } from '../src/server/prices/site.ts';
import { pricesPausedRetryAfterSeconds } from '../src/server/prices/route.ts';
import { createReferralCaptureService } from '../src/server/referral/capture.ts';
import {
  canonicalUrl,
  socialFallbackImageUrl,
  socialImageUrl,
} from '../src/server/seo.ts';
import { faqPageIssues } from './helpers/faq-page-data.mjs';
import { startAppServer } from './helpers/listen-port.mjs';
import {
  priceFixtureInputs,
  priceFixtureSite,
} from './helpers/price-fixture-site.mjs';

// E11.6-10: the service × market page, built and served over the fixture
// dataset in test/fixtures/price-index/pages/ (eight generated pages, four
// ledger URLs without publishable data, and pairs that generate nothing).
// Every assertion reads the served HTTP response of the real built app.
// E11.6-11 adds the content blocks: price history, the cross-market
// comparison, related services, the FAQ and the Valstara price.

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const referralSecret = 'price-pages-rendered-referral-secret';

const inputs = await priceFixtureInputs();
const site = createPriceSite(inputs);
const generated = site.routes.filter((route) => route.kind === 'generated');
const unavailable = site.routes.filter((route) => route.kind === 'unavailable');
// Pairs the fixture data does not generate and the ledger does not hold:
// a conflict, a missing record, a needs_review record, a market with no
// record, an unknown service, and a slug in the wrong case.
const unknownPaths = [
  '/prices/spotify/norway',
  '/prices/spotify/germany',
  '/prices/apple-music/united-kingdom',
  '/prices/duolingo/sweden',
  '/prices/not-a-service/sweden',
  '/prices/spotify/Sweden',
];

let fixtureRoot;
let database;
let databaseUrl;
let databaseName;
let admin;
let server;

async function startServer() {
  return startAppServer({
    label: 'Price-page rendered test',
    cwd: fixtureRoot,
    env: () => ({
      ADMIN_CREDENTIAL: 'price-pages-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'price-pages-rendered-prefix-pepper',
      REFERRAL_SIGNING_SECRET: referralSecret,
      RESEND_API_KEY: 'price-pages-rendered-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'price-pages-rendered-turnstile-secret',
      HOST: '127.0.0.1',
    }),
  });
}

async function get(path) {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${server.port}${path}`,
    { redirect: 'manual', signal: globalThis.AbortSignal.timeout(10_000) },
  );
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

before(async () => {
  ({ root: fixtureRoot } = await priceFixtureSite());
  databaseName = `valstara_prices_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await executeFile(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'price-pages-rendered-test'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: databaseUrl,
        VALSTARA_APP_DB_PASSWORD: appPassword,
      },
    },
  );
  database = new Pool({ connectionString: databaseUrl });
  server = await startServer();
});

after(async () => {
  await server?.stop();
  await database?.end();
  if (admin !== undefined) {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

/** A served card image's bytes, from its absolute card URL. */
async function getImage(url) {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${server.port}${new URL(url).pathname}`,
    { signal: globalThis.AbortSignal.timeout(10_000) },
  );
  assert.equal(response.status, 200, url);
  assert.equal(response.headers.get('content-type'), 'image/png', url);
  return globalThis.Buffer.from(await response.arrayBuffer());
}

/** The visible text of some HTML: no scripts, styles, tags or entities. */
function visibleText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ');
}

/** The page's own content: from the breadcrumbs to the independence line. */
function priceBody(html) {
  const start = html.indexOf('<nav class="price-breadcrumbs');
  const end = html.indexOf('</p>', html.indexOf('price-page__independent'));
  assert.ok(start > 0 && end > start, 'the price body is present');
  return html.slice(start, end);
}

function rows(html) {
  return [
    ...html.matchAll(
      /<tr data-plan="([^"]+)" data-billing-period="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gu,
    ),
  ].map(([, plan, period, cells]) => {
    const amount =
      /data-price-amount="([^"]+)" data-price-currency="([^"]+)"[^>]*>\s*([^<]*?)\s*<\/span>/u.exec(
        cells,
      );
    const time = /<time datetime="([^"]+)"[^>]*>([^<]*)<\/time>/u.exec(cells);
    return {
      plan,
      period,
      amount: amount?.[1],
      currency: amount?.[2],
      shown: amount?.[3],
      verifiedOn: time?.[1],
    };
  });
}

const signedFieldPattern =
  /name="referral_capture"\s+type="hidden"\s+value="([^"]+)"/u;

test('the fixture dataset generates eight pages and leaves four ledger URLs unavailable', () => {
  assert.deepEqual(
    generated.map((route) => route.path),
    [
      '/prices/apple-music/sweden',
      '/prices/duolingo/france',
      '/prices/netflix/sweden',
      '/prices/netflix/united-states',
      '/prices/spotify/france',
      '/prices/spotify/sweden',
      '/prices/spotify/united-kingdom',
      '/prices/spotify/united-states',
    ],
  );
  assert.deepEqual(
    unavailable.map((route) => route.path),
    [
      '/prices/apple-music/united-states',
      '/prices/chatgpt/united-kingdom',
      '/prices/crunchyroll/sweden',
      '/prices/spotify/finland',
    ],
  );
});

test('every generated pair renders its page, a ledger URL with lost data renders the unavailable state, and any other pair is a 404', async () => {
  for (const route of generated) {
    const page = await get(route.path);
    assert.equal(page.status, 200, route.path);
    assert.match(page.body, /data-price-page="generated"/u, route.path);
    assert.doesNotMatch(page.body, /name="robots"/u, `${route.path} indexable`);
    assert.equal(page.headers.get('x-robots-tag'), null, route.path);
  }
  for (const route of unavailable) {
    const page = await get(route.path);
    assert.equal(page.status, 200, `${route.path} never answers 404`);
    assert.match(page.body, /data-price-page="unavailable"/u, route.path);
    assert.match(page.body, /<meta name="robots" content="noindex"/u);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assert.match(page.body, /data-unavailable/u);
    assert.doesNotMatch(page.body, /data-price-amount|data-price-table/u);
    // ChatGPT in the United Kingdom has a stale 20.00 GBP: never shown.
    assert.doesNotMatch(visibleText(page.body), /20\.00|GBP|£/u);
    assert.match(visibleText(page.body), new RegExp(route.heading, 'u'));
  }
  for (const path of unknownPaths) {
    const page = await get(path);
    assert.equal(page.status, 404, path);
    assert.match(page.body, /data-task-state="not-found"/u, path);
    assert.doesNotMatch(page.body, /data-price-page/u, path);
  }
});

const published = generatedPages(
  inputs.latest,
  inputs.catalogue,
  inputs.markets,
);
// Every USD figure in the dataset, of records in another currency.
const usdFigures = inputs.latest.records
  .filter((record) => record.currency !== 'USD')
  .map((record) => record.price_usd_source)
  .filter((figure) => figure !== null);
// The US market's published prices: the only amounts a page may show in USD,
// as a local price, never as a figure for another market.
const usPrices = new Set(
  publishedView(inputs.latest)
    .records.filter((record) => record.market === 'US')
    .map((record) => record.price_local),
);

/**
 * Every figure a generated page may show, each traced from the fixture
 * files without the view model: its published records' prices and
 * verification days and years; their changes.json entries (in the record's
 * currency) and those entries' years; and, where `rankMarkets()` ranks the
 * page's market for a plan, its rank, M and the ranked records' prices.
 */
function tracedFigures(expected) {
  const allowed = new Set();
  for (const record of expected.records) {
    allowed.add(record.price_local);
    const [year, , day] = record.source_verified_at.split('-');
    allowed.add(year);
    allowed.add(String(Number(day)));
    for (const change of inputs.changes.changes) {
      if (
        change.market === record.market &&
        change.service_id === record.service_id &&
        change.plan_id === record.plan_id &&
        change.billing_period === record.billing_period &&
        change.currency === record.currency
      ) {
        allowed.add(change.old_price_local);
        allowed.add(change.new_price_local);
        allowed.add(change.detected_on.slice(0, 4));
      }
    }
    const ranking = rankMarkets(inputs.latest, {
      service_id: record.service_id,
      plan_id: record.plan_id,
      billing_period: record.billing_period,
    });
    const own = ranking.find((ranked) => ranked.market === record.market);
    if (own !== undefined) {
      allowed.add(String(own.rank));
      allowed.add(String(ranking.length));
      for (const ranked of ranking) allowed.add(ranked.record.price_local);
    }
  }
  return allowed;
}

/**
 * Asserts that every number in a served page's own content (from the
 * breadcrumbs to the independence line) is in `allowed`. Configured names
 * are not figures ("Premium (4K)"), so they are removed before the scan.
 */
function assertNumbersTrace(path, html, allowed) {
  let body = visibleText(priceBody(html));
  for (const service of inputs.catalogue.services) {
    for (const name of [
      service.name,
      ...service.plans.map((plan) => plan.name),
    ])
      body = body.replaceAll(name, ' ');
  }
  for (const [number] of body.matchAll(/\d+(?:[.,]\d+)*/gu)) {
    assert.ok(
      allowed.has(number),
      `${path} shows ${number}, which no published record or change holds`,
    );
  }
}

/** No USD figure: USD appears only after a US list price, and no "$". */
function assertNoUsdFigure(path, html) {
  const visible = visibleText(html);
  assert.doesNotMatch(visible, /\$|≈/u, path);
  const amounts = [...visible.matchAll(/(\S+) USD\b/gu)].map(
    (match) => match[1],
  );
  assert.equal(
    amounts.length,
    (visible.match(/\bUSD\b/gu) ?? []).length,
    `${path}: USD appears only after an amount`,
  );
  for (const amount of amounts) {
    assert.ok(usPrices.has(amount), `${path} shows ${amount} USD`);
  }
  for (const figure of usdFigures) {
    assert.ok(
      !html.includes(figure),
      `${path} carries the USD figure ${figure}`,
    );
  }
}

test('every number on a page equals the published record or change it came from, in every block, and no USD figure appears', async () => {
  const latest = inputs.latest;
  assert.ok(usdFigures.length >= 9);
  // Values the gate keeps off the pages: needs_review, stale and conflict.
  const refused = latest.records.filter(
    (record) =>
      record.price_local !== null &&
      !publishedView(latest).records.some(
        (shown) =>
          shown.market === record.market &&
          shown.service_id === record.service_id &&
          shown.plan_id === record.plan_id,
      ),
  );
  assert.ok(refused.length >= 5);
  // A change of a plan the gate leaves off its page (Netflix Standard in
  // Sweden, Duolingo Max in France) is never shown.
  const hiddenChanges = {
    '/prices/netflix/sweden': ['119.00', '129.00'],
    '/prices/duolingo/france': ['27.99'],
  };

  for (const route of generated) {
    const page = await get(route.path);
    const expected = published.find((item) => item.path === route.path);
    assert.ok(expected, route.path);
    const shown = rows(page.body);
    assert.deepEqual(
      shown.map((row) => ({
        plan: row.plan,
        period: row.period,
        amount: row.amount,
        currency: row.currency,
        shown: row.shown,
        verifiedOn: row.verifiedOn,
      })),
      expected.records.map((record) => ({
        plan: record.plan_id,
        period: record.billing_period,
        amount: record.price_local,
        currency: record.currency,
        shown: `${record.price_local} ${record.currency}`,
        verifiedOn: record.source_verified_at,
      })),
      `${route.path} shows exactly its published records`,
    );

    assertNumbersTrace(route.path, page.body, tracedFigures(expected));
    assertNoUsdFigure(route.path, page.body);
    for (const record of refused.filter(
      (item) =>
        item.service_id === expected.service_id &&
        item.market === expected.market,
    )) {
      assert.ok(
        !visibleText(page.body).includes(record.price_local),
        `${route.path} shows the unpublished ${record.price_local}`,
      );
    }
    for (const value of hiddenChanges[route.path] ?? []) {
      assert.ok(
        !visibleText(priceBody(page.body)).includes(value),
        `${route.path} shows ${value} from a hidden plan's history`,
      );
    }
    assert.doesNotMatch(
      page.body,
      /youfundceo/iu,
      'no page credits the source',
    );
  }
  for (const route of unavailable) {
    const page = await get(route.path);
    for (const figure of usdFigures) assert.ok(!page.body.includes(figure));
    assert.doesNotMatch(page.body, /youfundceo/iu);
    assert.doesNotMatch(
      page.body,
      /data-price-history|data-price-comparison|data-price-related|data-price-faq|data-valstara-comparison/u,
      `${route.path} has no content block`,
    );
  }
});

/** Each item of a list of `data-<name>` elements, with its visible text. */
function blockItems(html, attribute) {
  return [
    ...html.matchAll(
      new RegExp(
        `<(\\w+)\\b[^>]*?\\s${attribute}(?:="([^"]*)")?(?=[\\s>])[^>]*>([\\s\\S]*?)</\\1>`,
        'gu',
      ),
    ),
  ].map(([, , value, inner]) => ({ value, text: visibleText(inner).trim() }));
}

test('price history renders where changes.json has changes of the shown plans, newest first, and is absent otherwise', async () => {
  const spotify = await get('/prices/spotify/sweden');
  assert.match(spotify.body, /data-price-history/u);
  assert.deepEqual(
    [
      ...spotify.body.matchAll(
        /data-history-plan="([^"]+)" data-history-old="([^"]+)" data-history-new="([^"]+)" data-history-currency="([^"]+)" data-history-date="([^"]+)"/gu,
      ),
    ].map((match) => match.slice(1)),
    [
      ['individual', '129.00', '149.00', 'SEK', '2026-10-02'],
      ['individual', '119.00', '129.00', 'SEK', '2026-03-03'],
    ],
  );
  assert.match(
    visibleText(spotify.body),
    /Price history Individual Raised from 129\.00 SEK to 149\.00 SEK in October 2026\. Individual Raised from 119\.00 SEK to 129\.00 SEK in March 2026\./u,
  );
  const netflix = await get('/prices/netflix/sweden');
  assert.match(
    visibleText(netflix.body),
    /Basic Lowered from 109\.00 SEK to 99\.00 SEK in September 2026\./u,
  );
  for (const path of [
    '/prices/duolingo/france',
    '/prices/netflix/united-states',
    '/prices/spotify/france',
  ]) {
    const page = await get(path);
    assert.doesNotMatch(page.body, /data-price-history/u, path);
    assert.doesNotMatch(visibleText(page.body), /Price history/u, path);
  }
});

test('the rank sentence and the cheapest and most expensive markets render only where this market is ranked among two or more', async () => {
  const sentences = {
    '/prices/spotify/sweden':
      'Sweden is the most expensive of our 3 markets for Spotify Premium — Individual.',
    '/prices/spotify/united-kingdom':
      'The United Kingdom is the 2nd most expensive of our 3 markets for Spotify Premium — Individual.',
    '/prices/spotify/united-states':
      'The United States is the 3rd most expensive of our 3 markets for Spotify Premium — Individual.',
  };
  for (const [path, sentence] of Object.entries(sentences)) {
    const { body } = await get(path);
    assert.deepEqual(
      blockItems(body, 'data-rank-sentence').map((item) => item.text),
      [sentence],
    );
    assert.deepEqual(
      [
        ...body.matchAll(
          /<tr data-extreme-market="([A-Z]{2})"[^>]*>[\s\S]*?data-extreme-amount="([^"]+)" data-extreme-currency="([^"]+)"/gu,
        ),
      ].map((match) => match.slice(1)),
      [
        ['SE', '149.00', 'SEK'],
        ['US', '12.99', 'USD'],
      ],
      path,
    );
  }
  for (const path of [
    '/prices/spotify/france',
    '/prices/netflix/sweden',
    '/prices/apple-music/sweden',
    '/prices/duolingo/france',
    '/prices/netflix/united-states',
  ]) {
    const { body } = await get(path);
    assert.doesNotMatch(
      body,
      /data-price-comparison|data-rank-sentence/u,
      path,
    );
  }
});

test('related links point only at generated pages, each of which answers 200 with its page', async () => {
  const linked = new Map();
  for (const route of generated) {
    const { body } = await get(route.path);
    const links = [
      ...body.matchAll(/<a href="([^"]+)" data-related-service="([^"]+)"/gu),
    ].map((match) => match[1]);
    linked.set(route.path, links);
    for (const path of links) {
      const target = await get(path);
      assert.equal(target.status, 200, path);
      assert.match(target.body, /data-price-page="generated"/u, path);
      assert.ok(
        generated.some((item) => item.path === path),
        path,
      );
    }
  }
  assert.deepEqual(linked.get('/prices/spotify/sweden'), [
    '/prices/apple-music/sweden',
  ]);
  assert.deepEqual(linked.get('/prices/apple-music/sweden'), [
    '/prices/spotify/sweden',
  ]);
  // Apple Music in the US is a ledger URL without data: never linked.
  assert.deepEqual(linked.get('/prices/spotify/united-states'), []);
  assert.deepEqual(linked.get('/prices/spotify/united-kingdom'), []);
});

test('the FAQ renders on every generated page with FAQPage data that validates and matches it, and neither is on an unavailable page', async () => {
  for (const route of generated) {
    const { body } = await get(route.path);
    const structured = [
      ...body.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu,
      ),
    ]
      .map((match) => JSON.parse(match[1]))
      .filter((data) => data['@type'] === 'FAQPage');
    assert.equal(structured.length, 1, route.path);
    assert.deepEqual(faqPageIssues(structured[0]), [], route.path);
    const visible = [
      ...body.matchAll(
        /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gu,
      ),
    ].map(([, question, answer]) => ({
      question: visibleText(question).trim(),
      answer: visibleText(answer).trim(),
    }));
    assert.deepEqual(
      structured[0].mainEntity.map((entry) => ({
        question: entry.name,
        answer: entry.acceptedAnswer.text,
      })),
      visible,
      `${route.path}: the FAQPage data is the visible FAQ`,
    );
    assert.equal(visible[0].question.startsWith('How much does'), true);
  }
  const spotify = await get('/prices/spotify/sweden');
  assert.deepEqual(
    [...spotify.body.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/gu)].map((match) =>
      visibleText(match[1]).trim(),
    ),
    [
      'How much does Spotify Premium cost in Sweden?',
      'How does the Spotify Premium price in Sweden compare with other markets?',
      'Has the Spotify Premium price in Sweden changed?',
    ],
  );
  for (const route of unavailable) {
    const { body } = await get(route.path);
    assert.doesNotMatch(body, /FAQPage|data-price-faq/u, route.path);
  }
});

test('with prices.valstara_comparison off (the default), no Valstara price renders, though config/valstara-prices.json has entries', async () => {
  assert.ok(inputs.valstaraPrices.prices.length > 0);
  for (const route of site.routes) {
    const { body } = await get(route.path);
    assert.doesNotMatch(
      body,
      /data-valstara-comparison|data-valstara-amount|below list price|The Valstara price/u,
      route.path,
    );
    for (const value of ['1490.00', '1788.00', '199.00', '33.00', '35.97']) {
      assert.ok(!visibleText(body).includes(value), `${route.path} ${value}`);
    }
  }
});

test('each price page has a unique title and description, a self-canonical, its own card or the prices fallback, and BreadcrumbList data', async () => {
  const seen = { titles: new Set(), descriptions: new Set() };
  for (const route of site.routes) {
    const page = await get(route.path);
    checkRenderedHead(page.body, route.path, seen);
    assert.match(
      page.body,
      new RegExp(
        `<meta property="og:image" content="${socialFallbackImageUrl('prices').replaceAll('.', '\\.')}"`,
        'u',
      ),
    );
    const structured = [
      ...page.body.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu,
      ),
    ].map((match) => JSON.parse(match[1]));
    const breadcrumbs = structured.find(
      (data) => data['@type'] === 'BreadcrumbList',
    );
    assert.deepEqual(breadcrumbs, {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Valstara',
          item: 'https://valstara.com/',
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: route.breadcrumbs[1].name,
          item: canonicalUrl(route.path),
        },
      ],
    });
    // E11.6-14: a generated page serves its own card; a ledger URL that
    // publishes no page serves the typed prices card.
    const card = await getImage(socialImageUrl(route.path));
    const fallback = await getImage(socialFallbackImageUrl('prices'));
    if (route.kind === 'generated') {
      assert.notDeepEqual(card, fallback, route.path);
    } else {
      assert.deepEqual(card, fallback, route.path);
    }
  }
  assert.equal(seen.titles.size, site.routes.length);
});

test('the price on a card equals the first plan row of the served page, and the served card is that render', async () => {
  // E11.6-14 (D-038 Q1): the build's card manifest records the text each
  // card was rendered from, and the sha-256 of the PNG it rendered.
  const manifest = JSON.parse(
    await readFile(
      join(fixtureRoot, socialCardCacheDirectory, socialCardManifestFile),
      'utf8',
    ),
  );
  for (const route of generated) {
    const page = await get(route.path);
    assert.equal(page.status, 200, route.path);
    const firstRow =
      /<tr data-plan="[^"]+" data-billing-period="[^"]+"[^>]*>\s*<th scope="row"[^>]*>([^<]*)<\/th>[\s\S]*?<span class="price-table__amount"[^>]*>\s*([^<]*?)\s*<\/span>\s*<span class="price-table__period"[^>]*>\s*([^<]*?)\s*<\/span>/u.exec(
        page.body,
      );
    assert.ok(firstRow, `${route.path} serves a plan row`);
    const [, plan, price, period] = firstRow.map((text) =>
      visibleText(text).trim(),
    );
    const output = new URL(socialImageUrl(route.path)).pathname.slice(1);
    const card = manifest.cards[output];
    assert.ok(card, `${route.path} has a card in the manifest`);
    assert.equal(card.priceLine, `${plan} · ${price} ${period}`, route.path);
    // D-039 Q1: the card title is the page's SEO title without its brand
    // suffix; the card's wordmark carries the brand.
    assert.ok(route.meta.title.endsWith(' — Valstara'), route.path);
    assert.equal(card.title, priceCardTitle(route.meta.title), route.path);
    assert.equal(
      card.title,
      route.meta.title.slice(0, -' — Valstara'.length),
      route.path,
    );
    const served = await getImage(socialImageUrl(route.path));
    assert.equal(
      createHash('sha256').update(served).digest('hex'),
      manifest.images[card.key],
      `${route.path} serves the card rendered from that line`,
    );
  }
  // An unavailable ledger URL has no card of its own, so no price line.
  for (const route of unavailable) {
    const output = new URL(socialImageUrl(route.path)).pathname.slice(1);
    assert.equal(manifest.cards[output], undefined, route.path);
  }
});

test('a ref-less default render is cacheable by flag generation; a ?ref= render is private, no-store', async () => {
  for (const route of site.routes) {
    const plain = await get(route.path);
    assert.equal(
      plain.headers.get('cache-control'),
      'public, max-age=0, s-maxage=300',
      route.path,
    );
    assert.equal(plain.headers.get('vary'), 'X-Valstara-Flag-Generation');
    assert.match(
      plain.headers.get('x-valstara-flag-generation') ?? '',
      /^[a-f0-9]{16}$/u,
    );
    assert.equal(plain.headers.get('set-cookie'), null);
    assert.doesNotMatch(plain.body, /name="referral_capture"/u);
    const referred = await get(`${route.path}?ref=ABCDEFGHJKMN`);
    assert.equal(referred.headers.get('cache-control'), 'private, no-store');
    assert.equal(referred.headers.get('set-cookie'), null);
  }
});

test('a ?ref= visit renders the signed field exactly as on /, and a cached render signs each visit afresh', async () => {
  const capture = createReferralCaptureService(referralSecret);
  const path = '/prices/spotify/sweden?ref=ABCDEFGHJKMN&utm_source=newsletter';
  const first = signedFieldPattern.exec((await get(path)).body)?.[1];
  const landing = signedFieldPattern.exec(
    (await get('/?ref=ABCDEFGHJKMN&utm_source=newsletter')).body,
  )?.[1];
  assert.ok(first && landing);
  assert.deepEqual(capture.verifyRef(first), capture.verifyRef(landing));
  assert.deepEqual(capture.verifyRef(first), {
    ref: 'ABCDEFGHJKMN',
    utm: { source: 'newsletter' },
  });
  // A second code on the same page, served through the render cache, gets
  // its own field.
  const second = signedFieldPattern.exec(
    (await get('/prices/spotify/sweden?ref=PQRSTUVWXYZ2')).body,
  )?.[1];
  assert.deepEqual(capture.verifyRef(second), {
    ref: 'PQRSTUVWXYZ2',
    utm: null,
  });
  // The unavailable state carries the form and the field too.
  const fromLedger = signedFieldPattern.exec(
    (await get('/prices/spotify/finland?ref=ABCDEFGHJKMN')).body,
  )?.[1];
  assert.equal(capture.verifyRef(fromLedger)?.ref, 'ABCDEFGHJKMN');
});

test('a signup from a ?ref= price page is attributed exactly as one from /', async () => {
  const referrerId = randomUUID();
  await database.query(
    `INSERT INTO subscriber
      (id, email, email_normalised, email_domain, status, verified_at,
       referral_code, access_window)
     VALUES ($1, 'price-referrer@example.test', 'price-referrer@example.test',
       'example.test', 'verified', $2, 'ABCDEFGHJKMN', 'wave-1')`,
    [referrerId, new Date('2026-10-01T00:00:00.000Z')],
  );
  const query = '?ref=ABCDEFGHJKMN&utm_source=newsletter';
  const fromPrice = signedFieldPattern.exec(
    (await get(`/prices/netflix/sweden${query}`)).body,
  )?.[1];
  const fromLanding = signedFieldPattern.exec(
    (await get(`/${query}`)).body,
  )?.[1];
  assert.ok(fromPrice && fromLanding);

  // The signup route, in process, against the same database and secret: the
  // form posts the field the page rendered, and the route attributes it.
  const environment = {
    ADMIN_CREDENTIAL: 'price-pages-admin-credential-32-chars',
    ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    DATABASE_URL: databaseUrl,
    IP_PREFIX_PEPPER: 'price-pages-rendered-prefix-pepper',
    REFERRAL_SIGNING_SECRET: referralSecret,
    RESEND_API_KEY: 'price-pages-rendered-resend-key',
    RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
    RESEND_KEY_MODE: 'test',
    RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
    RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
    RESEND_SENDING_DOMAIN: 'send.valstara.com',
    TURNSTILE_SECRET_KEY: 'price-pages-rendered-turnstile-secret',
  };
  const originalEnvironment = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, environment);
  globalThis.fetch = async (input) => {
    const url = input instanceof globalThis.Request ? input.url : String(input);
    if (url.includes('challenges.cloudflare.com')) {
      return globalThis.Response.json({ success: true });
    }
    if (url.endsWith('/api/send'))
      return globalThis.Response.json({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const { POST } = await import('../src/pages/api/signup.ts');
    const submit = async (email, field, clientAddress) =>
      POST({
        clientAddress,
        request: new globalThis.Request('http://valstara.test/api/signup', {
          method: 'POST',
          body: new globalThis.URLSearchParams({
            email,
            turnstile_token: 'token',
            referral_capture: field,
          }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      });
    const priceResponse = await submit(
      'price-page-signup@gmail.com',
      fromPrice,
      '203.0.113.21',
    );
    assert.equal(priceResponse.status, 200, await priceResponse.clone().text());
    const landingResponse = await submit(
      'landing-signup@gmail.com',
      fromLanding,
      '203.0.113.22',
    );
    assert.equal(landingResponse.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(environment)) {
      if (originalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnvironment[key];
    }
  }

  const attribution = async (email) =>
    (
      await database.query(
        `SELECT edge.referrer_id, edge.state, edge.reward_state, person.utm
           FROM subscriber person
           JOIN referral_edge edge ON edge.referred_id = person.id
          WHERE person.email_normalised = $1`,
        [email],
      )
    ).rows;
  const priceEdges = await attribution('price-page-signup@gmail.com');
  const landingEdges = await attribution('landing-signup@gmail.com');
  assert.equal(priceEdges.length, 1, 'the price-page signup is attributed');
  assert.equal(priceEdges[0].referrer_id, referrerId);
  assert.deepEqual(priceEdges, landingEdges);
});

test('a price page loads no script beyond the theme toggle, the signup form, Turnstile, the page-view emitter and its structured data', async () => {
  for (const route of site.routes) {
    const { body } = await get(route.path);
    const scripts = [
      ...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu),
    ].map(([, attributes, content]) => ({ attributes, content }));
    const theme = scripts.filter((script) =>
      script.content.includes('valstara-theme'),
    );
    const signupIsland = scripts.filter((script) =>
      /SignupForm\.astro[^"']*\.js/u.test(script.attributes),
    );
    const turnstile = scripts.filter((script) =>
      script.attributes.includes('challenges.cloudflare.com/turnstile'),
    );
    const pageView = scripts.filter((script) =>
      script.attributes.includes('src="/page-view.js"'),
    );
    const structured = scripts.filter((script) =>
      script.attributes.includes('type="application/ld+json"'),
    );
    assert.equal(theme.length, 2, `${route.path} theme toggle`);
    assert.equal(signupIsland.length, 1, `${route.path} signup island`);
    assert.equal(turnstile.length, 1, `${route.path} Turnstile loader`);
    assert.equal(pageView.length, 1, `${route.path} page-view emitter`);
    // E11.6-11: a generated page also carries its FAQ's FAQPage data.
    assert.deepEqual(
      structured.map((script) => JSON.parse(script.content)['@type']).sort(),
      route.kind === 'generated'
        ? ['BreadcrumbList', 'FAQPage', 'Organization']
        : ['BreadcrumbList', 'Organization'],
    );
    assert.equal(
      scripts.length,
      theme.length +
        signupIsland.length +
        turnstile.length +
        pageView.length +
        structured.length,
      `${route.path} ships no other script`,
    );
    assert.ok(!/client:(?:load|idle|visible|media|only)/u.test(body));
    // Every external script is first-party, apart from the Turnstile loader.
    for (const [, source] of body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gu)) {
      assert.ok(
        source.startsWith('/') ||
          source.startsWith('https://challenges.cloudflare.com/turnstile/'),
        `${route.path} loads ${source}`,
      );
    }
  }
});

test('the sitemap index lists every child sitemap, pages.xml keeps the previous entries, and the price sitemap lists generated pages with their verification dates', async () => {
  const index = await get('/sitemap.xml');
  assert.equal(index.status, 200);
  assert.deepEqual(
    [...index.body.matchAll(/<sitemap><loc>([^<]+)<\/loc><\/sitemap>/gu)].map(
      (match) => match[1],
    ),
    [
      'https://valstara.com/sitemaps/pages.xml',
      'https://valstara.com/sitemaps/prices-service-market.xml',
      // E11.6-12: the hubs' own child sitemaps
      // (test/price-hubs-rendered.test.mjs reads them).
      'https://valstara.com/sitemaps/prices-index.xml',
      'https://valstara.com/sitemaps/prices-service-hubs.xml',
      'https://valstara.com/sitemaps/prices-market-hubs.xml',
      // E11.6-13: the monthly price reports' child sitemap
      // (test/seo.test.ts reads it).
      'https://valstara.com/sitemaps/price-index-monthly.xml',
    ],
  );
  const pages = await get('/sitemaps/pages.xml');
  assert.equal(
    pages.body,
    await readFile(join(projectRoot, 'public/sitemaps/pages.xml'), 'utf8'),
  );
  const prices = await get('/sitemaps/prices-service-market.xml');
  assert.deepEqual(
    [
      ...prices.body.matchAll(
        /<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/gu,
      ),
    ].map(([, loc, lastmod]) => ({ loc, lastmod })),
    [
      ['apple-music/sweden', '2026-11-21'],
      ['duolingo/france', '2026-11-26'],
      ['netflix/sweden', '2026-11-25'],
      ['netflix/united-states', '2026-11-27'],
      ['spotify/france', '2026-11-22'],
      ['spotify/sweden', '2026-11-28'],
      ['spotify/united-kingdom', '2026-11-28'],
      ['spotify/united-states', '2026-11-27'],
    ].map(([path, lastmod]) => ({
      loc: `https://valstara.com/prices/${path}`,
      lastmod,
    })),
  );
  // Not the build date: no lastmod is the fixture's built_at day.
  assert.doesNotMatch(prices.body, /2026-12-01/u);
  for (const route of unavailable) {
    assert.ok(!prices.body.includes(route.path), `${route.path} is noindex`);
  }
});

test('with prices.valstara_comparison on, the comparison renders where an entry compares like for like or states its basis, and nowhere else', async () => {
  await server.stop();
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('prices.valstara_comparison', true, 'price-pages-rendered-test')`,
  );
  server = await startServer();
  try {
    const valstaraRows = (body) =>
      [
        ...body.matchAll(
          /<tr data-valstara-plan="([^"]+)" data-valstara-term="(\d+)"[^>]*>[\s\S]*?data-list-amount="([^"]+)"[\s\S]*?data-valstara-amount="([^"]+)"[\s\S]*?data-below-percent="([^"]+)"/gu,
        ),
      ].map((match) => match.slice(1));
    // Hand-computed: 149.00 vs 119.00 is 20.13…% below; 12 × 149.00 =
    // 1788.00 vs 1490.00 is 16.66…%; 3 × 11.99 = 35.97 vs 33.00 is 8.25…%;
    // 229.00 vs 199.00 is 13.10…%. Each floored to one decimal.
    const expected = {
      '/prices/spotify/sweden': [
        ['individual', '1', '149.00', '119.00', '20.1'],
        ['individual', '12', '1788.00', '1490.00', '16.6'],
      ],
      '/prices/spotify/united-kingdom': [
        ['individual', '3', '35.97', '33.00', '8.2'],
      ],
      '/prices/netflix/sweden': [['premium', '1', '229.00', '199.00', '13.1']],
    };
    const bases = {
      '/prices/spotify/sweden': [
        'For 12 months of Spotify Premium — Individual, the list price shown is the monthly list price, 149.00 SEK, multiplied by 12.',
      ],
      '/prices/spotify/united-kingdom': [
        'For 3 months of Spotify Premium — Individual, the list price shown is the monthly list price, 11.99 GBP, multiplied by 3.',
      ],
      '/prices/netflix/sweden': [],
    };
    for (const route of site.routes) {
      const page = await get(route.path);
      assert.equal(page.status, 200, route.path);
      // A non-default flag state is never cached.
      assert.equal(page.headers.get('cache-control'), 'private, no-store');
      const rowsShown = valstaraRows(page.body);
      assert.deepEqual(rowsShown, expected[route.path] ?? [], route.path);
      // Every term other than the plan's billing period states its basis.
      assert.deepEqual(
        blockItems(page.body, 'data-valstara-basis').map((item) => item.text),
        bases[route.path] ?? [],
        route.path,
      );
      if (rowsShown.length === 0) {
        assert.doesNotMatch(page.body, /data-valstara-comparison/u, route.path);
        continue;
      }
      for (const [, , , , percent] of rowsShown) {
        assert.match(
          visibleText(page.body),
          new RegExp(`${percent.replace('.', '\\.')}% below list price`, 'u'),
        );
      }
      // The number trace, with the Valstara figures: the entry's price at
      // the currency's exponent, the compared list price, the term and the
      // percentage, each hand-computed above.
      const allowed = tracedFigures(
        published.find((item) => item.path === route.path),
      );
      for (const [, term, list, valstara, percent] of rowsShown) {
        for (const figure of [term, list, valstara, percent]) {
          allowed.add(figure);
        }
      }
      assertNumbersTrace(route.path, page.body, allowed);
      assertNoUsdFigure(route.path, page.body);
      // The signup form stays beside the comparison.
      assert.match(page.body, /name="email"/u, route.path);
    }
  } finally {
    await server.stop();
    await database.query(
      `DELETE FROM campaign_flag WHERE key = 'prices.valstara_comparison'`,
    );
    server = await startServer();
  }
});

test('prices.pages off answers 503 with Retry-After and noindex on every price route', async () => {
  await server.stop();
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('prices.pages', false, 'price-pages-rendered-test')`,
  );
  server = await startServer();
  const sitemap = await get('/sitemaps/prices-service-market.xml');
  for (const path of [
    ...site.routes.map((route) => route.path),
    ...unknownPaths,
    '/prices/spotify/sweden?ref=ABCDEFGHJKMN',
  ]) {
    const page = await get(path);
    assert.equal(page.status, 503, path);
    assert.equal(
      page.headers.get('retry-after'),
      String(pricesPausedRetryAfterSeconds),
      path,
    );
    assert.equal(page.headers.get('x-robots-tag'), 'noindex', path);
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    assert.match(page.body, /<meta name="robots" content="noindex"/u, path);
    assert.match(page.body, /data-task-state="prices-paused"/u, path);
    assert.doesNotMatch(page.body, /data-price-amount|name="email"/u, path);
  }
  // The sitemap does not change with the flag.
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.body, /prices\/spotify\/sweden/u);
});
