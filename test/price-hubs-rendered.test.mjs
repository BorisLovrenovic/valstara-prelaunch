import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';

import { checkRenderedHead } from '../scripts/ci/seo-build-check.ts';
import { layoutCopy } from '../src/copy/layout.ts';
import { pricesPausedRetryAfterSeconds } from '../src/server/prices/route.ts';
import { createPriceSite } from '../src/server/prices/site.ts';
import { canonicalUrl } from '../src/server/seo.ts';
import { startAppServer } from './helpers/listen-port.mjs';
import {
  priceFixtureInputs,
  priceFixtureSite,
} from './helpers/price-fixture-site.mjs';

// E11.6-12: the service hubs, the market hubs and `/prices`, the 301 of a
// retired URL, the pages' links to their hubs and the footer's "Price
// index" link, built and served over the price-page fixture dataset
// (test/fixtures/price-index/pages/). Every assertion reads the served HTTP
// response of the real built app. The view model's cases are in
// test/price-index/price-hubs.test.ts.

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

const inputs = await priceFixtureInputs();
const site = createPriceSite(inputs);
const hubPaths = ['/prices', ...site.hubs.map((hub) => hub.path)];
const retiredPath = '/prices/crunchyroll/united-states';
// A service and a market with no page, a reserved segment, and wrong case.
const noHubPaths = [
  '/prices/chatgpt',
  '/prices/crunchyroll',
  '/prices/not-a-service',
  '/prices/countries/germany',
  '/prices/countries/not-a-market',
  '/prices/countries',
  '/prices/Spotify',
];

let fixtureRoot;
let database;
let databaseUrl;
let databaseName;
let admin;
let server;

