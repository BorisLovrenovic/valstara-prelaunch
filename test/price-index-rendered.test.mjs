import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';

import { checkRenderedHead } from '../scripts/ci/seo-build-check.ts';
import { pricesCopy } from '../src/copy/prices.ts';
import { pricesPausedRetryAfterSeconds } from '../src/server/prices/route.ts';
import { createPriceSite } from '../src/server/prices/site.ts';
import { canonicalUrl } from '../src/server/seo.ts';
import { startAppServer } from './helpers/listen-port.mjs';
import {
  priceFixtureInputs,
  priceFixtureSite,
} from './helpers/price-fixture-site.mjs';

// E11.6-13: `/price-index` (the methodology, its monthly reports and its
// Dataset JSON-LD), each monthly report at `/price-index/{yyyy-mm}`, and the
// service × market page's methodology link, built and served over the
// price-page fixture dataset (test/fixtures/price-index/pages/, with its
// two monthly reports). Every assertion reads the served HTTP response of
// the real built app. The view model's cases are in
// test/price-index/price-index-pages.test.ts.

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

const inputs = await priceFixtureInputs();
const site = createPriceSite(inputs);
const reportPaths = site.monthlyReports.map((report) => report.path);
const pagePaths = ['/price-index', ...reportPaths];
// Months with no report file, an impossible month, and other shapes.
const absentPaths = [
  '/price-index/2026-11',
  '/price-index/2026-08',
  '/price-index/2026-13',
  '/price-index/october',
];

let fixtureRoot;
let database;
let databaseUrl;
let databaseName;
let admin;
let server;

