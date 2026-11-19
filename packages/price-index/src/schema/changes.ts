import { z } from 'zod';

import { billingPeriods } from './catalogue.ts';
import { currencySchema, slugSchema } from './common.ts';
import { iso4217Currencies, minorUnitExponent } from './iso4217.ts';
import { isDecimalAtExponent, recordSourcePattern } from './price-record.ts';

// data/price-index/changes.json (E11.6-09): the log of real price changes.
// A real change is a published value replaced by a different published value
// for the same record and currency (docs/features/price-index.md#change-log-
// and-monthly-report). `build-data` appends to it; nothing else writes it.
// **Append-only** (epic rule 7): CI fails a change that edits, removes or
// reorders an entry (`scripts/ci/price-index-append-only.mjs`).
//
// Prices are exact decimal strings at the currency's exponent, as in a price
// record. There is no USD figure and no converted price.

export const changesFile = 'data/price-index/changes.json';

/**
 * A signed percentage with one decimal, rounded half away from zero:
 * `"15.5"` for a rise, `"-10.0"` for a fall. Text, never a float.
 */
export const changePercentPattern = /^-?(?:0|[1-9]\d*)\.\d$/u;

export const changeEntryObjectSchema = z.strictObject({
  market: z
    .string()
    .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' }),
  service_id: slugSchema,
  plan_id: slugSchema,
  billing_period: z.enum(billingPeriods),
  old_price_local: z.string(),
  new_price_local: z.string(),
  currency: currencySchema,
  change_percent: z.string().regex(changePercentPattern, {
    error: 'must be a signed percentage with one decimal, as text',
  }),
  /** The date of the observation that carried the new value. */
  detected_on: z.iso.date(),
  /** The new value's source: `scraper:<host>`, `manual` or `direct:<provider>`. */
  source: z.string().regex(recordSourcePattern, {
    error: 'must be scraper:youfundceo.com, manual or direct:<provider>',
  }),
});

/** Both prices at the currency's exponent, and different from each other. */
export function refineChangePrices(
  entry: Pick<ChangeEntry, 'old_price_local' | 'new_price_local' | 'currency'>,
  context: z.RefinementCtx,
): void {
  if (!iso4217Currencies.has(entry.currency)) {
    return;
  }
  for (const key of ['old_price_local', 'new_price_local'] as const) {
    if (!isDecimalAtExponent(entry[key], entry.currency)) {
      context.addIssue({
        code: 'custom',
        message: `must be written at the minor-unit exponent of ${entry.currency} (${minorUnitExponent(entry.currency)} decimals)`,
        path: [key],
      });
    }
  }
  if (entry.old_price_local === entry.new_price_local) {
    context.addIssue({
      code: 'custom',
      message: 'a change needs two different prices',
      path: ['new_price_local'],
    });
  }
}

export const changeEntrySchema =
  changeEntryObjectSchema.superRefine(refineChangePrices);

export const changesFileSchema = z.strictObject({
  changes: z.array(changeEntrySchema),
});

/** The keys of an entry, in the order the file writes them. */
export const changeEntryKeys = [
  'market',
  'service_id',
  'plan_id',
  'billing_period',
  'old_price_local',
  'new_price_local',
  'currency',
  'change_percent',
  'detected_on',
  'source',
] as const;

export type ChangeEntry = z.infer<typeof changeEntrySchema>;
export type ChangesFile = z.infer<typeof changesFileSchema>;