async function startServer() {
  return startAppServer({
    label: 'Price-hub rendered test',
    cwd: fixtureRoot,
    env: () => ({
      ADMIN_CREDENTIAL: 'price-hubs-admin-credential-32-chars-x',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'price-hubs-rendered-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'price-hubs-rendered-referral-secret',
      RESEND_API_KEY: 'price-hubs-rendered-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'price-hubs-rendered-turnstile-secret',
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
  databaseName = `valstara_hubs_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await executeFile(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'price-hubs-rendered-test'],
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

/** The hub's own content, from its article to its end. */
function hubBody(html) {
  const start = html.indexOf('<article class="price-hub');
  const end = html.indexOf('</article>', start);
  assert.ok(start > 0 && end > start, 'the hub body is present');
  return html.slice(start, end);
}

/** The service hub's rows of one plan: market, rank and amount, in order. */
function serviceHubRows(html, planId) {
  const start = html.indexOf(`data-hub-plan="${planId}"`);
  assert.ok(start > 0, `plan ${planId} is on the hub`);
  const section = html.slice(start, html.indexOf('</section>', start));
  return [
    ...section.matchAll(
      /<tr data-hub-row data-hub-market="([A-Z]{2})" data-hub-rank="([^"]+)"[^>]*>[\s\S]*?<a href="([^"]+)"[\s\S]*?data-price-amount="([^"]+)" data-price-currency="([^"]+)"/gu,
    ),
  ].map(([, market, rank, path, amount, currency]) => ({
    market,
    rank: rank === 'unranked' ? null : Number(rank),
    path,
    amount,
    currency,
  }));
}

function links(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gu)].map(
    (match) => match[1],
  );
}

test('/prices and every hub render; a service or market with no page has no hub', async () => {
  for (const path of hubPaths) {
    const page = await get(path);
    assert.equal(page.status, 200, path);
    const kind = path === '/prices' ? 'index' : site.hub(path).kind;
    assert.match(page.body, new RegExp(`data-price-hub="${kind}"`, 'u'));
    assert.doesNotMatch(page.body, /name="robots"/u, `${path} is indexable`);
    assert.equal(page.headers.get('x-robots-tag'), null, path);
    assert.equal(
      page.headers.get('cache-control'),
      'public, max-age=0, s-maxage=300',
      path,
    );
    // A hub carries no signup form and no signed referral field.
    assert.doesNotMatch(page.body, /name="email"|referral_capture/u, path);
  }
  for (const path of noHubPaths) {
    const page = await get(path);
    assert.equal(page.status, 404, path);
    assert.match(page.body, /data-task-state="not-found"/u, path);
    assert.doesNotMatch(page.body, /data-price-hub/u, path);
  }
  const ref = await get('/prices/spotify?ref=ABCDEFGHJKMN');
  assert.equal(ref.status, 200);
  assert.equal(ref.headers.get('cache-control'), 'private, no-store');
});

test('every link on a served hub resolves to a generated page or a hub, and every price row is linked', async () => {
  const seen = new Set();
  for (const path of hubPaths) {
    const body = hubBody((await get(path)).body);
    for (const href of links(body)) {
      if (href === '/' || seen.has(href)) continue;
      seen.add(href);
      const target = await get(href);
      assert.equal(target.status, 200, `${path} links ${href}`);
      assert.match(
        target.body,
        /data-price-page="generated"|data-price-hub=/u,
        `${path} links ${href}, a generated page or a hub`,
      );
    }
  }
  // Every generated page and every hub is reached from some hub.
  for (const route of site.routes.filter((item) => item.kind === 'generated')) {
    assert.ok(seen.has(route.path), `${route.path} is linked from a hub`);
  }
  for (const hub of site.hubs) {
    assert.ok(seen.has(hub.path), `${hub.path} is linked from /prices`);
  }
  // No unavailable ledger URL and no retired URL is linked.
  for (const route of site.routes.filter(
    (item) => item.kind === 'unavailable',
  )) {
    assert.ok(!seen.has(route.path), route.path);
  }
  assert.ok(!seen.has(retiredPath));
});

test('every served service × market page links to both of its hubs', async () => {
  for (const route of site.routes) {
    const { body } = await get(route.path);
    const hubLinks = [
      ...body.matchAll(/<a href="([^"]+)" data-hub-link="([^"]+)"/gu),
    ].map((match) => match[1]);
    if (route.kind === 'generated') {
      const slug = route.path.split('/')[3];
      assert.deepEqual(
        hubLinks,
        [`/prices/${route.serviceId}`, `/prices/countries/${slug}`],
        route.path,
      );
    }
    for (const href of hubLinks) {
      const hub = await get(href);
      assert.equal(hub.status, 200, `${route.path} links ${href}`);
      assert.match(hub.body, /data-price-hub=/u);
    }
  }
});

test('the served service hub orders its markets as each page’s own rank sentence does, unranked markets last', async () => {
  const { body } = await get('/prices/spotify');
  const rows = serviceHubRows(body, 'individual');
  assert.deepEqual(
    rows.map((row) => [row.market, row.rank]),
    [
      ['SE', 1],
      ['GB', 2],
      ['US', 3],
      ['FR', null],
    ],
  );
  let compared = 0;
  for (const row of rows) {
    const page = (await get(row.path)).body;
    const rank =
      /data-comparison-plan="individual" data-comparison-rank="(\d+)" data-comparison-markets="(\d+)"/u.exec(
        page,
      );
    if (row.rank === null) {
      // France has no USD figure: its page has no rank sentence.
      assert.equal(rank, null, row.path);
      continue;
    }
    assert.equal(Number(rank?.[1]), row.rank, row.path);
    assert.equal(
      Number(rank?.[2]),
      rows.filter((other) => other.rank !== null).length,
      row.path,
    );
    compared += 1;
  }
  assert.equal(compared, 3);
});

test('no served hub shows a USD figure or a converted price', async () => {
  const usdFigures = inputs.latest.records
    .filter(
      (record) => record.price_usd_source !== null && record.currency !== 'USD',
    )
    .map((record) => record.price_usd_source);
  assert.ok(usdFigures.length > 5);
  for (const path of hubPaths) {
    const body = hubBody((await get(path)).body);
    const text = visibleText(body);
    for (const figure of usdFigures) {
      assert.ok(!text.includes(figure), `${path} shows ${figure}`);
    }
    assert.doesNotMatch(text, /\$/u, path);
    // Every amount is in its own market's currency: USD only on US rows.
    for (const [, market, currency] of body.matchAll(
      /data-hub-market="([A-Z]{2})"[\s\S]*?data-price-currency="([A-Z]{3})"/gu,
    )) {
      const own = inputs.markets.markets.find((item) => item.code === market);
      assert.equal(currency, own.currency, `${path} ${market}`);
    }
  }
  const unitedKingdom = visibleText(
    hubBody((await get('/prices/countries/united-kingdom')).body),
  );
  assert.match(unitedKingdom, /11\.99 GBP/u);
  assert.doesNotMatch(unitedKingdom, /USD|SEK|EUR/u);
});

test('a retired URL answers 301 to its recorded hub and is in no sitemap', async () => {
  const page = await get(retiredPath);
  assert.equal(page.status, 301);
  assert.equal(page.headers.get('location'), '/prices/countries/united-states');
  const target = await get(page.headers.get('location'));
  assert.equal(target.status, 200);
  for (const child of [
    '/sitemaps/prices-service-market.xml',
    '/sitemaps/prices-index.xml',
    '/sitemaps/prices-service-hubs.xml',
    '/sitemaps/prices-market-hubs.xml',
  ]) {
    assert.ok(!(await get(child)).body.includes('crunchyroll'), child);
  }
});

test('each hub kind has its own child sitemap, every entry dated from the newest verification it shows', async () => {
  const entries = async (path) => {
    const sitemap = await get(path);
    assert.equal(sitemap.status, 200, path);
    return [
      ...sitemap.body.matchAll(
        /<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/gu,
      ),
    ].map(([, loc, lastmod]) => [loc, lastmod]);
  };
  assert.deepEqual(await entries('/sitemaps/prices-index.xml'), [
    ['https://valstara.com/prices', '2026-11-28'],
  ]);
  assert.deepEqual(await entries('/sitemaps/prices-service-hubs.xml'), [
    ['https://valstara.com/prices/apple-music', '2026-11-21'],
    ['https://valstara.com/prices/duolingo', '2026-11-26'],
    ['https://valstara.com/prices/netflix', '2026-11-27'],
    ['https://valstara.com/prices/spotify', '2026-11-28'],
  ]);
  assert.deepEqual(await entries('/sitemaps/prices-market-hubs.xml'), [
    ['https://valstara.com/prices/countries/france', '2026-11-26'],
    ['https://valstara.com/prices/countries/sweden', '2026-11-28'],
    ['https://valstara.com/prices/countries/united-kingdom', '2026-11-28'],
    ['https://valstara.com/prices/countries/united-states', '2026-11-27'],
  ]);
  // Each lastmod is a date the hub itself shows, never the build date.
  for (const hub of site.hubs) {
    const { body } = await get(hub.path);
    assert.match(body, new RegExp(`<time datetime="${hub.lastmod}"`, 'u'));
    assert.doesNotMatch(body, /datetime="2026-12-01"/u);
  }
});

test('each hub has a unique title and description, a self-canonical, breadcrumbs and BreadcrumbList data', async () => {
  const seen = { titles: new Set(), descriptions: new Set() };
  for (const path of hubPaths) {
    const { body } = await get(path);
    checkRenderedHead(body, path, seen);
    const view = path === '/prices' ? site.index : site.hub(path);
    const data = [
      ...body.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu,
      ),
    ]
      .map((match) => JSON.parse(match[1]))
      .find((item) => item['@type'] === 'BreadcrumbList');
    assert.deepEqual(
      data.itemListElement.map((item) => [item.name, item.item]),
      view.breadcrumbs.map((crumb) => [crumb.name, crumb.url]),
      path,
    );
    assert.equal(data.itemListElement.at(-1).item, canonicalUrl(path));
    // The visible trail mirrors it, the current page unlinked.
    const trail = body.slice(
      body.indexOf('<nav class="price-breadcrumbs'),
      body.indexOf('</nav>', body.indexOf('<nav class="price-breadcrumbs')),
    );
    assert.match(trail, /<a href="\/"[^>]*>Valstara<\/a>/u);
    assert.match(trail, /aria-current="page"/u);
    // A hub loads no script beyond the theme toggle, the page-view emitter
    // and its structured data.
    const sources = [...body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(sources, ['/page-view.js'], path);
    assert.doesNotMatch(body, /challenges\.cloudflare\.com|SignupForm/u, path);
  }
});

test('the footer links the price index on every price route and on the landing page', async () => {
  const link = layoutCopy.footerLinks.find((item) => item.href === '/prices');
  assert.equal(link?.label, 'Price index');
  for (const path of [
    '/',
    ...hubPaths,
    ...site.routes.map((route) => route.path),
  ]) {
    const { body } = await get(path);
    const footer = body.slice(body.indexOf('<footer'));
    assert.match(
      footer,
      /<a href="\/prices"[^>]*>\s*Price index\s*<\/a>/u,
      `${path} footer`,
    );
  }
  assert.equal((await get('/prices')).status, 200);
});

test('prices.pages off answers 503 with Retry-After and noindex on /prices and every hub', async () => {
  await server.stop();
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('prices.pages', false, 'price-hubs-rendered-test')`,
  );
  server = await startServer();
  for (const path of [...hubPaths, ...noHubPaths, retiredPath]) {
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
    assert.doesNotMatch(page.body, /data-price-amount/u, path);
  }
});