async function startServer() {
  return startAppServer({
    label: 'Price-index rendered test',
    cwd: fixtureRoot,
    env: () => ({
      ADMIN_CREDENTIAL: 'price-index-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'price-index-rendered-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'price-index-rendered-referral-secret',
      RESEND_API_KEY: 'price-index-rendered-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'price-index-rendered-turnstile-secret',
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
  databaseName = `valstara_index_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await executeFile(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'price-index-rendered-test'],
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

/** The page's own content, from its article to its end. */
function reportBody(html) {
  const start = html.indexOf('<article class="price-report');
  const end = html.indexOf('</article>', start);
  assert.ok(start > 0 && end > start, 'the page body is present');
  return html.slice(start, end);
}

// The Markdown pipeline sets apostrophes typographically, as on every
// content page; the wording is compared with plain ones.
function decode(text) {
  return text
    .replace(/&#39;|’/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"');
}

function links(html) {
  return [
    ...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu),
  ].map(([, href, text]) => [
    href,
    decode(text.replace(/<[^>]+>/gu, '').trim()),
  ]);
}

function jsonLd(html) {
  return [
    ...html.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu,
    ),
  ].map((match) => JSON.parse(match[1]));
}

test('/price-index renders the methodology, its monthly reports and its Dataset data', async () => {
  const page = await get('/price-index');
  assert.equal(page.status, 200);
  assert.equal(
    page.headers.get('cache-control'),
    'public, max-age=0, s-maxage=300',
  );
  assert.equal(page.headers.get('x-robots-tag'), null);
  assert.doesNotMatch(page.body, /name="robots"/u);
  const body = reportBody(page.body);
  // The content file's own H1 is the page's only H1, and its D4 wording is
  // there verbatim.
  assert.equal([...page.body.matchAll(/<h1\b/gu)].length, 1);
  assert.match(body, /<h1[^>]*>How the price index works<\/h1>/u);
  assert.ok(
    decode(body).includes(
      "We collect official list prices once a month from public price listings, and check them by hand against providers' own pricing pages where needed.",
    ),
  );
  // The monthly reports, newest first, and the prices.
  assert.deepEqual(
    links(body).filter(([href]) => href.startsWith('/price-index/')),
    [
      ['/price-index/2026-10', 'October 2026'],
      ['/price-index/2026-09', 'September 2026'],
    ],
  );
  assert.ok(links(body).some(([href]) => href === '/prices'));
  // The Dataset JSON-LD is exactly the view model's.
  const dataset = jsonLd(page.body).find((item) => item['@type'] === 'Dataset');
  assert.deepEqual(dataset, site.priceIndex.dataset);
  assert.equal(dataset.dateModified, '2026-11-28');
  assert.equal(dataset.temporalCoverage, '2026-11-20/2026-11-28');
});

test('each monthly report renders its file and links every page it mentions while that page exists', async () => {
  for (const report of site.monthlyReports) {
    const page = await get(report.path);
    assert.equal(page.status, 200, report.path);
    const body = reportBody(page.body);
    assert.match(body, new RegExp(`<h1[^>]*>${report.heading}</h1>`, 'u'));
    // Every link resolves: a generated page or a hub answers 200, never a
    // 404 or a redirect.
    for (const [href] of links(body)) {
      const target = await get(href);
      assert.equal(target.status, 200, `${report.path} links ${href}`);
    }
    // The mentions exactly as the view model has them: linked, or named.
    const mentions = [
      ...report.changes.map((row) => row.marketPart),
      ...[...report.direction, ...report.extremes]
        .flat()
        .filter((part) => part.href !== null),
    ];
    for (const part of mentions) {
      if (part.href === null) {
        assert.match(
          body,
          new RegExp(
            `<span data-mention-unlinked[^>]*>${part.text}</span>`,
            'u',
          ),
        );
      } else {
        assert.ok(
          links(body).some(
            ([href, text]) => href === part.href && text === part.text,
          ),
          `${report.path}: ${part.text} links ${part.href}`,
        );
      }
    }
    // Every figure is the file's.
    assert.deepEqual(
      [
        ...body.matchAll(
          /data-price-amount="([^"]+)" data-price-currency="([^"]+)"/gu,
        ),
      ].map(([, amount, currency]) => `${amount} ${currency}`),
      report.changes.flatMap((row) => [
        `${row.oldAmount} ${row.currency}`,
        `${row.newAmount} ${row.currency}`,
      ]),
    );
  }
  const october = reportBody((await get('/price-index/2026-10')).body);
  // Linked while generated; named without a link otherwise.
  assert.ok(
    links(october).some(
      ([href, text]) => href === '/prices/spotify/sweden' && text === 'Sweden',
    ),
  );
  assert.match(october, /<span data-mention-unlinked[^>]*>Finland<\/span>/u);
  assert.match(october, /<span data-mention-unlinked[^>]*>Norway<\/span>/u);
  assert.ok(
    !links(october).some(([href]) =>
      /chatgpt|crunchyroll|finland|norway/u.test(href),
    ),
  );
  const september = reportBody((await get('/price-index/2026-09')).body);
  assert.match(
    september,
    /No list price we track changed in September 2026\./u,
  );
});

test('a month with no report file answers the branded 404', async () => {
  for (const path of absentPaths) {
    const page = await get(path);
    assert.equal(page.status, 404, path);
    assert.match(page.body, /data-task-state="not-found"/u, path);
    assert.doesNotMatch(page.body, /data-price-report/u, path);
  }
});

test('the pages carry unique metadata, breadcrumbs, and no script beyond the shell', async () => {
  const seen = { titles: new Set(), descriptions: new Set() };
  for (const path of pagePaths) {
    const { body } = await get(path);
    checkRenderedHead(body, path, seen);
    const view =
      path === '/price-index' ? site.priceIndex : site.monthlyReport(path);
    const breadcrumbs = jsonLd(body).find(
      (item) => item['@type'] === 'BreadcrumbList',
    );
    assert.deepEqual(
      breadcrumbs.itemListElement.map((item) => [item.name, item.item]),
      view.breadcrumbs.map((crumb) => [crumb.name, crumb.url]),
      path,
    );
    assert.equal(breadcrumbs.itemListElement.at(-1).item, canonicalUrl(path));
    // Zero client JavaScript beyond the shell: the page-view emitter, the
    // theme toggle's inline script and the structured data. No form, no
    // signed field, no Turnstile.
    const sources = [...body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(sources, ['/page-view.js'], path);
    assert.doesNotMatch(
      body,
      /challenges\.cloudflare\.com|SignupForm|name="email"|referral_capture|astro-island/u,
      path,
    );
    // No USD figure stands for another market's price.
    assert.doesNotMatch(body, /≈|price_usd_source/u, path);
  }
  const ref = await get('/price-index/2026-10?ref=ABCDEFGHJKMN');
  assert.equal(ref.status, 200);
  assert.equal(ref.headers.get('cache-control'), 'private, no-store');
});

test('every service × market page links the methodology', async () => {
  for (const route of site.routes) {
    const { status, body } = await get(route.path);
    assert.equal(status, 200, route.path);
    assert.match(
      body,
      new RegExp(
        `<a href="/price-index"[^>]*data-methodology-link[^>]*>\\s*${pricesCopy.page.methodologyLink}\\s*</a>`,
        'u',
      ),
      route.path,
    );
  }
});

test('prices.pages off answers 503 with Retry-After and noindex on /price-index and every month', async () => {
  await server.stop();
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('prices.pages', false, 'price-index-rendered-test')`,
  );
  server = await startServer();
  for (const path of [...pagePaths, ...absentPaths]) {
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
    assert.doesNotMatch(
      page.body,
      /data-price-report|application\/ld\+json[^<]*Dataset/u,
      path,
    );
  }
});
