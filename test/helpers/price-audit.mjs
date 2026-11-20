import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DomUtils, parseDocument } from 'htmlparser2';
import { Pool } from 'pg';

import {
  generatedPages,
  hubPaths,
} from '../../packages/price-index/src/publish/index.ts';
import { readPriceSiteInputs } from '../../src/server/prices/files.ts';
import { createPriceSite } from '../../src/server/prices/site.ts';
import { ensureAppBuild } from '../../scripts/ci/app-build.mjs';
import { startAppServer } from './listen-port.mjs';

// E11.6-16: the price-page audit runs over the committed price data, not a
// fixture. The repository's own build bundles data/price-index/ and the
// configuration (E11.6-10, D1), so the audit serves that build and reads the
// same files from the checkout to know what it must find. Every route kind
// the data makes is listed once here, for the HTTP audit
// (test/e11-6-16-price-routes.test.mjs), the browser audit
// (test/e11-6-16-price-browser.test.mjs), the privacy crawl
// (test/e11-05-page-inventory.test.mjs) and the contact sheet
// (scripts/design/price-contact-sheet.mjs).
// Exports only: node --test runs every file under test/, helpers included.

const executeFile = promisify(execFile);
export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

/** The route kinds of the price pages, in the order the audit reports them. */
export const priceRouteKinds = Object.freeze([
  'service-market',
  'unavailable',
  'service-hub',
  'market-hub',
  'prices',
  'price-index',
  'monthly',
]);

/**
 * The committed price data and everything the build makes of it: the raw
 * inputs, the site model, the generation rule's own pages (read without the
 * site model, so the audit can compare the two) and every price route with
 * its kind, in path order within each kind.
 */
export async function committedPriceData(root = projectRoot) {
  const inputs = await readPriceSiteInputs(root);
  const site = createPriceSite(inputs);
  const pages = generatedPages(inputs.latest, inputs.catalogue, inputs.markets);
  const routes = [
    ...site.routes.map((route) => ({
      path: route.path,
      kind: route.kind === 'generated' ? 'service-market' : 'unavailable',
    })),
    ...site.hubs.map((hub) => ({ path: hub.path, kind: hub.kind })),
    { path: '/prices', kind: 'prices' },
    { path: '/price-index', kind: 'price-index' },
    ...site.monthlyReports.map((report) => ({
      path: report.path,
      kind: 'monthly',
    })),
  ];
  return { inputs, site, pages, hubs: hubPaths(pages), routes };
}

/**
 * A migrated, disposable database and the repository's build served over it.
 * The price routes read the campaign flags, so the server needs a database;
 * nothing is seeded. `host` is `0.0.0.0` when a browser container must
 * reach the server; `root` serves another built copy of the site.
 */
export async function startPriceAuditServer({
  label = 'Price audit',
  host = '127.0.0.1',
  root = projectRoot,
} = {}) {
  // Another root is a built copy of the site (the price fixture site).
  if (root === projectRoot) await ensureAppBuild();
  const name = `valstara_price_audit_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const appUrl = new URL(url);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  let server;
  const dispose = async () => {
    await server?.stop();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  };
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'price-audit'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: url.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    server = await startAppServer({
      label,
      readyPath: '/robots.txt',
      cwd: root,
      // The server stops on SIGTERM, which by default ends Node without
      // writing its V8 coverage, so the price pages it rendered would count
      // as unrun. Exiting cleanly writes it, as the unsubscribe page's
      // server does (scripts/fixtures/run-unsubscribe-server.mjs). Preloaded
      // rather than wrapped, so it serves any `root`'s own build.
      nodeArguments: [
        '--import',
        'data:text/javascript,process.once("SIGTERM",()=>process.exit(0))',
      ],
      env: () => ({
        ADMIN_CREDENTIAL: 'price-audit-admin-credential-32-chars',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL: appUrl.toString(),
        IP_PREFIX_PEPPER: 'price-audit-prefix-pepper',
        REFERRAL_SIGNING_SECRET: 'price-audit-referral-secret',
        RESEND_API_KEY: 'price-audit-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        // Cloudflare's always-pass test secret, as the browser suites use.
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        HOST: host,
      }),
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    port: server.port,
    databaseUrl: appUrl.toString(),
    // The owner's URL, for a script that sets campaign flags.
    ownerDatabaseUrl: url.toString(),
    dispose,
  };
}

/** Runs `work` over `items`, at most `limit` at a time, in input order. */
export async function inPool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Every path served, as `{ status, headers, body }`, fetched without following redirects. */
export async function fetchRoutes(port, paths, limit = 8) {
  const responses = await inPool(paths, limit, async (path) => {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(20_000),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  });
  return new Map(paths.map((path, index) => [path, responses[index]]));
}

/** The parsed document of a served page. */
export function documentOf(html) {
  return parseDocument(html);
}

/** Every element of `root` (a document or element) that `test` accepts. */
export function elements(root, test) {
  return DomUtils.findAll(test, root.children ?? [root]);
}

/** The first element named `name` with the attribute `attribute`, if any. */
export function elementWith(root, name, attribute) {
  return (
    elements(
      root,
      (element) =>
        element.name === name &&
        (attribute === undefined || Object.hasOwn(element.attribs, attribute)),
    )[0] ?? null
  );
}

const hiddenText = new Set(['script', 'style', 'template']);

/**
 * The text a reader can meet in `node`: everything but scripts, styles and
 * templates, `excluded` elements left out, whitespace collapsed. `<noscript>`
 * stays in, because a visitor without JavaScript reads it.
 */
export function readableText(node, excluded = () => false) {
  const parts = [];
  const walk = (current) => {
    if (current.type === 'text') {
      parts.push(current.data);
      return;
    }
    if (DomUtils.isTag(current)) {
      if (hiddenText.has(current.name) || excluded(current)) return;
      // Block boundaries separate words that markup alone would run together.
      parts.push(' ');
    }
    for (const child of current.children ?? []) walk(child);
    if (DomUtils.isTag(current)) parts.push(' ');
  };
  walk(node);
  return parts.join('').replace(/\s+/gu, ' ').trim();
}

/** The page's own content: `<main>` without the signup island. */
export function mainText(document) {
  const main = elementWith(document, 'main');
  if (main === null) throw new Error('The page has no <main>.');
  return readableText(
    main,
    (element) => element.name === 'valstara-signup-form',
  );
}

/** Every `href` on the page that names a path on this site. */
export function siteLinks(root) {
  return elements(root, (element) => element.name === 'a')
    .map((element) => element.attribs.href)
    .filter(
      (href) =>
        typeof href === 'string' &&
        href.startsWith('/') &&
        !href.startsWith('//'),
    );
}

/** Every JSON-LD block on the page, parsed. */
export function structuredData(document) {
  return elements(
    document,
    (element) =>
      element.name === 'script' &&
      element.attribs.type === 'application/ld+json',
  ).map((element) => JSON.parse(DomUtils.textContent(element)));
}
