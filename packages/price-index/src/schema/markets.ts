import { z } from 'zod';

import {
  currencySchema,
  displayNameSchema,
  duplicates,
  slugSchema,
} from './common.ts';

// config/markets.json (docs/features/price-index.md#markets-configmarketsjson).

export const marketSchema = z.strictObject({
  /** ISO 3166-1 alpha-2, upper case. */
  code: z
    .string()
    .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' }),
  name: displayNameSchema,
  /**
   * The name as it reads inside a sentence, where English needs an article:
   * "the United States" (E11.6-10). It must contain `name`. Without it, the
   * pages use `name` unchanged.
   */
  name_in_sentence: displayNameSchema.optional(),
  /** The permanent URL segment, e.g. `/prices/spotify/sweden`. */
  slug: slugSchema,
  /** The market's ISO 4217 currency. Every price in it must be in this. */
  currency: currencySchema,
  enabled: z.boolean(),
});

export const marketsFileSchema = z
  .strictObject({ markets: z.array(marketSchema) })
  .superRefine((file, context) => {
    file.markets.forEach((market, index) => {
      if (
        market.name_in_sentence !== undefined &&
        !market.name_in_sentence.includes(market.name)
      ) {
        context.addIssue({
          code: 'custom',
          message: `the name in a sentence must contain the name ${market.name}`,
          path: ['markets', index, 'name_in_sentence'],
        });
      }
    });
    for (const code of duplicates(file.markets.map((market) => market.code))) {
      context.addIssue({
        code: 'custom',
        message: `duplicate market code ${code}`,
        path: ['markets'],
      });
    }
    for (const slug of duplicates(file.markets.map((market) => market.slug))) {
      context.addIssue({
        code: 'custom',
        message: `duplicate market slug ${slug}`,
        path: ['markets'],
      });
    }
  });

export type Market = z.infer<typeof marketSchema>;
export type MarketsFile = z.infer<typeof marketsFileSchema>;
