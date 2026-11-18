import type { FetcherSettings } from '../../packages/price-index/src/schema/price-index-settings.ts';
import type { Clock } from '../../packages/price-index/src/http/clock.ts';

// Shared by the E11.6-04 fetcher suites. A module of exports only, so running
// it bare (node --test discovers every file under test/) does nothing.

export interface FakeClock extends Clock {
  /** Every wait, in milliseconds, in order. */
  readonly sleeps: number[];
  /** Moves the time forward without a wait, e.g. for a page that takes time. */
  advance(milliseconds: number): void;
}

/** A clock whose waits return at once and move its time forward. */
export function fakeClock(start = '2026-11-18T09:30:00.000Z'): FakeClock {
  let time = Date.parse(start);
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(time),
    advance(milliseconds) {
      time += milliseconds;
    },
    async sleep(milliseconds, signal) {
      signal?.throwIfAborted();
      sleeps.push(milliseconds);
      time += milliseconds;
      await Promise.resolve();
      signal?.throwIfAborted();
    },
  };
}

/** The committed defaults, with overrides. */
export function fetcherSettings(
  overrides: Partial<FetcherSettings> = {},
): FetcherSettings {
  return {
    source_origin: 'https://www.youfundceo.com',
    jitter_seconds: { min: 8, max: 20 },
    page_timeout_seconds: 60,
    checkpoint_wait_seconds: 30,
    backoff: {
      initial_seconds: 60,
      multiplier: 2,
      max_seconds: 900,
      retry_after_max_seconds: 3600,
    },
    max_consecutive_failures: 3,
    raw_runs_kept: 6,
    ...overrides,
  };
}
