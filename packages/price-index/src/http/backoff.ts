import type { FetcherSettings } from '../schema/price-index-settings.ts';

// Backoff (E11.6-04): exponential, from the configuration, and never shorter
// than the source's own `Retry-After`.

/**
 * The wait before retrying after `consecutiveFailures` failures in a row
 * (1 for the first): `initial × multiplier^(n − 1)`, capped at `max`.
 */
export function backoffMilliseconds(
  backoff: FetcherSettings['backoff'],
  consecutiveFailures: number,
): number {
  let seconds = backoff.initial_seconds;
  for (let step = 1; step < consecutiveFailures; step += 1) {
    seconds *= backoff.multiplier;
    if (seconds >= backoff.max_seconds) {
      return backoff.max_seconds * 1000;
    }
  }
  return Math.min(seconds, backoff.max_seconds) * 1000;
}

/**
 * A `Retry-After` header in milliseconds from `now`: either delta-seconds or
 * an HTTP date. A date in the past means no wait; an unreadable value is
 * ignored (null), so the configured backoff alone applies.
 */
export function retryAfterMilliseconds(
  value: string | null,
  now: Date,
): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d{1,9}$/u.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  if (
    !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      trimmed,
    )
  ) {
    return null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, at - now.getTime());
}
