import {
  rankMarkets,
  type PublishedRecord,
} from '../../../packages/price-index/src/publish/gate.ts';
import {
  generatedPages,
  hubPaths,
  marketHubPath,
  retiredUrls,
  serviceHubPath,
  type GeneratedPage,
} from '../../../packages/price-index/src/publish/pages.ts';
// Only the schema modules the pages read, so no other part of the tool's
// schemas (its run files, reports and settings) is bundled into the site.
import {
  catalogueFileSchema,
  type CatalogueFile,
} from '../../../packages/price-index/src/schema/catalogue.ts';
import {
  changesFileSchema,
  type ChangeEntry,
} from '../../../packages/price-index/src/schema/changes.ts';
import { configIssues } from '../../../packages/price-index/src/schema/config.ts';
import { minorUnitExponent } from '../../../packages/price-index/src/schema/iso4217.ts';
import {
  marketsFileSchema,
  type MarketsFile,
} from '../../../packages/price-index/src/schema/markets.ts';
import {
  monthPattern,
  monthlyReportFileSchema,
  type MonthlyReportFile,
} from '../../../packages/price-index/src/schema/monthly-report.ts';
import {
  latestFileSchema,
  type LatestFile,
} from '../../../packages/price-index/src/schema/price-index-files.ts';
import {
  isRetirement,
  publishedUrlsFileSchema,
  servicePagePathPattern,
  type PublishedUrl,
} from '../../../packages/price-index/src/schema/published-urls.ts';
import type { ValstaraPricesFile } from '../../../packages/price-index/src/schema/valstara-prices.ts';
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
  /** data/price-index/changes.json: the page's price history (E11.6-11). */
  readonly changes: unknown;
  /** config/valstara-prices.json: the Valstara comparison (E11.6-11). */
  readonly valstaraPrices: unknown;
  /**
   * data/price-index/monthly/YYYY-MM.json, by file name (`2026-10.json`):
   * the monthly report pages (E11.6-13). None before the first report.
   */
  readonly monthly?: Readonly<Record<string, unknown>>;
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
  /**
   * Links to the page's service hub and market hub (E11.6-12), each only
   * while that hub exists: always both on a generated page.
   */
  readonly hubLinks: readonly HubLink[];
  /** The link to the methodology at `/price-index` (E11.6-13). */
  readonly methodologyLink: HubLink;
}

/** A link to a hub or a page, by its path. */
export interface HubLink {
  readonly path: string;
  readonly label: string;
}

/** One real price change of a plan the page shows, from changes.json. */
export interface HistoryItem {
  readonly planId: string;
  readonly planName: string;
  readonly billingPeriod: PublishedRecord['billing_period'];
  readonly direction: 'raised' | 'lowered';
  /** The entry's `old_price_local` and `new_price_local`, exactly. */
  readonly oldAmount: string;
  readonly newAmount: string;
  readonly currency: string;
  /** `YYYY-MM-DD`: the entry's `detected_on`. */
  readonly detectedOn: string;
  readonly text: string;
}

/** A market at one end of a plan's ranking, in its own currency. */
export interface MarketExtreme {
  readonly market: string;
  readonly marketName: string;
  /** The ranked record's published `price_local`, exactly. */
  readonly amount: string;
  readonly currency: string;
  readonly priceText: string;
}

/** Where this market sits among the markets `rankMarkets()` ranks for a plan. */
export interface PlanComparison {
  readonly planId: string;
  readonly billingPeriod: PublishedRecord['billing_period'];
  /** The market's rank, 1 for the most expensive. */
  readonly rank: number;
  readonly tied: boolean;
  /** M: how many markets `rankMarkets()` ranks for the plan. */
  readonly rankedMarkets: number;
  readonly sentence: string;
  readonly tableCaption: string;
  /** Null when every ranked market shares one rank. */
  readonly extremes: {
    readonly mostExpensive: MarketExtreme;
    readonly cheapest: MarketExtreme;
  } | null;
}

/** A generated page of another service in the same category and market. */
export interface RelatedLink {
  readonly path: string;
  readonly serviceId: string;
  readonly label: string;
}

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

/** One config/valstara-prices.json entry, compared like for like. */
export interface ValstaraRow {
  readonly planId: string;
  readonly planName: string;
  readonly termMonths: number;
  readonly termText: string;
  /**
   * The list price the Valstara price is compared with: the plan's published
   * price for the same billing period, or its monthly price × the term.
   */
  readonly listAmount: string;
  readonly listText: string;
  /** The entry's price, written at the currency's exponent. */
  readonly valstaraAmount: string;
  readonly valstaraText: string;
  readonly currency: string;
  /** How far below the list price, floored to one decimal. */
  readonly belowPercent: string;
  readonly belowText: string;
  /** The stated basis when the term is not the plan's billing period. */
  readonly basis: string | null;
}

export interface ValstaraComparison {
  readonly tableCaption: string;
  readonly rows: readonly ValstaraRow[];
}

