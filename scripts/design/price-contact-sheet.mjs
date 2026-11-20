// E11.6-16: the price pages' contact sheet, for the founder's sign-off. Each
// price page kind the committed data makes (the founder's first monthly run,
// E11.6-15), at every design width in both themes, at rest, captured through
// E11.5-01's `captureContactSheet`, which also runs the layout checks on
// every capture:
//
//   node --import tsx scripts/design/price-contact-sheet.mjs
//
// From the committed data: the largest and the smallest service × market
// page, the largest service hub and market hub, `/prices`, `/price-index`
// and every monthly report, and the `prices.pages` paused state on a page
// and on `/prices`. The states the committed data does not have yet are
// captured from the price fixture site (test/helpers/price-fixture-site.mjs),
// labelled as fixtures: a ledger URL whose data is lost, a page with price
// history, and a page with the Valstara comparison (`prices.valstara_comparison`
// on). The script refuses to run if a route kind of the committed data has no
// entry. Self-contained: it builds what it serves, migrates its own
// databases, starts the pinned Playwright container, and removes all of
// them again. The output is git-ignored and is never committed.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { flagCacheTtlMilliseconds } from '../../src/server/flags/service.ts';
import { createPriceSite } from '../../src/server/prices/site.ts';
import {
  committedPriceData,
  fetchRoutes,
  priceRouteKinds,
  startPriceAuditServer,
} from '../../test/helpers/price-audit.mjs';
import {
  priceFixtureInputs,
  priceFixtureSite,
} from '../../test/helpers/price-fixture-site.mjs';
import { captureContactSheet } from './contact-sheet.mjs';
import {
  startBrowserServer,
  waitForBrowserReach,
} from './full-contact-sheet.mjs';
import { designThemes, designWidths } from './layout-checks.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const outputDirectory = '.design-contact-sheets/e11-6-16';

// The local-only values `npm test` gives every suite (package.json).
const localEnvironment = Object.freeze({
  RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
  BREVO_WEBHOOK_TOKEN: 'local-only-brevo-webhook-token-32-chars',
  EMAIL_TOKEN_SECRET: 'local-only-email-token-secret-32-chars',
  EMAIL_BASE_URL: 'http://localhost:4321',
});

const clockStart = () => process.hrtime.bigint();
const secondsSince = (start) =>
  Number(process.hrtime.bigint() - start) / 1_000_000_000;

// Turnstile's loader is answered with an empty script: at rest the signup
// form has not asked for a check, and the widget is Cloudflare's to draw.
const quietTurnstile = (context) =>
  context.route('https://challenges.cloudflare.com/**', (route) =>
    route
      .fulfill({ contentType: 'text/javascript', body: '' })
      .catch(() => undefined),
  );

/** Sets campaign flags in a server's database and lets its flag cache expire. */
function flagSetter(ownerDatabaseUrl) {
  const database = new Pool({ connectionString: ownerDatabaseUrl });
  const set = async (flags) => {
    for (const [key, enabled] of Object.entries(flags))
      await database.query(
        "INSERT INTO campaign_flag (key,enabled,updated_by) VALUES ($1,$2,'e11-6-16-contact-sheet') ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled",
        [key, enabled],
      );
    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, flagCacheTtlMilliseconds + 250),
    );
  };
  return { set, end: () => database.end() };
}

/**
 * The committed data's entries: the largest and smallest service × market
 * page, the largest of each other kind, and every monthly report.
 */
export async function committedEntries(port) {
  const data = await committedPriceData();
  const served = await fetchRoutes(
    port,
    data.routes.map((route) => route.path),
  );
  const byKind = new Map();
  for (const route of data.routes) {
    const list = byKind.get(route.kind) ?? [];
    list.push({ ...route, bytes: served.get(route.path).body.length });
    byKind.set(route.kind, list);
  }
  const entries = [];
  for (const kind of priceRouteKinds) {
    const routes = (byKind.get(kind) ?? []).sort((a, b) => b.bytes - a.bytes);
    if (routes.length === 0) continue;
    const chosen =
      kind === 'monthly'
        ? routes
        : kind === 'service-market' && routes.length > 1
          ? [routes[0], routes.at(-1)]
          : [routes[0]];
    for (const [index, route] of chosen.entries())
      entries.push({
        kind,
        route: route.path,
        state: `${kind}${chosen.length > 1 ? `-${kind === 'monthly' ? route.path.slice(-7) : index === 0 ? 'largest' : 'smallest'}` : ''}${route.path.replaceAll('/', '-')}`,
      });
  }
  const missing = [...byKind.keys()].filter(
    (kind) => !entries.some((entry) => entry.kind === kind),
  );
  if (missing.length > 0)
    throw new Error(`The sheet has no entry for: ${missing.join(', ')}`);
  return { entries, kinds: [...byKind.keys()] };
}

/** The fixture site's states the committed data does not have yet. */
async function fixtureEntries() {
  const site = createPriceSite(await priceFixtureInputs());
  const unavailable = site.routes.find((route) => route.kind === 'unavailable');
  const history = site.routes.find(
    (route) => route.kind === 'generated' && route.history.length > 0,
  );
  const valstara = site.routes.find(
    (route) => route.kind === 'generated' && route.valstara !== null,
  );
  if (!unavailable || !history || !valstara)
    throw new Error('The price fixture site lacks a state the sheet captures.');
  return [
    {
      kind: 'unavailable',
      route: unavailable.path,
      state: `fixture-unavailable${unavailable.path.replaceAll('/', '-')}`,
    },
    {
      kind: 'service-market',
      route: history.path,
      state: `fixture-history${history.path.replaceAll('/', '-')}`,
    },
    {
      kind: 'service-market',
      route: valstara.path,
      state: `fixture-valstara-comparison-on${valstara.path.replaceAll('/', '-')}`,
      flags: { 'prices.valstara_comparison': true },
    },
  ];
}

