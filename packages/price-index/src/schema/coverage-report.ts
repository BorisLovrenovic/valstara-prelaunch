import { z } from 'zod';

import { billingPeriods } from './catalogue.ts';
import { manualEntryKinds } from './manual-overrides.ts';
import {
  missingReasons,
  priceStatuses,
  recordSourcePattern,
} from './price-record.ts';
import { runIdPattern, runStatuses } from './run-files.ts';

// reports/coverage-YYYY-MM-DD.json (E11.6-08): the coverage report of one
// run against the founder's current data. `scrape` writes it as a preview,
// `build-data` as the final report of the build, and `report` on demand.
// The Markdown beside it is rendered from this same object, so the two
// always carry the same figures. It is for the founder only: no page reads
// it, and it carries no USD figure.

/** The coverage reports' directory, relative to the repository root. */
export const coverageReportDirectory = 'reports';

/** `coverage-2026-11-18.json` and `.md`. */
export const coverageReportNamePattern =
  /^coverage-\d{4}-\d{2}-\d{2}\.(?:json|md)$/u;

export const coverageReportKinds = ['preview', 'final'] as const;

const marketCode = z
  .string()
  .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' });
const count = z.int().nonnegative();
const text = z.string();
const status = z.enum(priceStatuses);
const missingReason = z.enum(missingReasons);
const billingPeriod = z.enum(billingPeriods);

const coverageFigure = z.strictObject({
  publishable: count,
  records: count,
  /** Publishable records as a share of all records, floored to one decimal. */
  percent: z.number().min(0).max(100),
});

const identity = {
  market: marketCode,
  service_id: text,
  plan_id: text,
  billing_period: billingPeriod,
};

const value = z.strictObject({ price_local: text, currency: text });

export const coverageReportFileSchema = z.strictObject({
  kind: z.enum(coverageReportKinds),
  run_id: z.string().regex(runIdPattern),
  source: z.string().regex(recordSourcePattern),
  fetch_status: z.enum(runStatuses),
  market_scope: marketCode.nullable(),
  /** The merge's time: `built_at` of the latest.json reported on. */
  built_at: z.iso.datetime(),
  /** The enabled markets, in config/markets.json's order: the matrix's columns. */
  markets: z.array(marketCode),
  coverage: z.strictObject({
    overall: coverageFigure,
    by_market: z.array(
      z.strictObject({ market: marketCode, ...coverageFigure.shape }),
    ),
    by_service: z.array(
      z.strictObject({ service_id: text, ...coverageFigure.shape }),
    ),
  }),
  /** One row per catalogue plan, one cell per enabled market. */
  matrix: z.array(
    z.strictObject({
      service_id: text,
      plan_id: text,
      billing_period: billingPeriod,
      cells: z.array(
        z.strictObject({
          market: marketCode,
          status,
          missing_reason: missingReason.nullable(),
        }),
      ),
    }),
  ),
  /** `missing` combinations, one group per service and reason, `not_on_source` first. */
  missing: z.array(
    z.strictObject({
      reason: missingReason,
      service_id: text,
      service_name: text,
      website_url: text,
      combinations: z.array(
        z.strictObject({
          market: marketCode,
          currency: text,
          plan_id: text,
          billing_period: billingPeriod,
        }),
      ),
    }),
  ),
  /** Every `needs_review`, `conflict` and `stale` record. */
  flagged: z.array(
    z.strictObject({
      ...identity,
      status: z.enum(['needs_review', 'conflict', 'stale']),
      /** The value the record shows, or null when it shows none. */
      shown: value.extend({ source: text }).nullable(),
      /** The founder's manual entry for the record, when there is one. */
      manual: z
        .strictObject({
          kind: z.enum(manualEntryKinds),
          price_local: text.nullable(),
          currency: text.nullable(),
          verified_at: z.iso.date(),
          source_url: text,
        })
        .nullable(),
      notes: text.nullable(),
    }),
  ),
  /** Price overrides the scraper now agrees with, which may be retired. */
  retirable_overrides: z.array(z.strictObject({ ...identity, ...value.shape })),
  /** Publishable records without a USD figure: published, never ranked. */
  unranked: z.array(
    z.strictObject({ ...identity, ...value.shape, source: text }),
  ),
  /** Source services and plan rows no alias matches, with a suggestion never applied. */
  untracked: z.array(
    z.strictObject({
      kind: z.enum(['service', 'plan']),
      service_id: text.nullable(),
      source_service: text,
      source_plan: text.nullable(),
      source_name: text,
      billing_period: billingPeriod.nullable(),
      markets: z.array(marketCode),
      suggestion: text.nullable(),
    }),
  ),
  /** `ok` records for the founder to check by hand, sampled from the run id. */
  spot_checks: z.strictObject({
    requested: z.int().positive(),
    /** The seed the sample was drawn with, derived from `run_id`. */
    seed: count,
    records: z.array(
      z.strictObject({
        ...identity,
        ...value.shape,
        price_source_text: text.nullable(),
        source_url: text.nullable(),
        official_url: text,
      }),
    ),
  }),
});

export type CoverageReportFile = z.infer<typeof coverageReportFileSchema>;
export type CoverageReportKind = (typeof coverageReportKinds)[number];

/** The report's keys, in the order the file is written. */
export const coverageReportKeys = Object.keys(
  coverageReportFileSchema.shape,
) as (keyof CoverageReportFile)[];