/** A page that passes the generation rule. */
export interface GeneratedPriceRoute extends RouteBase {
  readonly kind: 'generated';
  readonly tableCaption: string;
  readonly rows: readonly PlanRow[];
  readonly verifiedLine: string;
  /** The newest verification date of its records: the sitemap `lastmod`. */
  readonly lastmod: string;
  /** Newest first; empty when changes.json has none for the shown plans. */
  readonly history: readonly HistoryItem[];
  /** One per shown plan this market is ranked for among two or more. */
  readonly comparisons: readonly PlanComparison[];
  /** Same category, same market, generated pages only, in catalogue order. */
  readonly related: readonly RelatedLink[];
  /** Questions the data answers; empty means no FAQ and no FAQPage data. */
  readonly faq: readonly FaqEntry[];
  /** FAQPage JSON-LD (schema.org), present exactly when the FAQ is. */
  readonly faqStructuredData: Readonly<Record<string, unknown>> | null;
  /**
   * The Valstara comparison, or null without a comparable entry. The page
   * renders it only while `prices.valstara_comparison` is on.
   */
  readonly valstara: ValstaraComparison | null;
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

/** One price a hub shows: a published record of a live page. */
export interface HubPrice {
  readonly planId: string;
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

/** A market on a service hub: one plan's price there, linking to its page. */
export interface ServiceHubRow extends HubPrice {
  readonly market: string;
  /** The market's name, as a table names it ("United States"). */
  readonly marketName: string;
  /** The service × market page. */
  readonly path: string;
  /** The market's rank from `rankMarkets()`, or null when it is unranked. */
  readonly rank: number | null;
}

/** One plan of a service hub, every market with a live page for it. */
export interface ServiceHubPlan {
  readonly planId: string;
  readonly planName: string;
  readonly billingPeriod: PublishedRecord['billing_period'];
  readonly tableCaption: string;
  /** How the rows are ordered; null for a single market. */
  readonly orderNote: string | null;
  /** Ranked markets in `rankMarkets()` order, then unranked by name. */
  readonly rows: readonly ServiceHubRow[];
}

/** A plan on a market hub, linking to its service × market page. */
export interface MarketHubRow extends HubPrice {
  readonly serviceId: string;
  /** "Spotify Premium — Individual". */
  readonly planLabel: string;
  readonly path: string;
}

/** One catalogue category of a market hub, in catalogue order. */
export interface MarketHubCategory {
  readonly category: CatalogueFile['services'][number]['category'];
  readonly heading: string;
  readonly tableCaption: string;
  readonly rows: readonly MarketHubRow[];
}

interface HubBase {
  readonly path: string;
  readonly meta: PriceMeta;
  readonly heading: string;
  readonly breadcrumbs: readonly PriceBreadcrumb[];
  /** BreadcrumbList JSON-LD (schema.org). */
  readonly structuredData: Readonly<Record<string, unknown>>;
  readonly verifiedLine: string;
  /** The newest verification date the hub shows: its sitemap `lastmod`. */
  readonly lastmod: string;
  readonly notAffiliated: string;
}

/** `/prices/{service}`: every live page of one service, plan by plan. */
export interface ServiceHub extends HubBase {
  readonly kind: 'service-hub';
  readonly serviceId: string;
  readonly serviceName: string;
  readonly plans: readonly ServiceHubPlan[];
}

/** `/prices/countries/{country}`: every live page in one market, by category. */
export interface MarketHub extends HubBase {
  readonly kind: 'market-hub';
  readonly market: string;
  readonly marketName: string;
  readonly categories: readonly MarketHubCategory[];
}

export type PriceHub = ServiceHub | MarketHub;

/** A group of hub links on `/prices`. */
export interface HubLinkGroup {
  readonly heading: string;
  readonly links: readonly HubLink[];
}

/** `/prices`: the top-level index of the service and market hubs. */
export interface PriceIndex {
  readonly kind: 'index';
  readonly path: '/prices';
  readonly meta: PriceMeta;
  readonly heading: string;
  readonly intro: string;
  readonly breadcrumbs: readonly PriceBreadcrumb[];
  readonly structuredData: Readonly<Record<string, unknown>>;
  /** The service hubs, by catalogue category; empty with no live page. */
  readonly services: readonly HubLinkGroup[];
  /** The market hubs, alphabetically by name; empty with no live page. */
  readonly markets: readonly HubLink[];
  /** Null with no live page: the index is then empty and `noindex`. */
  readonly verifiedLine: string | null;
  readonly lastmod: string | null;
  /** The honest empty state, or null when a page is live. */
  readonly empty: string | null;
  readonly notAffiliated: string;
}

/**
 * A piece of a sentence on a monthly report (E11.6-13): plain text, or the
 * name of a page the report mentions, linked while that page exists.
 */
export interface TextPart {
  readonly text: string;
  /** The page's path, or null: a page that is not generated is named only. */
  readonly href: string | null;
}

/** One change of the month, as `data/price-index/monthly/YYYY-MM.json` holds it. */
export interface MonthlyChangeRow {
  readonly serviceId: string;
  readonly planId: string;
  readonly billingPeriod: PublishedRecord['billing_period'];
  readonly market: string;
  /** "Spotify Premium — Individual". */
  readonly planLabel: string;
  /** The market, linking to the service × market page while it is generated. */
  readonly marketPart: TextPart;
  /** The file's `old_price_local` and `new_price_local`, exactly. */
  readonly oldAmount: string;
  readonly newAmount: string;
  readonly currency: string;
  /** The file's signed `change_percent`, exactly. */
  readonly changePercent: string;
  readonly oldText: string;
  readonly newText: string;
  readonly percentText: string;
}

/** `/price-index/{yyyy-mm}`: one monthly report file, rendered (E11.6-13). */
export interface MonthlyReportPage {
  readonly kind: 'monthly';
  readonly path: string;
  /** `YYYY-MM`. */
  readonly month: string;
  readonly meta: PriceMeta;
  readonly heading: string;
  readonly intro: string;
  readonly breadcrumbs: readonly PriceBreadcrumb[];
  /** BreadcrumbList JSON-LD (schema.org). */
  readonly structuredData: Readonly<Record<string, unknown>>;
  readonly changesCaption: string;
  /** Largest % first, as the file holds them. */
  readonly changes: readonly MonthlyChangeRow[];
  /** The honest "no changes" sentence, or null when there are changes. */
  readonly noChanges: string | null;
  /** "<plan> rose in N of M markets." — one per direction with a count. */
  readonly direction: readonly (readonly TextPart[])[];
  /** Each ranked plan's most and least expensive markets. */
  readonly extremes: readonly (readonly TextPart[])[];
  /** How many published plans the report could not rank, or null. */
  readonly unranked: string | null;
  /** `YYYY-MM-DD`: the day the report's snapshot was built, its sitemap `lastmod`. */
  readonly lastmod: string;
  readonly notAffiliated: string;
}

/** `/price-index`: the methodology's frame, from the data (E11.6-13). */
export interface PriceIndexLanding {
  readonly kind: 'price-index';
  readonly path: '/price-index';
  readonly breadcrumbs: readonly PriceBreadcrumb[];
  /** BreadcrumbList JSON-LD (schema.org). */
  readonly structuredData: Readonly<Record<string, unknown>>;
  /** Dataset JSON-LD (schema.org), or null while no price is published. */
  readonly dataset: Readonly<Record<string, unknown>> | null;
  /** Every monthly report, newest first. */
  readonly reports: readonly HubLink[];
  /** Null while no price is published. */
  readonly verifiedLine: string | null;
  readonly notAffiliated: string;
}

export interface PriceSite {
  /** Every price route, generated and unavailable, in path order. */
  readonly routes: readonly PriceRoute[];
  /** The generated pages only: unavailable ledger URLs are `noindex`. */
  readonly sitemap: readonly PriceSitemapEntry[];
  /** The route at `path`, or null: an unknown pair answers 404. */
  route(path: string): PriceRoute | null;
  /** Every service and market hub, in path order (E11.6-12). */
  readonly hubs: readonly PriceHub[];
  /** The hub at `path`, or null: a service or market with no page has none. */
  hub(path: string): PriceHub | null;
  /** `/prices` (E11.6-12). */
  readonly index: PriceIndex;
  /** The hubs' own child sitemaps, each entry dated from the data it shows. */
  readonly hubSitemaps: {
    readonly index: readonly PriceSitemapEntry[];
    readonly services: readonly PriceSitemapEntry[];
    readonly markets: readonly PriceSitemapEntry[];
  };
  /**
   * The hub a retired URL answers 301 to while its pair generates no page,
   * or null (E11.6-12, D2 and D-037 Q2).
   */
  redirect(path: string): string | null;
  /** `/price-index` (E11.6-13). */
  readonly priceIndex: PriceIndexLanding;
  /** Every monthly report page, newest first (E11.6-13). */
  readonly monthlyReports: readonly MonthlyReportPage[];
  /** The report at `path`, or null: a month with no report file has no page. */
  monthlyReport(path: string): MonthlyReportPage | null;
  /** The monthly reports' own child sitemap, each dated by its snapshot. */
  readonly monthlySitemap: readonly PriceSitemapEntry[];
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

/** The methodology, where every price page says how its prices are checked. */
export const priceIndexPath = '/price-index';

const methodologyLink: HubLink = {
  path: priceIndexPath,
  label: pricesCopy.page.methodologyLink,
};

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

/** Valstara → Prices → the hub; `/prices` itself ends at Prices. */
function hubTrail(path: string, name: string | null): PriceBreadcrumb[] {
  return [
    { name: pricesCopy.home, url: canonicalUrl('/') },
    { name: pricesCopy.hubs.pricesCrumb, url: canonicalUrl('/prices') },
    ...(name === null ? [] : [{ name, url: canonicalUrl(path) }]),
  ];
}

/** Everything a generated page's content blocks read (E11.6-11). */
interface ContentContext {
  readonly catalogue: CatalogueFile;
  readonly markets: MarketsFile;
  readonly latest: LatestFile;
  readonly changes: readonly ChangeEntry[];
  readonly valstaraPrices: ValstaraPricesFile['prices'];
  /** Every generated page of the build, in catalogue then markets order. */
  readonly pages: readonly GeneratedPage[];
}

/**
 * An exact decimal in minor units at its currency's exponent: `"149.00"`
 * SEK is 14900n. A value with more decimals than the currency has is not a
 * price in that currency, so it publishes nothing.
 */
function minorUnits(value: string, currency: string, what: string): bigint {
  const exponent = minorUnitExponent(currency);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value);
  const fraction = match?.[2] ?? '';
  if (match === null || fraction.length > exponent) {
    throw new PriceDataError(
      `${what} ${value} is not an exact ${currency} amount`,
    );
  }
  return BigInt(`${match[1]}${fraction.padEnd(exponent, '0')}`);
}

/** Minor units back to the record's form: 178800n SEK is `"1788.00"`. */
function decimalText(minor: bigint, currency: string): string {
  const exponent = minorUnitExponent(currency);
  if (exponent === 0) {
    return minor.toString();
  }
  const digits = minor.toString().padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * Price history: the changes.json entries of the plans the page shows (so
 * never a value the gate does not pass today), in the market's currency,
 * newest first. A plan the gate leaves off the page shows no history.
 */
function historyItems(
  page: GeneratedPage,
  rows: readonly PlanRow[],
  changes: readonly ChangeEntry[],
): HistoryItem[] {
  const items = changes.flatMap((entry, index) => {
    const rowIndex = rows.findIndex(
      (row) =>
        row.planId === entry.plan_id &&
        row.billingPeriod === entry.billing_period,
    );
    const row = rows[rowIndex];
    if (
      entry.market !== page.market ||
      entry.service_id !== page.service_id ||
      row === undefined ||
      entry.currency !== row.currency
    ) {
      return [];
    }
    const oldMinor = minorUnits(
      entry.old_price_local,
      entry.currency,
      'A changes.json price',
    );
    const newMinor = minorUnits(
      entry.new_price_local,
      entry.currency,
      'A changes.json price',
    );
    const direction: HistoryItem['direction'] =
      newMinor > oldMinor ? 'raised' : 'lowered';
    const oldPrice = pricesCopy.page.price(
      entry.old_price_local,
      entry.currency,
    );
    const newPrice = pricesCopy.page.price(
      entry.new_price_local,
      entry.currency,
    );
    const item: HistoryItem = {
      planId: row.planId,
      planName: row.planName,
      billingPeriod: row.billingPeriod,
      direction,
      oldAmount: entry.old_price_local,
      newAmount: entry.new_price_local,
      currency: entry.currency,
      detectedOn: entry.detected_on,
      text: pricesCopy.page.history[direction](
        oldPrice,
        newPrice,
        entry.detected_on,
      ),
    };
    return [{ item, rowIndex, index }];
  });
  // Newest first; on one date, in the table's plan order, the later entry
  // in the append-only log first.
  return items
    .sort((a, b) =>
      a.item.detectedOn !== b.item.detectedOn
        ? a.item.detectedOn < b.item.detectedOn
          ? 1
          : -1
        : a.rowIndex !== b.rowIndex
          ? a.rowIndex - b.rowIndex
          : b.index - a.index,
    )
    .map(({ item }) => item);
}

function extreme(
  ranked: ReturnType<typeof rankMarkets>[number],
  markets: MarketsFile,
): MarketExtreme {
  const market = markets.markets.find((item) => item.code === ranked.market);
  if (market === undefined || ranked.record.currency !== market.currency) {
    throw new PriceDataError(
      `the ranked record of ${ranked.market} is not in a configured market's currency`,
    );
  }
  return {
    market: ranked.market,
    marketName: market.name,
    amount: ranked.record.price_local,
    currency: ranked.record.currency,
    priceText: pricesCopy.page.price(
      ranked.record.price_local,
      ranked.record.currency,
    ),
  };
}

/**
 * The cross-market comparison of each shown plan, from `rankMarkets()` and
 * nothing else: N is this market's rank, M is how many markets it ranks.
 * Hidden for a plan this market is unranked for (no USD figure), for a plan
 * ranked in fewer than two markets (there is nothing to compare with), and
 * for a ranking that holds a market the configuration does not enable (M
 * would count a market we do not serve). The extremes follow the monthly
 * report's rule: rank 1, and the first market by code of the last rank.
 */
function planComparisons(
  page: GeneratedPage,
  rows: readonly PlanRow[],
  serviceName: string,
  marketName: string,
  context: ContentContext,
): PlanComparison[] {
  const enabled = new Set(
    context.markets.markets
      .filter((market) => market.enabled)
      .map((market) => market.code),
  );
  return rows.flatMap((row): PlanComparison[] => {
    const ranking = rankMarkets(context.latest, {
      service_id: page.service_id,
      plan_id: row.planId,
      billing_period: row.billingPeriod,
    });
    const own = ranking.find((ranked) => ranked.market === page.market);
    if (
      own === undefined ||
      ranking.length < 2 ||
      ranking.some((ranked) => !enabled.has(ranked.market))
    ) {
      return [];
    }
    const plan = pricesCopy.planLabel(serviceName, row.planName);
    const tied =
      ranking.filter((ranked) => ranked.rank === own.rank).length > 1;
    const mostExpensive = ranking[0]!;
    const lastRank = ranking.at(-1)!.rank;
    const cheapest = ranking.find((ranked) => ranked.rank === lastRank)!;
    return [
      {
        planId: row.planId,
        billingPeriod: row.billingPeriod,
        rank: own.rank,
        tied,
        rankedMarkets: ranking.length,
        sentence: pricesCopy.page.comparison.rank(
          marketName,
          own.rank,
          tied,
          ranking.length,
          plan,
        ),
        tableCaption: pricesCopy.page.comparison.tableCaption(
          ranking.length,
          plan,
        ),
        extremes:
          lastRank === 1
            ? null
            : {
                mostExpensive: extreme(mostExpensive, context.markets),
                cheapest: extreme(cheapest, context.markets),
              },
      },
    ];
  });
}

/** Generated pages of the same category in the same market, never itself. */
function relatedLinks(
  page: GeneratedPage,
  marketName: string,
  catalogue: CatalogueFile,
  pages: readonly GeneratedPage[],
): RelatedLink[] {
  const category = (serviceId: string) =>
    catalogue.services.find((service) => service.service_id === serviceId)
      ?.category;
  const own = category(page.service_id);
  return pages
    .filter(
      (other) =>
        other.market === page.market &&
        other.service_id !== page.service_id &&
        category(other.service_id) === own,
    )
    .map((other) => ({
      path: other.path,
      serviceId: other.service_id,
      label: pricesCopy.page.name(other.service_name, marketName),
    }));
}

/**
 * The FAQ: a question only where the data answers it. The price question
 * always has the page's published rows; the comparison and history
 * questions are asked only when those blocks render, and answer with their
 * own sentences (the newest change of each plan).
 */
function faqEntries(
  serviceName: string,
  marketName: string,
  rows: readonly PlanRow[],
  verifiedLine: string,
  comparisons: readonly PlanComparison[],
  history: readonly HistoryItem[],
): FaqEntry[] {
  const faq = pricesCopy.page.faq;
  const entries: FaqEntry[] = [];
  if (rows.length > 0) {
    entries.push({
      question: faq.priceQuestion(serviceName, marketName),
      answer: [
        ...rows.map((row) =>
          faq.priceAnswer(
            pricesCopy.planLabel(serviceName, row.planName),
            row.priceText,
            row.periodText,
          ),
        ),
        verifiedLine,
      ].join(' '),
    });
  }
  if (comparisons.length > 0) {
    entries.push({
      question: faq.comparisonQuestion(serviceName, marketName),
      answer: comparisons.map((comparison) => comparison.sentence).join(' '),
    });
  }
  const newest = history.filter(
    (item, index) =>
      history.findIndex(
        (other) =>
          other.planId === item.planId &&
          other.billingPeriod === item.billingPeriod,
      ) === index,
  );
  if (newest.length > 0) {
    entries.push({
      question: faq.historyQuestion(serviceName, marketName),
      answer: newest
        .map((item) =>
          faq.historyAnswer[item.direction](
            pricesCopy.planLabel(serviceName, item.planName),
            pricesCopy.page.price(item.oldAmount, item.currency),
            pricesCopy.page.price(item.newAmount, item.currency),
            item.detectedOn,
          ),
        )
        .join(' '),
    });
  }
  return entries;
}

/** FAQPage JSON-LD (schema.org) of exactly the visible questions. */
function faqData(
  entries: readonly FaqEntry[],
): Readonly<Record<string, unknown>> | null {
  if (entries.length === 0) {
    return null;
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: { '@type': 'Answer', text: entry.answer },
    })),
  };
}

