import {
  rankMarkets,
  type PublishedRecord,
} from '../../../packages/price-index/src/publish/gate.ts';
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
  latestFileSchema,
  type LatestFile,
} from '../../../packages/price-index/src/schema/price-index-files.ts';
import {
  publishedUrlsFileSchema,
  type PublishedUrlsFile,
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
      // list price": not shown, as a price not below list is not (D-034 Q1).
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

  const byPath = new Map<string, PriceRoute>();
  const pages = generatedPages(latest, catalogue, markets);
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
