import type { PublishedRecord } from '../../../packages/price-index/src/publish/gate.ts';
import {
  generatedPages,
  type GeneratedPage,
} from '../../../packages/price-index/src/publish/pages.ts';
// Only the schema modules the pages read, so no other part of the tool's
// schemas (its run files, reports and settings) is bundled into the site.
import {
  catalogueFileSchema,
  type CatalogueFile,
} from '../../../packages/price-index/src/schema/catalogue.ts';
import {
  marketsFileSchema,
  type MarketsFile,
} from '../../../packages/price-index/src/schema/markets.ts';
import {
  latestFileSchema,
  type LatestFile,
} from '../../../packages/price-index/src/schema/price-index-files.ts';
import {
  publishedUrlsFileSchema,
  type PublishedUrlsFile,
} from '../../../packages/price-index/src/schema/published-urls.ts';
import type { z } from 'zod';

import { pricesCopy } from '../../copy/prices.ts';
import { canonicalUrl } from '../seo.ts';

// The price pages' view model (E11.6-10). One pure function of the four
// files the site bundles at build — latest.json, the catalogue, the markets
// and the published-URL ledger — gives every price route, its metadata and
// the price sitemap, so the page, the sitemap, the SEO build check and the
// tests all read the same model. Pages only render it.
//
// What is shown comes only through the publish gate (`generatedPages` reads
// `publishedView`), which leaves out every USD figure and every unpublished
// value, so the view cannot display one.

/** A data file the site reads is invalid, so no price page is built. */
export class PriceDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceDataError';
  }
}

export interface PriceSiteInputs {
  /** latest.json, or null before the first build of data. */
  readonly latest: unknown;
  readonly catalogue: unknown;
  readonly markets: unknown;
  readonly ledger: unknown;
}

export interface PriceBreadcrumb {
  readonly name: string;
  readonly url: string;
}

export interface PriceMeta {
  readonly title: string;
  readonly description: string;
}

export interface PlanRow {
  readonly planId: string;
  readonly planName: string;
  readonly billingPeriod: PublishedRecord['billing_period'];
  /** The published `price_local`, exactly. */
  readonly amount: string;
  /** The published currency, which is the market's own. */
  readonly currency: string;
  readonly priceText: string;
  readonly periodText: string;
  /** `YYYY-MM-DD`. */
  readonly verifiedOn: string;
  readonly verifiedText: string;
}

interface RouteBase {
  readonly path: string;
  readonly serviceId: string;
  readonly market: string;
  readonly serviceName: string;
  /** The market's name as it reads in a sentence ("the United States"). */
  readonly marketName: string;
  readonly meta: PriceMeta;
  readonly heading: string;
  readonly notAffiliated: string;
  readonly breadcrumbs: readonly PriceBreadcrumb[];
  /** BreadcrumbList JSON-LD (schema.org). */
  readonly structuredData: Readonly<Record<string, unknown>>;
}

/** A page that passes the generation rule. */
export interface GeneratedPriceRoute extends RouteBase {
  readonly kind: 'generated';
  readonly tableCaption: string;
  readonly rows: readonly PlanRow[];
  readonly verifiedLine: string;
  /** The newest verification date of its records: the sitemap `lastmod`. */
  readonly lastmod: string;
}

/** A ledger URL with no publishable data: no price, `noindex`. */
export interface UnavailablePriceRoute extends RouteBase {
  readonly kind: 'unavailable';
  readonly note: string;
}

export type PriceRoute = GeneratedPriceRoute | UnavailablePriceRoute;

export interface PriceSitemapEntry {
  readonly path: string;
  /** `YYYY-MM-DD`: the page's verification date, not the build date. */
  readonly lastmod: string;
}

