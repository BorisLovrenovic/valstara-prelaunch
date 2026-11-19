import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';

import {
  generatedPages,
  publishedView,
} from '../packages/price-index/src/publish/index.ts';
import { checkRenderedHead } from '../scripts/ci/seo-build-check.ts';
import { createPriceSite } from '../src/server/prices/site.ts';
import { pricesPausedRetryAfterSeconds } from '../src/server/prices/route.ts';
import { createReferralCaptureService } from '../src/server/referral/capture.ts';
import {
  canonicalUrl,
  socialFallbackImageUrl,
  socialImageUrl,
} from '../src/server/seo.ts';
import { startAppServer } from './helpers/listen-port.mjs';
import {
  priceFixtureInputs,
  priceFixtureSite,
} from './helpers/price-fixture-site.mjs';

// E11.6-10: the service × market page, built and served over the fixture
// dataset in test/fixtures/price-index/pages/ (four generated pages, three
// ledger URLs without publishable data, and pairs that generate nothing).
// Every assertion reads the served HTTP response of the real built app.

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
// a conflict, a missing record, a market with no record, an unknown service,
// and a slug in the wrong case.
const unknownPaths = [
  '/prices/spotify/norway',
  '/prices/spotify/germany',
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

test('the fixture dataset generates four pages and leaves three ledger URLs unavailable', () => {
  assert.deepEqual(
    generated.map((route) => route.path),
    [
      '/prices/duolingo/france',
      '/prices/netflix/sweden',
      '/prices/netflix/united-states',
      '/prices/spotify/sweden',
    ],
  );
  assert.deepEqual(
    unavailable.map((route) => route.path),
    [
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

test('every number on a page equals the published record it came from, and no USD figure appears', async () => {
  const latest = inputs.latest;
  const published = generatedPages(latest, inputs.catalogue, inputs.markets);
  // Every USD figure in the dataset, of records in another currency.
  const usdFigures = latest.records
    .filter((record) => record.currency !== 'USD')
    .map((record) => record.price_usd_source)
    .filter((figure) => figure !== null);
  assert.ok(usdFigures.length >= 6);
  // Values the gate keeps off the pages: a needs_review and a stale price.
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
  assert.ok(refused.length >= 4);

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

    // Every number in the page's own content traces to a record: a price,
    // or a day or year of a verification date.
    const allowed = new Set();
    for (const record of expected.records) {
      allowed.add(record.price_local);
      const [year, month, day] = record.source_verified_at.split('-');
      allowed.add(year);
      allowed.add(String(Number(day)));
      void month;
    }
    // Configured names are not figures ("Premium (4K)"): they are removed
    // before the scan, so only figures are left to trace.
    const service = inputs.catalogue.services.find(
      (item) => item.service_id === expected.service_id,
    );
    let body = visibleText(priceBody(page.body));
    for (const name of [
      service.name,
      ...service.plans.map((plan) => plan.name),
    ]) {
      body = body.replaceAll(name, ' ');
    }
    for (const [number] of body.matchAll(/\d+(?:[.,]\d+)*/gu)) {
      assert.ok(
        allowed.has(number),
        `${route.path} shows ${number}, which no published record holds`,
      );
    }

    const market = inputs.markets.markets.find(
      (item) => item.code === expected.market,
    );
    if (market.currency !== 'USD') {
      assert.doesNotMatch(visibleText(page.body), /USD|US\$|\$/u, route.path);
    }
    for (const figure of usdFigures) {
      assert.ok(
        !page.body.includes(figure),
        `${route.path} carries the USD figure ${figure}`,
      );
    }
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
  }
});

test('each price page has a unique title and description, a self-canonical, the prices card fallback and BreadcrumbList data', async () => {
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
    // The page's card URL serves the typed prices fallback until E11.6-14.
    const card = await globalThis.fetch(
      `http://127.0.0.1:${server.port}${new URL(socialImageUrl(route.path)).pathname}`,
    );
    assert.equal(card.status, 200, route.path);
    assert.equal(card.headers.get('content-type'), 'image/png');
    const fallback = await globalThis.fetch(
      `http://127.0.0.1:${server.port}${new URL(socialFallbackImageUrl('prices')).pathname}`,
    );
    assert.deepEqual(
      globalThis.Buffer.from(await card.arrayBuffer()),
      globalThis.Buffer.from(await fallback.arrayBuffer()),
    );
  }
  assert.equal(seen.titles.size, site.routes.length);
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
    assert.deepEqual(
      structured.map((script) => JSON.parse(script.content)['@type']).sort(),
      ['BreadcrumbList', 'Organization'],
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

test('the sitemap index lists both child sitemaps, pages.xml keeps the previous entries, and the price sitemap lists generated pages with their verification dates', async () => {
  const index = await get('/sitemap.xml');
  assert.equal(index.status, 200);
  assert.deepEqual(
    [...index.body.matchAll(/<sitemap><loc>([^<]+)<\/loc><\/sitemap>/gu)].map(
      (match) => match[1],
    ),
    [
      'https://valstara.com/sitemaps/pages.xml',
      'https://valstara.com/sitemaps/prices-service-market.xml',
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
      {
        loc: 'https://valstara.com/prices/duolingo/france',
        lastmod: '2026-11-26',
      },
      {
        loc: 'https://valstara.com/prices/netflix/sweden',
        lastmod: '2026-11-25',
      },
      {
        loc: 'https://valstara.com/prices/netflix/united-states',
        lastmod: '2026-11-27',
      },
      {
        loc: 'https://valstara.com/prices/spotify/sweden',
        lastmod: '2026-11-28',
      },
    ],
  );
  // Not the build date: no lastmod is the fixture's built_at day.
  assert.doesNotMatch(prices.body, /2026-12-01/u);
  for (const route of unavailable) {
    assert.ok(!prices.body.includes(route.path), `${route.path} is noindex`);
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
