import {
  hasNonDefaultFlagState,
  landingCacheVary,
  landingFlagGeneration,
} from '../cache/landing.ts';
import { campaignFlagRegistry } from '../flags/registry.ts';
import type { Flag } from '../flags/types.ts';

import { priceCacheControl, pricesPausedRetryAfterSeconds } from './route.ts';
import type { PriceHub, PriceIndex, PriceSite } from './site.ts';

// What a hub route answers (E11.6-12): `/prices`, `/prices/{service}` and
// `/prices/countries/{country}`. `prices.pages` is read before any lookup,
// as on the service × market page: off, every hub answers 503 with
// `Retry-After` and `noindex`. A service or market with no live page has no
// hub, so its path answers the branded 404. `/prices` always answers, so
// the footer's link always reaches a page; with no live page it is empty
// and `noindex`. The hubs carry no signup form and no signed field, so they
// do not go through the origin render cache; the edge caches them by the
// same contract as the price pages.

export type HubRouteResult =
  | { readonly kind: 'paused' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'hub'; readonly view: PriceHub | PriceIndex };

function enabled(
  flags: readonly Flag[],
  key: keyof typeof campaignFlagRegistry,
) {
  return (
    flags.find((flag) => flag.key === key)?.enabled ?? campaignFlagRegistry[key]
  );
}

/**
 * The answer for the hub at `path`, setting its status-independent headers
 * on `headers`. The route returns a 404 for `not-found` and sets 503 for
 * `paused`.
 */
export function hubRoute(
  site: () => PriceSite,
  path: string,
  url: URL,
  flags: readonly Flag[],
  headers: Headers,
): HubRouteResult {
  headers.set('Vary', landingCacheVary);
  headers.set('X-Valstara-Flag-Generation', landingFlagGeneration(flags));
  if (!enabled(flags, 'prices.pages')) {
    headers.set('Retry-After', String(pricesPausedRetryAfterSeconds));
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Robots-Tag', 'noindex');
    return { kind: 'paused' };
  }
  const view = path === '/prices' ? site().index : site().hub(path);
  if (view === null) {
    return { kind: 'not-found' };
  }
  headers.set(
    'Cache-Control',
    priceCacheControl(url, hasNonDefaultFlagState(flags)),
  );
  if (view.kind === 'index' && view.empty !== null) {
    headers.set('X-Robots-Tag', 'noindex');
  }
  return { kind: 'hub', view };
}