export interface PriceSite {
  /** Every price route, generated and unavailable, in path order. */
  readonly routes: readonly PriceRoute[];
  /** The generated pages only: unavailable ledger URLs are `noindex`. */
  readonly sitemap: readonly PriceSitemapEntry[];
  /** The route at `path`, or null: an unknown pair answers 404. */
  route(path: string): PriceRoute | null;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PriceDataError(
      `${file} is invalid, so no price page is built: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

/**
 * A record's verification date: the source's own "last checked" date, or the
 * founder's for a manual entry (both `source_verified_at`), else the day it
 * was observed.
 */
function verificationDate(record: PublishedRecord): string {
  const date = record.source_verified_at ?? record.observed_at?.slice(0, 10);
  if (date === undefined || date === null) {
    throw new PriceDataError(
      `the published record ${record.market}/${record.service_id}/${record.plan_id}/${record.billing_period} has no verification date`,
    );
  }
  return date;
}

function breadcrumbData(
  breadcrumbs: readonly PriceBreadcrumb[],
): Readonly<Record<string, unknown>> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };
}

function trail(
  path: string,
  serviceName: string,
  marketName: string,
): PriceBreadcrumb[] {
  return [
    { name: pricesCopy.home, url: canonicalUrl('/') },
    {
      name: pricesCopy.page.name(serviceName, marketName),
      url: canonicalUrl(path),
    },
  ];
}

function generatedRoute(
  page: GeneratedPage,
  catalogue: CatalogueFile,
  markets: MarketsFile,
): GeneratedPriceRoute {
  const service = catalogue.services.find(
    (item) => item.service_id === page.service_id,
  );
  const market = markets.markets.find((item) => item.code === page.market);
  if (service === undefined || market === undefined) {
    throw new PriceDataError(`${page.path} has no configured name`);
  }
  const rows = page.records.map((record): PlanRow => {
    const plan = service.plans.find(
      (item) =>
        item.plan_id === record.plan_id &&
        item.billing_period === record.billing_period,
    );
    if (plan === undefined) {
      throw new PriceDataError(`${page.path} shows an unconfigured plan`);
    }
    if (record.currency !== market.currency) {
      throw new PriceDataError(
        `${page.path} would show ${record.currency}, which is not ${market.name}'s currency ${market.currency}`,
      );
    }
    const verifiedOn = verificationDate(record);
    return {
      planId: plan.plan_id,
      planName: plan.name,
      billingPeriod: record.billing_period,
      amount: record.price_local,
      currency: record.currency,
      priceText: pricesCopy.page.price(record.price_local, record.currency),
      periodText: pricesCopy.page.period[record.billing_period],
      verifiedOn,
      verifiedText: pricesCopy.dayText(verifiedOn),
    };
  });
  const dates = rows.map((row) => row.verifiedOn).sort();
  const oldest = dates[0] as string;
  const newest = dates.at(-1) as string;
  const marketName = market.name_in_sentence ?? market.name;
  const breadcrumbs = trail(page.path, service.name, marketName);
  return {
    kind: 'generated',
    path: page.path,
    serviceId: page.service_id,
    market: page.market,
    serviceName: service.name,
    marketName,
    meta: {
      title: pricesCopy.page.title(service.name, marketName, newest),
      description: pricesCopy.page.description(
        service.name,
        marketName,
        newest,
      ),
    },
    heading: pricesCopy.page.heading(service.name, marketName, newest),
    tableCaption: pricesCopy.page.tableCaption(service.name, marketName),
    rows,
    verifiedLine:
      oldest === newest
        ? pricesCopy.page.verifiedOn(newest)
        : pricesCopy.page.verifiedBetween(oldest, newest),
    notAffiliated: pricesCopy.page.notAffiliated(service.name),
    breadcrumbs,
    structuredData: breadcrumbData(breadcrumbs),
    lastmod: newest,
  };
}

function unavailableRoute(
  entry: PublishedUrlsFile['urls'][number],
  catalogue: CatalogueFile,
  markets: MarketsFile,
): UnavailablePriceRoute {
  // Today's names where the service and market are still configured, else
  // the names the ledger recorded when the URL was first published.
  const serviceName =
    catalogue.services.find((item) => item.service_id === entry.service_id)
      ?.name ?? entry.service_name;
  const configured = markets.markets.find((item) => item.code === entry.market);
  const marketName =
    configured === undefined
      ? entry.market_name
      : (configured.name_in_sentence ?? configured.name);
  const breadcrumbs = trail(entry.path, serviceName, marketName);
  return {
    kind: 'unavailable',
    path: entry.path,
    serviceId: entry.service_id,
    market: entry.market,
    serviceName,
    marketName,
    meta: {
      title: pricesCopy.unavailable.title(serviceName, marketName),
      description: pricesCopy.unavailable.description(serviceName, marketName),
    },
    heading: pricesCopy.unavailable.heading(serviceName, marketName),
    note: pricesCopy.unavailable.note,
    notAffiliated: pricesCopy.page.notAffiliated(serviceName),
    breadcrumbs,
    structuredData: breadcrumbData(breadcrumbs),
  };
}

/**
 * The price site of one build. Every input is validated against its schema
 * first; an invalid file throws `PriceDataError` (or the gate's
 * `PublishGateError` for latest.json) and publishes nothing. `latest` is
 * null before the first `build-data`, which generates no page.
 */
export function createPriceSite(inputs: PriceSiteInputs): PriceSite {
  const catalogue = parse(
    catalogueFileSchema,
    inputs.catalogue,
    'config/catalogue.json',
  );
  const markets = parse(
    marketsFileSchema,
    inputs.markets,
    'config/markets.json',
  );
  const ledger = parse(
    publishedUrlsFileSchema,
    inputs.ledger,
    'data/price-index/published-urls.json',
  );
  const latest: LatestFile | null =
    inputs.latest === null
      ? null
      : parse(latestFileSchema, inputs.latest, 'data/price-index/latest.json');

  const byPath = new Map<string, PriceRoute>();
  for (const page of generatedPages(latest, catalogue, markets)) {
    byPath.set(page.path, generatedRoute(page, catalogue, markets));
  }
  for (const entry of ledger.urls) {
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, unavailableRoute(entry, catalogue, markets));
    }
  }
  const routes = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const sitemap = routes.flatMap((route) =>
    route.kind === 'generated'
      ? [{ path: route.path, lastmod: route.lastmod }]
      : [],
  );
  return {
    routes,
    sitemap,
    route: (path) => byPath.get(path) ?? null,
  };
}