/**
 * The Valstara comparison: each config/valstara-prices.json entry for this
 * service and market, against the published price of the same plan. Like
 * for like: a 1-month entry against a monthly plan or a 12-month entry
 * against a yearly one compares with that price; any other term of a
 * monthly plan compares with the monthly price × the term, and states that
 * basis in words; any other term of a yearly plan has no basis and is not
 * shown. Nothing is shown for a plan without a published price, or for a
 * Valstara price that is not below the list price. The percentage is
 * computed exactly in minor units and floored to one decimal, so it never
 * overstates. Null when no entry is comparable.
 */
function valstaraComparison(
  page: GeneratedPage,
  serviceName: string,
  marketName: string,
  rows: readonly PlanRow[],
  entries: ValstaraPricesFile['prices'],
): ValstaraComparison | null {
  const copy = pricesCopy.page.valstara;
  const comparable = entries
    .filter(
      (entry) =>
        entry.service_id === page.service_id && entry.market === page.market,
    )
    .flatMap((entry) => {
      const rowIndex = rows.findIndex((row) => row.planId === entry.plan_id);
      const row = rows[rowIndex];
      if (row === undefined) {
        return [];
      }
      if (entry.currency !== row.currency) {
        throw new PriceDataError(
          `the Valstara price of ${page.path} is in ${entry.currency}, not ${row.currency}`,
        );
      }
      const listed = minorUnits(row.amount, row.currency, 'A published price');
      const sameTerm =
        (row.billingPeriod === 'month' && entry.term_months === 1) ||
        (row.billingPeriod === 'year' && entry.term_months === 12);
      if (!sameTerm && row.billingPeriod !== 'month') {
        return [];
      }
      const list = sameTerm ? listed : listed * BigInt(entry.term_months);
      const valstara = minorUnits(
        entry.price_local,
        entry.currency,
        'A Valstara price',
      );
      if (valstara >= list) {
        return [];
      }
      const tenths = ((list - valstara) * 1000n) / list;
      // Floored, a price less than 0.1% below list would read "0.0% below
      // list price": not shown, as a price not below list is not (D-033 Q2).
      if (tenths === 0n) {
        return [];
      }
      const belowPercent = `${tenths / 10n}.${tenths % 10n}`;
      const listAmount = decimalText(list, row.currency);
      const valstaraAmount = decimalText(valstara, row.currency);
      const value: ValstaraRow = {
        planId: row.planId,
        planName: row.planName,
        termMonths: entry.term_months,
        termText: copy.term(entry.term_months),
        listAmount,
        listText: pricesCopy.page.price(listAmount, row.currency),
        valstaraAmount,
        valstaraText: pricesCopy.page.price(valstaraAmount, row.currency),
        currency: row.currency,
        belowPercent,
        belowText: copy.below(belowPercent),
        basis: sameTerm
          ? null
          : copy.basis(
              pricesCopy.planLabel(serviceName, row.planName),
              entry.term_months,
              row.priceText,
            ),
      };
      return [{ value, rowIndex }];
    })
    .sort((a, b) =>
      a.rowIndex !== b.rowIndex
        ? a.rowIndex - b.rowIndex
        : a.value.termMonths - b.value.termMonths,
    )
    .map(({ value }) => value);
  return comparable.length === 0
    ? null
    : {
        tableCaption: copy.tableCaption(serviceName, marketName),
        rows: comparable,
      };
}

