import { z } from 'zod';

import { billingPeriods } from './catalogue.ts';
import { currencySchema, slugSchema } from './common.ts';
import { iso4217Currencies, minorUnitExponent } from './iso4217.ts';

// The price record (docs/features/price-index.md#the-price-record), E11.6-03.
// One record per market × service × plan × billing period. A price is an
// exact decimal string, never a number, and there is no currency conversion
// anywhere: the record has no `fx` field and no converted price, and the
// strict object rejects any key it does not name.

export const priceStatuses = [
  'ok',
  'missing',
  'not_offered',
  'needs_review',
  'manual_override',
  'stale',
  'conflict',
] as const;

export const missingReasons = [
  'source_no_price',
  'not_on_source',
  'parse_failed',
  'market_failed',
] as const;

/** Statuses that never carry a price. */
const pricelessStatuses: ReadonlySet<string> = new Set([
  'missing',
  'not_offered',
]);

/** Statuses that always carry a price. */
const pricedStatuses: ReadonlySet<string> = new Set(['ok', 'manual_override']);

/**
 * `true` when `value` is a non-negative decimal written at exactly the
 * currency's minor-unit exponent: `"149.00"` for SEK, `"1190"` for ISK,
 * `"1.250"` for KWD. No sign, no exponent notation, no leading zero, no
 * missing or extra fraction digit. False for a currency outside the table.
 */
export function isDecimalAtExponent(value: string, currency: string): boolean {
  if (!iso4217Currencies.has(currency)) {
    return false;
  }
  const exponent = minorUnitExponent(currency);
  const fraction = exponent === 0 ? '' : `\\.[0-9]{${exponent}}`;
  return new RegExp(`^(?:0|[1-9][0-9]*)${fraction}$`).test(value);
}

/** The source of a record (`scraper:youfundceo.com`, `manual`, `direct:<provider>`). */
export const recordSourcePattern =
  /^(?:scraper:youfundceo\.com|manual|direct:[a-z0-9]+(?:[.-][a-z0-9]+)*)$/;

const decimalTextSchema = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, {
  error: 'must be an exact decimal string',
});

export const priceRecordObjectSchema = z.strictObject({
  /** The market's ISO 3166-1 alpha-2 code, as in config/markets.json. */
  market: z
    .string()
    .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' }),
  service_id: slugSchema,
  plan_id: slugSchema,
  billing_period: z.enum(billingPeriods),
  /** The local price exactly as the source shows it, at the currency's exponent. */
  price_local: decimalTextSchema.nullable(),
  /** The price text exactly as displayed, kept for audit and never altered. */
  price_source_text: z.string().min(1).nullable(),
  /** As the source shows it; E11.6-06 flags one that is not the market's. */
  currency: currencySchema.nullable(),
  /** The source's approximate USD figure, for ranking only. Never displayed. */
  price_usd_source: decimalTextSchema.nullable(),
  source: z.string().regex(recordSourcePattern, {
    error: 'must be scraper:youfundceo.com, manual or direct:<provider>',
  }),
  source_url: z
    .url({ protocol: /^https$/, error: 'must be an https URL' })
    .nullable(),
  observed_at: z.iso.datetime().nullable(),
  /** The source's own "last checked" date. */
  source_verified_at: z.iso.date().nullable(),
  status: z.enum(priceStatuses),
  missing_reason: z.enum(missingReasons).nullable(),
  notes: z.string().nullable(),
});

/** The record's keys, in the order every data file writes them. */
export const priceRecordKeys = Object.keys(
  priceRecordObjectSchema.shape,
) as (keyof PriceRecord)[];

export const priceRecordSchema = priceRecordObjectSchema.superRefine(
  (record, context) => {
    const fail = (path: keyof PriceRecord, message: string) =>
      context.addIssue({ code: 'custom', message, path: [path] });

    if ((record.status === 'missing') !== (record.missing_reason !== null)) {
      fail(
        'missing_reason',
        'is set exactly when the status is missing, and only then',
      );
    }
    if ((record.price_local === null) !== (record.currency === null)) {
      fail('currency', 'is set exactly when price_local is set');
    }
    if (
      record.price_local !== null &&
      record.currency !== null &&
      iso4217Currencies.has(record.currency) &&
      !isDecimalAtExponent(record.price_local, record.currency)
    ) {
      fail(
        'price_local',
        `must be written at the minor-unit exponent of ${record.currency} (${minorUnitExponent(record.currency)} decimals)`,
      );
    }
    if (
      record.price_usd_source !== null &&
      !isDecimalAtExponent(record.price_usd_source, 'USD')
    ) {
      fail('price_usd_source', 'must be written with two decimals');
    }
    if (record.price_local === null) {
      if (record.price_usd_source !== null) {
        fail('price_usd_source', 'needs a price_local');
      }
      if (record.price_source_text !== null) {
        fail('price_source_text', 'needs a price_local');
      }
    }
    if (pricelessStatuses.has(record.status) && record.price_local !== null) {
      fail('price_local', `must be null when the status is ${record.status}`);
    }
    if (pricedStatuses.has(record.status) && record.price_local === null) {
      fail('price_local', `is required when the status is ${record.status}`);
    }
  },
);

export type PriceRecord = z.infer<typeof priceRecordObjectSchema>;
export type PriceStatus = (typeof priceStatuses)[number];
export type MissingReason = (typeof missingReasons)[number];

/** The identity of a record: market × service × plan × billing period. */
export function recordIdentity(
  record: Pick<
    PriceRecord,
    'market' | 'service_id' | 'plan_id' | 'billing_period'
  >,
): string {
  return [
    record.market,
    record.service_id,
    record.plan_id,
    record.billing_period,
  ].join('/');
}
