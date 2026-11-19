// The price routes' flag-off contract (E11.6-10): while `prices.pages` is
// off, every price route answers 503 with this `Retry-After` and `noindex`,
// so the pages leave search results without losing their index status.
// An hour: long enough not to invite a recrawl storm, short enough that a
// corrected price is picked up soon after the flag returns on.
export const pricesPausedRetryAfterSeconds = 3600;