function generatedRoute(
  page: GeneratedPage,
  context: ContentContext,
): GeneratedPriceRoute {
  const { catalogue, markets } = context;
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
  const verifiedLine =
    oldest === newest
      ? pricesCopy.page.verifiedOn(newest)
      : pricesCopy.page.verifiedBetween(oldest, newest);
  const history = historyItems(page, rows, context.changes);
  const comparisons = planComparisons(
    page,
    rows,
    service.name,
    marketName,
    context,
  );
  const faq = faqEntries(
    service.name,
    marketName,
    rows,
    verifiedLine,
    comparisons,
    history,
  );
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
    verifiedLine,
    notAffiliated: pricesCopy.page.notAffiliated(service.name),
    breadcrumbs,
    structuredData: breadcrumbData(breadcrumbs),
    hubLinks: [
      {
        path: serviceHubPath(page.service_id),
        label: pricesCopy.hubs.service.name(service.name),
      },
      {
        path: marketHubPath(page.market_slug),
        label: pricesCopy.hubs.market.name(marketName),
      },
    ],
    methodologyLink,
    lastmod: newest,
    history,
    comparisons,
    related: relatedLinks(page, marketName, catalogue, context.pages),
    faq,
    faqStructuredData: faqData(faq),
    valstara: valstaraComparison(
      page,
      service.name,
      marketName,
      rows,
      context.valstaraPrices,
    ),
  };
}

