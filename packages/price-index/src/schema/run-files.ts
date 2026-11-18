import { z } from 'zod';

import { billingPeriods } from './catalogue.ts';
import {
  missingReasons,
  priceRecordObjectSchema,
  priceStatuses,
  recordSourcePattern,
} from './price-record.ts';

// The files one scrape run leaves behind (E11.6-07):
//
//   data/raw/<run_id>/observations.json   what the run read from the source,
//                                         normalised; gitignored with the
//                                         rest of the raw store
//   reports/runs/<run_id>.json            the run log a build writes; committed
//
// `scrape` writes the first and never touches data/price-index/. `build-data`
// merges it and writes the second beside latest.json and a snapshot.

/** `20261118T093000Z`, with `-2`, `-3`, … for a second run in that second. */
export const runIdPattern = /^\d{8}T\d{6}Z(?:-\d{1,3})?$/u;

/** How a fetch run ended (E11.6-04's report status). */
export const runStatuses = [
  'completed',
  'stopped_by_source',
  'interrupted',
] as const;

export type RunStatus = (typeof runStatuses)[number];

/** The run logs' directory, relative to the repository root. */
export const runLogDirectory = 'reports/runs';

const marketCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' });

const count = z.int().nonnegative();

/** A price the source shows for a tracked plan: `SourceAdapter.parse`'s shape. */
export const observationSchema = priceRecordObjectSchema
  .pick({
    market: true,
    service_id: true,
    plan_id: true,
    billing_period: true,
    price_source_text: true,
    price_usd_source: true,
    source_url: true,
    source_verified_at: true,
  })
  .extend({
    price_local: z.string(),
    currency: z.string(),
    source: priceRecordObjectSchema.shape.source,
    observed_at: z.iso.datetime(),
  });

/** A tracked plan the run has no price for, and why. */
export const sourceGapSchema = priceRecordObjectSchema
  .pick({
    market: true,
    service_id: true,
    plan_id: true,
    billing_period: true,
    source_url: true,
  })
  .extend({ reason: z.enum(missingReasons), note: z.string().nullable() });

const untrackedEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('service'),
    source_service: z.string(),
    source_name: z.string(),
    suggestion: z.strictObject({ service_id: z.string() }).nullable(),
  }),
  z.strictObject({
    kind: z.literal('plan'),
    service_id: z.string(),
    source_service: z.string(),
    source_plan: z.string(),
    source_name: z.string(),
    billing_period: z.enum(billingPeriods),
    markets: z.array(marketCodeSchema),
    suggestion: z.strictObject({ plan_id: z.string() }).nullable(),
  }),
]);

const priceMoveSchema = z.strictObject({
  source_service: z.string(),
  source_plan: z.string(),
  service_id: z.string().nullable(),
  plan_id: z.string().nullable(),
  market: z.string(),
  period: z.string(),
  currency: z.string(),
  old_price: z.string(),
  new_price: z.string(),
  date: z.string(),
  after_date: z.string().nullable(),
  evidence_url: z.string(),
  source_flag: z.boolean(),
  old_usd: z.string().nullable(),
  new_usd: z.string().nullable(),
});

export const pageFailureSchema = z.strictObject({
  url: z.string(),
  market: marketCodeSchema.nullable(),
  reason: z.enum(['parse_failed', 'market_failed']),
  detail: z.string(),
});

/** `data/raw/<run_id>/observations.json`. */
export const runObservationsFileSchema = z.strictObject({
  run_id: z.string().regex(runIdPattern),
  /** The `source` of every observation, e.g. `scraper:youfundceo.com`. */
  source: z.string().regex(recordSourcePattern),
  /** When the run started reading the source: every observation's `observed_at`. */
  observed_at: z.iso.datetime(),
  /** How the fetch ended. A stopped or interrupted run is partial. */
  fetch_status: z.enum(runStatuses),
  /** The one market of `scrape --market`, or null for every enabled market. */
  market_scope: marketCodeSchema.nullable(),
  /** Source pages the run holds as loaded, robots.txt not counted. */
  pages_fetched: count,
  observations: z.array(observationSchema),
  gaps: z.array(sourceGapSchema),
  untracked: z.array(untrackedEntrySchema),
  /** The source's own "Price moves", for E11.6-09's cross-check; null if unread. */
  price_moves: z.array(priceMoveSchema).nullable(),
  failures: z.array(pageFailureSchema),
});

export type RunObservationsFile = z.infer<typeof runObservationsFileSchema>;

const snapshotNameSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:-(?:[2-9]|[1-9][0-9]+))?\.json$/u, {
    error: 'must be a snapshot file name',
  });

/** Records of the built latest.json, by status. Every status is present. */
const recordsByStatusSchema = z.strictObject(
  Object.fromEntries(priceStatuses.map((status) => [status, count])) as Record<
    (typeof priceStatuses)[number],
    typeof count
  >,
);

/** `reports/runs/<run_id>.json`: one build of one run (E11.6-07). */
export const runLogFileSchema = z.strictObject({
  run_id: z.string().regex(runIdPattern),
  source: z.string().regex(recordSourcePattern),
  fetch_status: z.enum(runStatuses),
  market_scope: marketCodeSchema.nullable(),
  observed_at: z.iso.datetime(),
  built_at: z.iso.datetime(),
  /** The snapshot the build wrote, under data/price-index/snapshots/. */
  snapshot: snapshotNameSchema,
  /** Publishable records as a share of all records, floored to one decimal. */
  coverage_percent: z.number().min(0).max(100),
  counts: z.strictObject({
    /** Source pages the run loaded. */
    fetched: count,
    /** Observations: a tracked plan priced and matched through its aliases. */
    matched: count,
    /** Source services and plan rows that match nothing: "untracked on source". */
    unmatched: count,
    records_by_status: recordsByStatusSchema,
    /** Markets with at least one record whose page failed. */
    failed_markets: count,
    /** Real price changes. Zero until E11.6-09 adds detection. */
    changed: count,
  }),
  failed_markets: z.array(
    z.strictObject({ market: marketCodeSchema, failed_records: count }),
  ),
  failures: z.array(pageFailureSchema),
});

export type RunLogFile = z.infer<typeof runLogFileSchema>;

/** The run log's keys, in the order the file is written. */
export const runLogKeys = Object.keys(
  runLogFileSchema.shape,
) as (keyof RunLogFile)[];
