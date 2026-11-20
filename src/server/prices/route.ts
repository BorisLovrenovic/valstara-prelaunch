// The price routes' flag-off contract (E11.6-10): while `prices.pages` is
// off, every price route answers 503 with this `Retry-After` and `noindex`,
// so the pages leave search results without losing their index status.
// An hour: long enough not to invite a recrawl storm, short enough that a
// corrected price is picked up soon after the flag returns on.
export const pricesPausedRetryAfterSeconds = 3600;

/**
 * The price routes' cache contract (E11.6-10; the hubs since E11.6-12): a
 * ref-less render in the default flag state is cacheable for five minutes at
 * the edge, varying on the flag generation; `?ref=` and any non-default
 * flag state are private, as on `/`.
 */
export function priceCacheControl(
  url: URL,
  nonDefaultFlagState: boolean,
): string {
  return url.searchParams.has('ref') || nonDefaultFlagState
    ? 'private, no-store'
    : 'public, max-age=0, s-maxage=300';
}