function unavailableRoute(
  entry: PublishedUrl,
  catalogue: CatalogueFile,
  markets: MarketsFile,
  hubs: ReadonlySet<string>,
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
  // Its hubs, while they exist: a removed service or market has none.
  const marketSlug = servicePagePathPattern.exec(entry.path)?.[2] ?? '';
  const hubLinks = [
    {
      path: serviceHubPath(entry.service_id),
      label: pricesCopy.hubs.service.name(serviceName),
    },
    {
      path: marketHubPath(marketSlug),
      label: pricesCopy.hubs.market.name(marketName),
    },
  ].filter((link) => hubs.has(link.path));
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
    hubLinks,
    methodologyLink,
  };
}

/** A published record as a hub shows it, in its own currency. */
function hubPrice(record: PublishedRecord): HubPrice {
  const verifiedOn = verificationDate(record);
  return {
    planId: record.plan_id,
    billingPeriod: record.billing_period,
    amount: record.price_local,
    currency: record.currency,
    priceText: pricesCopy.page.price(record.price_local, record.currency),
    periodText: pricesCopy.page.period[record.billing_period],
    verifiedOn,
    verifiedText: pricesCopy.dayText(verifiedOn),
  };
}

/** The "Prices verified …" line and the newest date of `dates`. */
function verifiedSpan(dates: readonly string[]): {
  line: string;
  newest: string;
} {
  const sorted = [...dates].sort();
  const oldest = sorted[0] as string;
  const newest = sorted.at(-1) as string;
  return {
    line:
      oldest === newest
        ? pricesCopy.page.verifiedOn(newest)
        : pricesCopy.page.verifiedBetween(oldest, newest),
    newest,
  };
}

const marketNameOrder = new Intl.Collator('en');

/** The catalogue's categories, in the order they first appear in it. */
function categoryOrder(
  catalogue: CatalogueFile,
): MarketHubCategory['category'][] {
  return [...new Set(catalogue.services.map((service) => service.category))];
}

/**
 * The service hub (E11.6-12): for each catalogue plan, every market whose
 * live page publishes it, with its local price, linking to the page. Ranked
 * markets come in `rankMarkets()` order, so the hub agrees with each page's
 * rank sentence; markets the ranking leaves out (no USD figure) follow,
 * alphabetically by name. A plan no live page publishes is left out.
 */
