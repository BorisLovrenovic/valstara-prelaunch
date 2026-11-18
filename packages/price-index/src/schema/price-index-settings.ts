import { z } from 'zod';

// `config/price-index.json`: the tool's own settings. E11.6-04 creates it with
// the fetcher's keys under `fetcher`; E11.6-06 adds the merge's under
// `merge`; later tickets add theirs beside them.

/** The one host the fetcher may request (E11.6-04, host allowlist). */
export const sourceOrigin = 'https://www.youfundceo.com';

const wholeSeconds = z.int().positive();

export const fetcherSettingsSchema = z
  .strictObject({
    // The host allowlist. Only the source's own origin is accepted, so a
    // config edit cannot point the fetcher anywhere else.
    source_origin: z.literal(sourceOrigin),
    // The randomised delay before every page, in whole seconds. The source's
    // `Crawl-delay` wins when it is longer than the drawn delay.
    jitter_seconds: z
      .strictObject({ min: wholeSeconds, max: wholeSeconds })
      .refine(({ min, max }) => min <= max, {
        error: 'min must not exceed max',
      }),
    // How long one page may take to load before it counts as a failure.
    page_timeout_seconds: wholeSeconds,
    // How long a page showing the bot checkpoint is given to complete it.
    checkpoint_wait_seconds: wholeSeconds,
    backoff: z
      .strictObject({
        // The wait after the first failure; each further consecutive failure
        // multiplies it by `multiplier`, up to `max_seconds`.
        initial_seconds: wholeSeconds,
        multiplier: z.int().min(1),
        max_seconds: wholeSeconds,
        // A `Retry-After` longer than this stops the run for the founder
        // instead of waiting.
        retry_after_max_seconds: wholeSeconds,
      })
      .refine(
        ({ initial_seconds, max_seconds }) => initial_seconds <= max_seconds,
        { error: 'initial_seconds must not exceed max_seconds' },
      ),
    // Consecutive failed page loads that stop the run.
    max_consecutive_failures: wholeSeconds,
    // Runs kept under data/raw/; older ones are deleted when a run starts.
    raw_runs_kept: wholeSeconds,
  })
  .refine(
    ({ backoff, jitter_seconds }) =>
      backoff.initial_seconds >= jitter_seconds.min,
    {
      error: 'backoff.initial_seconds must be at least jitter_seconds.min',
      path: ['backoff', 'initial_seconds'],
    },
  );

export type FetcherSettings = z.infer<typeof fetcherSettingsSchema>;

const wholeDays = z.int().positive();

// The merge's thresholds (E11.6-06, docs/features/price-index.md#validation-merge-and-the-publish-gate).
export const mergeSettingsSchema = z.strictObject({
  // A change of more than this many percent from the last published value
  // makes the record `needs_review`. Exactly this many percent passes.
  change_threshold_percent: z.int().min(1).max(1000),
  stale_after_days: z.strictObject({
    // A scraped `ok` record goes stale this long after its `observed_at`.
    scraped: wholeDays,
    // A manual override or `not_offered` entry goes stale this long after
    // its `verified_at`.
    manual: wholeDays,
  }),
});

export type MergeSettings = z.infer<typeof mergeSettingsSchema>;

export const priceIndexSettingsFileSchema = z.strictObject({
  fetcher: fetcherSettingsSchema,
  merge: mergeSettingsSchema,
});

export type PriceIndexSettingsFile = z.infer<
  typeof priceIndexSettingsFileSchema
>;

export const priceIndexSettingsFile = 'config/price-index.json';
