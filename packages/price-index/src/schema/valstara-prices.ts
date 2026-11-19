import { z } from 'zod';

import { currencySchema, slugSchema } from './common.ts';

// config/valstara-prices.json
// (docs/features/price-index.md#valstara-prices-configvalstara-pricesjson).
// Entered by hand by the founder; never invented, estimated or derived.

/**
 * A positive exact decimal, as a string: `"9.99"`. Never a float. The
 * cross-file rules (`config.ts`) require it at its currency's exponent.
 */
const decimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export const valstaraPriceSchema = z.strictObject({
  service_id: slugSchema,
  plan_id: slugSchema,
  /** The market's ISO 3166-1 alpha-2 code, as in config/markets.json. */
  market: z
    .string()
    .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' }),
  /** The term the price buys, in months (e.g. 12). */
  term_months: z.int().min(1),
  price_local: z
    .string()
    .regex(decimalPattern, { error: 'must be an exact decimal string' })
    .refine((value) => /[1-9]/.test(value), {
      error: 'must be greater than zero',
    }),
  /** Must equal the market's currency. */
  currency: currencySchema,
});

export const valstaraPricesFileSchema = z.strictObject({
  prices: z.array(valstaraPriceSchema),
});

export type ValstaraPrice = z.infer<typeof valstaraPriceSchema>;
export type ValstaraPricesFile = z.infer<typeof valstaraPricesFileSchema>;