function serviceHub(
  serviceId: string,
  pages: readonly GeneratedPage[],
  context: ContentContext,
): ServiceHub {
  const service = context.catalogue.services.find(
    (item) => item.service_id === serviceId,
  );
  if (service === undefined) {
    throw new PriceDataError(`the hub of ${serviceId} has no configured name`);
  }
  const own = pages.filter((page) => page.service_id === serviceId);
  const plans = service.plans.flatMap((plan): ServiceHubPlan[] => {
    const entries = own.flatMap((page) => {
      const record = page.records.find(
        (item) =>
          item.plan_id === plan.plan_id &&
          item.billing_period === plan.billing_period,
      );
      return record === undefined ? [] : [{ page, record }];
    });
    if (entries.length === 0) {
      return [];
    }
    const ranking = rankMarkets(context.latest, {
      service_id: serviceId,
      plan_id: plan.plan_id,
      billing_period: plan.billing_period,
    });
    const position = new Map(
      ranking.map((ranked, index) => [ranked.market, index]),
    );
    const rankOf = new Map(
      ranking.map((ranked) => [ranked.market, ranked.rank]),
    );
    const ranked = entries
      .filter((entry) => position.has(entry.page.market))
      .sort(
        (a, b) =>
          (position.get(a.page.market) as number) -
          (position.get(b.page.market) as number),
      );
    const unranked = entries
      .filter((entry) => !position.has(entry.page.market))
      .sort(
        (a, b) =>
          marketNameOrder.compare(a.page.market_name, b.page.market_name) ||
          (a.page.market < b.page.market ? -1 : 1),
      );
    return [
      {
        planId: plan.plan_id,
        planName: plan.name,
        billingPeriod: plan.billing_period,
        tableCaption: pricesCopy.hubs.service.tableCaption(
          pricesCopy.planLabel(service.name, plan.name),
        ),
        orderNote:
          entries.length < 2
            ? null
            : pricesCopy.hubs.service.orderNote(ranked.length, unranked.length),
        rows: [...ranked, ...unranked].map(({ page, record }) => ({
          ...hubPrice(record),
          market: page.market,
          marketName: page.market_name,
          path: page.path,
          rank: rankOf.get(page.market) ?? null,
        })),
      },
    ];
  });
  const span = verifiedSpan(
    plans.flatMap((plan) => plan.rows.map((row) => row.verifiedOn)),
  );
  const path = serviceHubPath(serviceId);
  const breadcrumbs = hubTrail(
    path,
    pricesCopy.hubs.service.name(service.name),
  );
  return {
    kind: 'service-hub',
    path,
    serviceId,
    serviceName: service.name,
    meta: {
      title: pricesCopy.hubs.service.title(service.name, span.newest),
      description: pricesCopy.hubs.service.description(
        service.name,
        span.newest,
      ),
    },
    heading: pricesCopy.hubs.service.heading(service.name, span.newest),
    breadcrumbs,
    structuredData: breadcrumbData(breadcrumbs),
    plans,
    verifiedLine: span.line,
    lastmod: span.newest,
    notAffiliated: pricesCopy.hubs.notAffiliated,
  };
}

/**
 * The market hub (E11.6-12): every live page in one market, grouped by the
 * catalogue's categories in catalogue order, each plan it publishes with its
 * local price, linking to the page.
 */
function marketHub(
  marketSlug: string,
  pages: readonly GeneratedPage[],
  context: ContentContext,
): MarketHub {
  const own = pages.filter((page) => page.market_slug === marketSlug);
  const first = own[0];
  if (first === undefined) {
    throw new PriceDataError(`the hub of ${marketSlug} has no page`);
  }
  const marketName = first.market_name_in_sentence;
  const categories = categoryOrder(context.catalogue).flatMap(
    (category): MarketHubCategory[] => {
      const rows = context.catalogue.services
        .filter((service) => service.category === category)
        .flatMap((service) => {
          const page = own.find(
            (item) => item.service_id === service.service_id,
          );
          if (page === undefined) {
            return [];
          }
          return page.records.map((record): MarketHubRow => {
            const plan = service.plans.find(
              (item) =>
                item.plan_id === record.plan_id &&
                item.billing_period === record.billing_period,
            );
            if (plan === undefined) {
              throw new PriceDataError(
                `${page.path} shows an unconfigured plan`,
              );
            }
            return {
              ...hubPrice(record),
              serviceId: service.service_id,
              planLabel: pricesCopy.planLabel(service.name, plan.name),
              path: page.path,
            };
          });
        });
      if (rows.length === 0) {
        return [];
      }
      const heading = pricesCopy.hubs.categories[category];
      return [
        {
          category,
          heading,
          tableCaption: pricesCopy.hubs.market.tableCaption(
            heading,
            marketName,
          ),
          rows,
        },
      ];
    },
  );
  const span = verifiedSpan(
    categories.flatMap((category) =>
      category.rows.map((row) => row.verifiedOn),
    ),
  );
  const path = marketHubPath(marketSlug);
  const breadcrumbs = hubTrail(path, pricesCopy.hubs.market.name(marketName));
  return {
    kind: 'market-hub',
    path,
    market: first.market,
    marketName,
    meta: {
      title: pricesCopy.hubs.market.title(marketName, span.newest),
      description: pricesCopy.hubs.market.description(marketName, span.newest),
    },
    heading: pricesCopy.hubs.market.heading(marketName, span.newest),
    breadcrumbs,
    structuredData: breadcrumbData(breadcrumbs),
    categories,
    verifiedLine: span.line,
    lastmod: span.newest,
    notAffiliated: pricesCopy.hubs.notAffiliated,
  };
}

/**
 * `/prices` (E11.6-12): the service hubs by category and the market hubs by
 * name. With no live page it says so, and the page is `noindex` and in no
 * sitemap, so the footer's link always reaches a page that is there.
 */
function priceIndex(
  pages: readonly GeneratedPage[],
  catalogue: CatalogueFile,
): PriceIndex {
  const copy = pricesCopy.hubs.index;
  const services = categoryOrder(catalogue).flatMap((category) => {
    const links = catalogue.services
      .filter(
        (service) =>
          service.category === category &&
          pages.some((page) => page.service_id === service.service_id),
      )
      .map((service) => ({
        path: serviceHubPath(service.service_id),
        label: service.name,
      }));
    return links.length === 0
      ? []
      : [{ heading: pricesCopy.hubs.categories[category], links }];
  });
  const marketPages = new Map<string, GeneratedPage>();
  for (const page of pages) {
    if (!marketPages.has(page.market_slug)) {
      marketPages.set(page.market_slug, page);
    }
  }
  const markets = [...marketPages.values()]
    .sort((a, b) => marketNameOrder.compare(a.market_name, b.market_name))
    .map((page) => ({
      path: marketHubPath(page.market_slug),
      label: page.market_name,
    }));
  const dates = pages.flatMap((page) => page.records.map(verificationDate));
  const span = dates.length === 0 ? null : verifiedSpan(dates);
  const breadcrumbs = hubTrail('/prices', null);
  return {
    kind: 'index',
    path: '/prices',
    meta: { title: copy.title, description: copy.description },
    heading: copy.heading,
    intro: copy.intro,
    breadcrumbs,
    structuredData: breadcrumbData(breadcrumbs),
    services,
    markets,
    verifiedLine: span?.line ?? null,
    lastmod: span?.newest ?? null,
    empty: span === null ? copy.empty : null,
    notAffiliated: pricesCopy.hubs.notAffiliated,
  };
}

/** `2026-10.json`: a monthly report file's name, the month it reports. */
const monthlyFileName = /^(\d{4}-(?:0[1-9]|1[0-2]))\.json$/u;

/** `/price-index/2026-10`: a monthly report's permanent URL. */
export function monthlyReportPath(month: string): string {
  return `${priceIndexPath}/${month}`;
}

/**
 * The monthly report files, validated, oldest first. A file whose name is
 * not `YYYY-MM.json`, or whose `month` is not its name, fails the build.
 */