async function main() {
  for (const [key, value] of Object.entries(localEnvironment))
    process.env[key] ??= value;
  const started = clockStart();
  const cleanups = [];
  const cleanUp = async () => {
    while (cleanups.length > 0) {
      try {
        await cleanups.pop()();
      } catch (error) {
        process.stderr.write(`cleanup: ${error?.message ?? error}\n`);
      }
    }
  };
  process.once('SIGINT', () => void cleanUp().finally(() => process.exit(130)));
  process.once(
    'SIGTERM',
    () => void cleanUp().finally(() => process.exit(143)),
  );
  let failed = true;
  try {
    process.stdout.write('Building the app and the price fixture site…\n');
    const { root: fixtureRoot } = await priceFixtureSite();
    const committed = await startPriceAuditServer({
      label: 'Price contact sheet (committed data)',
      host: '0.0.0.0',
    });
    cleanups.push(() => committed.dispose());
    const fixture = await startPriceAuditServer({
      label: 'Price contact sheet (fixture data)',
      host: '0.0.0.0',
      root: fixtureRoot,
    });
    cleanups.push(() => fixture.dispose());
    const committedFlags = flagSetter(committed.ownerDatabaseUrl);
    cleanups.push(() => committedFlags.end());
    const fixtureFlags = flagSetter(fixture.ownerDatabaseUrl);
    cleanups.push(() => fixtureFlags.end());

    const { entries, kinds } = await committedEntries(committed.port);
    const pausedPage = entries.find((entry) => entry.kind === 'service-market');
    const browserServer = await startBrowserServer(
      `valstara-e11-6-16-contact-sheet-${process.pid}`,
    );
    cleanups.push(() => browserServer.stop());
    const committedOrigin = `http://host.docker.internal:${committed.port}`;
    const fixtureOrigin = `http://host.docker.internal:${fixture.port}`;
    await waitForBrowserReach(
      browserServer.endpoint,
      `${committedOrigin}/prices`,
    );
    await waitForBrowserReach(
      browserServer.endpoint,
      `${fixtureOrigin}/prices`,
    );

    const directory = resolve(root, outputDirectory);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const capture = (origin, list, output) =>
      captureContactSheet({
        origin,
        browserEndpoint: browserServer.endpoint,
        output: join(directory, output),
        entries: list.map((entry) => ({ ...entry, setup: quietTurnstile })),
      });

    const committedCaptures = await capture(
      committedOrigin,
      entries,
      'committed',
    );
    await committedFlags.set({ 'prices.pages': false });
    const pausedCaptures = await capture(
      committedOrigin,
      [
        {
          kind: 'paused',
          route: pausedPage.route,
          state: `prices-pages-off${pausedPage.route.replaceAll('/', '-')}`,
          status: 503,
        },
        {
          kind: 'paused',
          route: '/prices',
          state: 'prices-pages-off-prices',
          status: 503,
        },
      ],
      'paused',
    );
    await committedFlags.set({ 'prices.pages': true });
    const fixtures = await fixtureEntries();
    const fixtureCaptures = [];
    for (const entry of fixtures) {
      await fixtureFlags.set({
        'prices.valstara_comparison':
          entry.flags?.['prices.valstara_comparison'] ?? false,
      });
      fixtureCaptures.push(
        ...(await capture(fixtureOrigin, [entry], `fixture/${entry.state}`)),
      );
    }

    const all = [
      ...committedCaptures.map((item) => ({ ...item, source: 'committed' })),
      ...pausedCaptures.map((item) => ({ ...item, source: 'committed' })),
      ...fixtureCaptures.map((item) => ({ ...item, source: 'fixture' })),
    ];
    const layoutIssues = all.filter((item) => item.layoutIssues.length > 0);
    const summary = {
      ticket: 'E11.6-16',
      wallTimeSeconds: Math.round(secondsSince(started)),
      widths: designWidths,
      themes: designThemes,
      committedKinds: kinds,
      states: [
        ...entries.map((entry) => ({ ...entry, source: 'committed' })),
        { kind: 'paused', route: pausedPage.route, source: 'committed' },
        { kind: 'paused', route: '/prices', source: 'committed' },
        ...fixtures.map((entry) => ({ ...entry, source: 'fixture' })),
      ],
      totalCaptures: all.length,
      layoutIssues: layoutIssues.map(
        ({ state, width, theme, layoutIssues: found }) => ({
          state,
          width,
          theme,
          issues: found,
        }),
      ),
    };
    await writeFile(
      join(directory, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    process.stdout.write(
      `${summary.totalCaptures} captures, ${summary.layoutIssues.length} with layout issues: ${outputDirectory}/summary.json\n`,
    );
    failed = layoutIssues.length > 0;
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
  } finally {
    await cleanUp();
  }
  process.exitCode = failed ? 1 : 0;
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  import.meta.url === pathToFileURL(resolve(invoked)).href
)
  await main();
