import {
  hasNonDefaultFlagState,
  landingCacheVary,
  landingFlagGeneration,
} from '../cache/landing.ts';
import { campaignFlagRegistry } from '../flags/registry.ts';
import type { Flag } from '../flags/types.ts';

import { priceCacheControl, pricesPausedRetryAfterSeconds } from './route.ts';
import type {
  MonthlyReportPage,
  PriceIndexLanding,
  PriceSite,
} from './site.ts';

// What `/price-index` and `/price-index/{yyyy-mm}` answer (E11.6-13).
// `prices.pages` is read before any lookup, as on every price route: off,
// both answer 503 with `Retry-After` and `noindex`. `/price-index` always
// answers, since its methodology is true whatever the data holds. A month
// with no report file has no page, so its path answers the branded 404.
// Neither carries a signup form or a signed field, so, like the hubs, they
// do not go through the origin render cache; the edge caches them by the
// price pages' contract.

export type PriceIndexRouteResult =
  | { readonly kind: 'paused' }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'page';
      readonly view: PriceIndexLanding | MonthlyReportPage;
    };

function pagesEnabled(flags: readonly Flag[]): boolean {
  return (
    flags.find((flag) => flag.key === 'prices.pages')?.enabled ??
    campaignFlagRegistry['prices.pages']
  );
}

/**
 * The answer for `path`, setting its status-independent headers on
 * `headers`. The route returns a 404 for `not-found` and sets 503 for
 * `paused`.
 */
export function priceIndexRoute(
  site: () => PriceSite,
  path: string,
  url: URL,
  flags: readonly Flag[],
  headers: Headers,
): PriceIndexRouteResult {
  headers.set('Vary', landingCacheVary);
  headers.set('X-Valstara-Flag-Generation', landingFlagGeneration(flags));
  if (!pagesEnabled(flags)) {
    headers.set('Retry-After', String(pricesPausedRetryAfterSeconds));
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Robots-Tag', 'noindex');
    return { kind: 'paused' };
  }
  const view =
    path === site().priceIndex.path
      ? site().priceIndex
      : site().monthlyReport(path);
  if (view === null) {
    return { kind: 'not-found' };
  }
  headers.set(
    'Cache-Control',
    priceCacheControl(url, hasNonDefaultFlagState(flags)),
  );
  return { kind: 'page', view };
}