function monthlyReportFiles(
  files: Readonly<Record<string, unknown>>,
): MonthlyReportFile[] {
  return Object.entries(files)
    .map(([name, value]) => {
      const month = monthlyFileName.exec(name)?.[1];
      if (month === undefined) {
        throw new PriceDataError(
          `data/price-index/monthly/${name} is not named YYYY-MM.json, so no price page is built`,
        );
      }
      const report = parse(
        monthlyReportFileSchema,
        value,
        `data/price-index/monthly/${name}`,
      );
      if (report.month !== month || !monthPattern.test(report.month)) {
        throw new PriceDataError(
          `data/price-index/monthly/${name} reports ${report.month}, not ${month}, so no price page is built`,
        );
      }
      return report;
    })
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/**
 * The names a monthly report shows. A report is a dated record, so it may
 * mention a service, plan or market the configuration no longer has: it is
 * then named as the ledger recorded it when its page was published, and
 * otherwise by its identifier, and never linked.
 */
function reportNamer(
  catalogue: CatalogueFile,
  markets: MarketsFile,
  ledger: z.infer<typeof publishedUrlsFileSchema>,
) {
  const publications = ledger.urls.filter(
    (entry): entry is PublishedUrl => !isRetirement(entry),
  );
  const configuredMarket = (code: string) =>
    markets.markets.find((market) => market.code === code);
  const ledgerMarket = (code: string) =>
    publications.find((entry) => entry.market === code)?.market_name;
  const service = (serviceId: string) =>
    catalogue.services.find((item) => item.service_id === serviceId);
  const serviceName = (serviceId: string) =>
    service(serviceId)?.name ??
    publications.find((entry) => entry.service_id === serviceId)
      ?.service_name ??
    serviceId;
  return {
    plan(serviceId: string, planId: string, billingPeriod: string): string {
      const name =
        service(serviceId)?.plans.find(
          (plan) =>
            plan.plan_id === planId && plan.billing_period === billingPeriod,
        )?.name ?? planId;
      return pricesCopy.planLabel(serviceName(serviceId), name);
    },
    /** As a table names it ("United States"). */
    market: (code: string) =>
      configuredMarket(code)?.name ?? ledgerMarket(code) ?? code,
    /** As a sentence names it ("the United States"). */
    marketInSentence(code: string): string {
      const configured = configuredMarket(code);
      return configured === undefined
        ? (ledgerMarket(code) ?? code)
        : (configured.name_in_sentence ?? configured.name);
    },
  };
}

/**
 * A monthly report page (E11.6-13), from its file and the build's live
 * pages. Every page the report mentions is linked while it exists: a
 * service × market pair to its generated page, a plan to its service hub.
 * One that does not exist (not generated, retired, or no longer configured)
 * is named without a link. Every figure is the file's, exactly; the file
 * holds no USD figure and no converted price (E11.6-09).
 */
function monthlyReportPage(
  report: MonthlyReportFile,
  pages: readonly GeneratedPage[],
  hubs: ReadonlySet<string>,
  names: ReturnType<typeof reportNamer>,
): MonthlyReportPage {
  const copy = pricesCopy.monthly;
  const pagePaths = new Map(
    pages.map((page) => [`${page.service_id}/${page.market}`, page.path]),
  );
  const pagePart = (
    serviceId: string,
    market: string,
    text: string,
  ): TextPart => ({
    text,
    href: pagePaths.get(`${serviceId}/${market}`) ?? null,
  });
  const planPart = (plan: {
    service_id: string;
    plan_id: string;
    billing_period: string;
  }): TextPart => {
    const hub = serviceHubPath(plan.service_id);
    return {
      text: names.plan(plan.service_id, plan.plan_id, plan.billing_period),
      href: hubs.has(hub) ? hub : null,
    };
  };
  const text = (value: string): TextPart => ({ text: value, href: null });

  const changes = report.changes.map((entry): MonthlyChangeRow => ({
    serviceId: entry.service_id,
    planId: entry.plan_id,
    billingPeriod: entry.billing_period,
    market: entry.market,
    planLabel: names.plan(
      entry.service_id,
      entry.plan_id,
      entry.billing_period,
    ),
    marketPart: pagePart(
      entry.service_id,
      entry.market,
      names.market(entry.market),
    ),
    oldAmount: entry.old_price_local,
    newAmount: entry.new_price_local,
    currency: entry.currency,
    changePercent: entry.change_percent,
    oldText: pricesCopy.page.price(entry.old_price_local, entry.currency),
    newText: pricesCopy.page.price(entry.new_price_local, entry.currency),
    percentText: copy.percent(entry.change_percent),
  }));
  const direction = report.plans.flatMap((plan) => [
    ...(plan.rose_in > 0
      ? [
          [
            planPart(plan),
            text(copy.rose(plan.rose_in, plan.published_markets)),
          ],
        ]
      : []),
    ...(plan.fell_in > 0
      ? [
          [
            planPart(plan),
            text(copy.fell(plan.fell_in, plan.published_markets)),
          ],
        ]
      : []),
  ]);
  const ranked = report.plans.filter(
    (plan) => plan.most_expensive !== null && plan.least_expensive !== null,
  );
  const extremes = ranked.map((plan) => {
    const most = plan.most_expensive!;
    const least = plan.least_expensive!;
    return [
      planPart(plan),
      text(copy.extremes.most),
      pagePart(
        plan.service_id,
        most.market,
        names.marketInSentence(most.market),
      ),
      text(
        copy.extremes.price(
          pricesCopy.page.price(most.price_local, most.currency),
        ),
      ),
      text(copy.extremes.least),
      pagePart(
        plan.service_id,
        least.market,
        names.marketInSentence(least.market),
      ),
      text(
        `${copy.extremes.price(
          pricesCopy.page.price(least.price_local, least.currency),
        )}${copy.extremes.end}`,
      ),
    ];
  });
  const unranked = report.plans.length - ranked.length;
  const path = monthlyReportPath(report.month);
  const name = copy.name(report.month);
  const breadcrumbs: PriceBreadcrumb[] = [
    { name: pricesCopy.home, url: canonicalUrl('/') },
    { name: pricesCopy.priceIndex.crumb, url: canonicalUrl(priceIndexPath) },
    { name, url: canonicalUrl(path) },
  ];
  return {
    kind: 'monthly',
    path,
    month: report.month,
    meta: {
      title: copy.title(report.month),
      description: copy.description(report.month),
    },
    heading: name,
    intro: copy.intro(report.markets, report.built_at.slice(0, 10)),
    breadcrumbs,
    structuredData: breadcrumbData(breadcrumbs),
    changesCaption: copy.changesCaption(report.month),
    changes,
    noChanges: changes.length === 0 ? copy.noChanges(report.month) : null,
    direction,
    extremes,
    unranked:
      unranked > 0 && ranked.length > 0 ? copy.unranked(unranked) : null,
    lastmod: report.built_at.slice(0, 10),
    notAffiliated: pricesCopy.hubs.notAffiliated,
  };
}

/**
 * The Dataset JSON-LD of `/price-index` (E11.6-13): what the index is, the
 * enabled markets it covers, and the span of verification dates of the
 * prices it publishes, newest as `dateModified`. Every figure is read from
 * the published data; with no published price there is no dataset to
 * describe, so there is none.
 */
function datasetData(
  pages: readonly GeneratedPage[],
  markets: MarketsFile,
): Readonly<Record<string, unknown>> | null {
  const dates = pages
    .flatMap((page) => page.records.map(verificationDate))
    .sort();
  const oldest = dates[0];
  const newest = dates.at(-1);
  if (oldest === undefined || newest === undefined) {
    return null;
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: pricesCopy.priceIndex.dataset.name,
    description: pricesCopy.priceIndex.dataset.description,
    url: canonicalUrl(priceIndexPath),
    temporalCoverage: oldest === newest ? newest : `${oldest}/${newest}`,
    spatialCoverage: markets.markets
      .filter((market) => market.enabled)
      .map((market) => ({
        '@type': 'Country',
        name: market.name,
        identifier: market.code,
      })),
    dateModified: newest,
  };
}

function priceIndexLanding(
  pages: readonly GeneratedPage[],
  markets: MarketsFile,
  reports: readonly MonthlyReportPage[],
): PriceIndexLanding {
  const breadcrumbs: PriceBreadcrumb[] = [
    { name: pricesCopy.home, url: canonicalUrl('/') },
    { name: pricesCopy.priceIndex.crumb, url: canonicalUrl(priceIndexPath) },
  ];
  const dates = pages.flatMap((page) => page.records.map(verificationDate));
  return {
    kind: 'price-index',
    path: priceIndexPath,
    breadcrumbs,
    structuredData: breadcrumbData(breadcrumbs),
    dataset: datasetData(pages, markets),
    reports: reports.map((report) => ({
      path: report.path,
      label: pricesCopy.priceIndex.reportLink(report.month),
    })),
    verifiedLine: dates.length === 0 ? null : verifiedSpan(dates).line,
    notAffiliated: pricesCopy.hubs.notAffiliated,
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
  const changes = parse(
    changesFileSchema,
    inputs.changes,
    'data/price-index/changes.json',
  );
  // The Valstara prices with the cross-file rules `price-index validate`
  // applies: a known service, plan and market, the market's currency, a
  // price at that currency's exponent, and one entry per service, plan,
  // market and term.
  const config = configIssues({
    markets: inputs.markets,
    catalogue: inputs.catalogue,
    valstaraPrices: inputs.valstaraPrices,
  });
  if (config.config === undefined) {
    throw new PriceDataError(
      `the price configuration is invalid, so no price page is built: ${config.issues
        .map(
          (issue) =>
            `${issue.file} (${issue.path || 'file'}): ${issue.message}`,
        )
        .join('; ')}`,
    );
  }

  // Every generated page is served, retired or not. A retirement applies
  // only while its pair generates no page: the URL then answers 301 to its
  // hub in place of the unavailable state (E11.6-12, D2 and D-037 Q2).
  const pages = generatedPages(latest, catalogue, markets);
  const retired = retiredUrls(ledger, pages);
  const hubSet = new Set(hubPaths(pages));
  const byPath = new Map<string, PriceRoute>();
  const hubs: PriceHub[] = [];
  if (latest !== null) {
    const context: ContentContext = {
      catalogue,
      markets,
      latest,
      changes: changes.changes,
      valstaraPrices: config.config.valstaraPrices.prices,
      pages,
    };
    for (const page of pages) {
      byPath.set(page.path, generatedRoute(page, context));
    }
    for (const serviceId of new Set(pages.map((page) => page.service_id))) {
      hubs.push(serviceHub(serviceId, pages, context));
    }
    for (const slug of new Set(pages.map((page) => page.market_slug))) {
      hubs.push(marketHub(slug, pages, context));
    }
  }
  for (const entry of ledger.urls) {
    if (
      !isRetirement(entry) &&
      !retired.has(entry.path) &&
      !byPath.has(entry.path)
    ) {
      byPath.set(
        entry.path,
        unavailableRoute(entry, catalogue, markets, hubSet),
      );
    }
  }
  const byPathOrder = <T extends { path: string }>(a: T, b: T) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  const routes = [...byPath.values()].sort(byPathOrder);
  const sitemap = routes.flatMap((route) =>
    route.kind === 'generated'
      ? [{ path: route.path, lastmod: route.lastmod }]
      : [],
  );
  hubs.sort(byPathOrder);
  const hubByPath = new Map(hubs.map((hub) => [hub.path, hub]));
  const index = priceIndex(pages, catalogue);
  const hubEntries = (kind: PriceHub['kind']) =>
    hubs
      .filter((hub) => hub.kind === kind)
      .map((hub) => ({ path: hub.path, lastmod: hub.lastmod }));
  // E11.6-13: the monthly reports, newest first, and `/price-index`.
  const names = reportNamer(catalogue, markets, ledger);
  const monthlyReports = monthlyReportFiles(inputs.monthly ?? {})
    .map((report) => monthlyReportPage(report, pages, hubSet, names))
    .reverse();
  const monthlyByPath = new Map(
    monthlyReports.map((report) => [report.path, report]),
  );
  return {
    priceIndex: priceIndexLanding(pages, markets, monthlyReports),
    monthlyReports,
    monthlyReport: (path) => monthlyByPath.get(path) ?? null,
    monthlySitemap: monthlyReports
      .map((report) => ({ path: report.path, lastmod: report.lastmod }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    routes,
    sitemap,
    route: (path) => byPath.get(path) ?? null,
    hubs,
    hub: (path) => hubByPath.get(path) ?? null,
    index,
    hubSitemaps: {
      index:
        index.lastmod === null
          ? []
          : [{ path: index.path, lastmod: index.lastmod }],
      services: hubEntries('service-hub'),
      markets: hubEntries('market-hub'),
    },
    redirect: (path) => retired.get(path) ?? null,
  };
}
