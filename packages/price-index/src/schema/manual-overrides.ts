import { z } from 'zod';

import { billingPeriods } from './catalogue.ts';
import { currencySchema, duplicates, slugSchema } from './common.ts';
import { iso4217Currencies, minorUnitExponent } from './iso4217.ts';
import { isDecimalAtExponent, recordIdentity } from './price-record.ts';

// data/price-index/manual-overrides.json (E11.6-06): the founder's hand-entered
// prices and `not_offered` confirmations. A price override fills any gap the
// scraper leaves, and a `not_offered` entry is the only way a plan becomes
// `not_offered` (epic rule 6). E11.6-08's `override` commands write it.

export const manualOverridesFile = 'data/price-index/manual-overrides.json';

export const manualEntryKinds = ['price', 'not_offered'] as const;

const actorSchema = z
  .string()
  .refine((value) => value.trim().length > 0 && value.trim() === value, {
    error: 'must be non-empty, with no leading or trailing whitespace',
  });

const entryFields = {
  market: z
    .string()
    .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' }),
  service_id: slugSchema,
  plan_id: slugSchema,
  billing_period: z.enum(billingPeriods),
  /** The official page the founder read: the price, or that there is none. */
  source_url: z.url({ protocol: /^https$/, error: 'must be an https URL' }),
  /** The day the founder checked it. A manual entry goes stale from here. */
  verified_at: z.iso.date(),
  /** Who checked it: the founder's approval of the entry. */
  verified_by: actorSchema,
  note: z.string().nullable(),
};

const priceOverrideObjectSchema = z.strictObject({
  kind: z.literal('price'),
  ...entryFields,
  /** At the currency's minor-unit exponent, above zero. */
  price_local: z.string(),
  currency: currencySchema,
  /** Optional: without it the record is published but never ranked. */
  price_usd_source: z.string().nullable(),
});

const notOfferedObjectSchema = z.strictObject({
  kind: z.literal('not_offered'),
  ...entryFields,
});

export const manualEntrySchema = z
  .discriminatedUnion('kind', [
    priceOverrideObjectSchema,
    notOfferedObjectSchema,
  ])
  .superRefine((entry, context) => {
    if (entry.kind !== 'price') {
      return;
    }
    if (
      iso4217Currencies.has(entry.currency) &&
      !isDecimalAtExponent(entry.price_local, entry.currency)
    ) {
      context.addIssue({
        code: 'custom',
        message: `must be a decimal at the minor-unit exponent of ${entry.currency} (${minorUnitExponent(entry.currency)} decimals)`,
        path: ['price_local'],
      });
    } else if (!/[1-9]/.test(entry.price_local)) {
      context.addIssue({
        code: 'custom',
        message: 'must be above zero',
        path: ['price_local'],
      });
    }
    if (
      entry.price_usd_source !== null &&
      (!isDecimalAtExponent(entry.price_usd_source, 'USD') ||
        !/[1-9]/.test(entry.price_usd_source))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be a decimal with two decimals, above zero',
        path: ['price_usd_source'],
      });
    }
  });

export const manualOverridesFileSchema = z
  .strictObject({ overrides: z.array(manualEntrySchema) })
  .superRefine((file, context) => {
    for (const identity of duplicates(file.overrides.map(recordIdentity))) {
      context.addIssue({
        code: 'custom',
        message: `more than one manual entry for ${identity}`,
        path: ['overrides'],
      });
    }
  });

export type ManualEntry = z.infer<typeof manualEntrySchema>;
export type PriceOverride = Extract<ManualEntry, { kind: 'price' }>;
export type NotOfferedEntry = Extract<ManualEntry, { kind: 'not_offered' }>;
export type ManualOverridesFile = z.infer<typeof manualOverridesFileSchema>;
