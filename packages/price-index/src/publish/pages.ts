import type { CatalogueFile } from '../schema/catalogue.ts';
import type { MarketsFile } from '../schema/markets.ts';
import type { LatestFile } from '../schema/price-index-files.ts';
import type {
  PublishedUrl,
  PublishedUrlsFile,
} from '../schema/published-urls.ts';
import { publishedView, type PublishedRecord } from './gate.ts';

// The generation rule (E11.6-10, docs/features/price-index.md#pages). A
// service × market page exists only when at least one of its plans passes
// the publish gate. The site renders exactly these pages and lists them in
// its sitemap, and `build-data` appends each one's URL to the published-URL
// ledger, so both read this one function.

export interface GeneratedPage {
  /** `/prices/{service}/{country}`, from the catalogue and markets config. */
  readonly path: string;
  readonly service_id: string;
  /** The market's code. */
  readonly market: string;
  /** The service's catalogue name. */
  readonly service_name: string;
  /** The market's name in config/markets.json. */
  readonly market_name: string;
  /** The market's name as it reads in a sentence ("the United States"). */
  readonly market_name_in_sentence: string;
  /**
   * The page's publishable records, one per catalogue plan that has one, in
   * the catalogue's plan order.
   */
  readonly records: readonly PublishedRecord[];
}

/** The permanent URL path of a service × market page. */
export function servicePagePath(serviceId: string, marketSlug: string): string {
  return `/prices/${serviceId}/${marketSlug}`;
}

function planKey(
  serviceId: string,
  market: string,
  planId: string,
  billingPeriod: string,
): string {
  return [serviceId, market, planId, billingPeriod].join('/');
}

/**
 * Every service × market page the data generates: each catalogue service in
 * each enabled market with at least one publishable record for one of the
 * service's catalogue plans. Pages come in catalogue order, then markets
 * order. No latest.json (`null`) generates nothing. A record for a plan,
 * service or market the configuration no longer has is not shown, because
 * the page could not name it. An invalid latest.json throws
 * `PublishGateError`, as `publishedView` does.
 */
export function generatedPages(
  latest: LatestFile | null,
  catalogue: CatalogueFile,
  markets: MarketsFile,
): GeneratedPage[] {
  if (latest === null) {
    return [];
  }
  const byKey = new Map<string, PublishedRecord>();
  for (const record of publishedView(latest).records) {
    byKey.set(
      planKey(
        record.service_id,
        record.market,
        record.plan_id,
        record.billing_period,
      ),
      record,
    );
  }
  const pages: GeneratedPage[] = [];
  for (const service of catalogue.services) {
    for (const market of markets.markets) {
      if (!market.enabled) {
        continue;
      }
      const records = service.plans.flatMap((plan) => {
        const record = byKey.get(
          planKey(
            service.service_id,
            market.code,
            plan.plan_id,
            plan.billing_period,
          ),
        );
        return record === undefined ? [] : [record];
      });
      if (records.length > 0) {
        pages.push({
          path: servicePagePath(service.service_id, market.slug),
          service_id: service.service_id,
          market: market.code,
          service_name: service.name,
          market_name: market.name,
          market_name_in_sentence: market.name_in_sentence ?? market.name,
          records,
        });
      }
    }
  }
  return pages;
}

/**
 * The ledger entries for `pages`, first published by the build of
 * `builtOn` (`YYYY-MM-DD`). `newPublishedUrls` in src/storage keeps only the
 * ones the ledger does not hold yet.
 */
export function publishedUrlsFor(
  pages: readonly GeneratedPage[],
  builtOn: string,
): PublishedUrl[] {
  return pages.map((page) => ({
    path: page.path,
    service_id: page.service_id,
    market: page.market,
    service_name: page.service_name,
    market_name: page.market_name_in_sentence,
    first_published_on: builtOn,
  }));
}

/**
 * Ledger entries whose URL the configuration would now give a different
 * path: the service and the market are both still configured, but a slug has
 * changed. A published slug never changes (docs/features/price-index.md
 * #pages), so `price-index validate` reports each one. An entry whose service
 * or market has left the configuration is not a conflict: its URL stays
 * "temporarily unavailable" until it is retired (D2).
 */
export function ledgerPathConflicts(
  ledger: PublishedUrlsFile,
  catalogue: CatalogueFile,
  markets: MarketsFile,
): { entry: PublishedUrl; expected: string }[] {
  const services = new Set(
    catalogue.services.map((service) => service.service_id),
  );
  const conflicts: { entry: PublishedUrl; expected: string }[] = [];
  for (const entry of ledger.urls) {
    const market = markets.markets.find((item) => item.code === entry.market);
    if (market === undefined || !services.has(entry.service_id)) {
      continue;
    }
    const expected = servicePagePath(entry.service_id, market.slug);
    if (expected !== entry.path) {
      conflicts.push({ entry, expected });
    }
  }
  return conflicts;
}
