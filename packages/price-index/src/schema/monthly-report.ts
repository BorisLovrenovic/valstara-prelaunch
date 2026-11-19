import { z } from 'zod';

import { billingPeriods } from './catalogue.ts';
import { changeEntryObjectSchema, refineChangePrices } from './changes.ts';
import { currencySchema, slugSchema } from './common.ts';

// data/price-index/monthly/YYYY-MM.json (E11.6-09): the monthly report's
// figures, the feed `/price-index/{yyyy-mm}` renders from (E11.6-13). The
// Markdown beside it, reports/monthly/YYYY-MM.md, carries the same figures
// for outreach, plus the founder-only cross-check against the source's
// "Price moves", which this file never holds.
//
// Every figure comes from published values only: the change log and the
// publish gate's view of the month's last snapshot. Prices are local, as
// exact decimal strings. There is no USD figure, no converted price and no
// source credit.

export const monthlyDataDirectory = 'data/price-index/monthly';
export const monthlyReportDirectory = 'reports/monthly';

/** `2026-11`: a calendar month. */
export const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

const marketCode = z
  .string()
  .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' });
const count = z.int().nonnegative();

/** A market's published local price. */
const marketPriceSchema = z.strictObject({
  market: marketCode,
  price_local: z.string(),
  currency: currencySchema,
});

/** A change of the month, as the change log holds it, without its source. */
export const monthlyChangeSchema = changeEntryObjectSchema
  .omit({ source: true })
  .superRefine(refineChangePrices);

/** One plan's figures across the enabled markets. */
export const monthlyPlanSchema = z.strictObject({
  service_id: slugSchema,
  plan_id: slugSchema,
  billing_period: z.enum(billingPeriods),
  /** Enabled markets where the plan has a published price. */
  published_markets: count,
  /** Of those, the markets the ranking orders (those with a USD figure). */
  ranked_markets: count,
  /** Rank 1 of the ranking, in its local price; null under two ranked markets. */
  most_expensive: marketPriceSchema.nullable(),
  /** The last rank of the ranking, in its local price; null under two ranked markets. */
  least_expensive: marketPriceSchema.nullable(),
  /** The most expensive market's cost as a multiple of the cheapest's, one decimal, as text. */
  spread_ratio: z
    .string()
    .regex(/^(?:0|[1-9]\d*)\.\d$/u)
    .nullable(),
  /** Published markets whose price rose over the month. */
  rose_in: count,
  /** Published markets whose price fell over the month. */
  fell_in: count,
});

export const monthlyReportFileSchema = z.strictObject({
  month: z.string().regex(monthPattern, { error: 'must be YYYY-MM' }),
  /** The snapshot the figures are read from: the month's last build. */
  snapshot: z.string(),
  built_at: z.iso.datetime(),
  /** Enabled markets when the report was written. */
  markets: count,
  /** Every change that month, largest % first. */
  changes: z.array(monthlyChangeSchema),
  /** Every catalogue plan with a published price in the snapshot. */
  plans: z.array(monthlyPlanSchema),
});

/** The keys of the file, in the order it is written. */
export const monthlyReportKeys = Object.keys(
  monthlyReportFileSchema.shape,
) as (keyof MonthlyReportFile)[];

export type MonthlyChange = z.infer<typeof monthlyChangeSchema>;
export type MonthlyPlan = z.infer<typeof monthlyPlanSchema>;
export type MonthlyReportFile = z.infer<typeof monthlyReportFileSchema>;
