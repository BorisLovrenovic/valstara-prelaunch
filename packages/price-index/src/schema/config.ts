import { z } from 'zod';

import { duplicates } from './common.ts';
import { catalogueFileSchema } from './catalogue.ts';
import { marketsFileSchema } from './markets.ts';
import { valstaraPricesFileSchema } from './valstara-prices.ts';

// The three configuration files together, with the rules that span them.

export const configFiles = {
  markets: 'config/markets.json',
  catalogue: 'config/catalogue.json',
  valstaraPrices: 'config/valstara-prices.json',
} as const;

export type ConfigFileKey = keyof typeof configFiles;

export const configSetSchema = z
  .strictObject({
    markets: marketsFileSchema,
    catalogue: catalogueFileSchema,
    valstaraPrices: valstaraPricesFileSchema,
  })
  .superRefine((config, context) => {
    const markets = new Map(
      config.markets.markets.map((market) => [market.code, market]),
    );
    const services = new Map(
      config.catalogue.services.map((service) => [
        service.service_id,
        new Set(service.plans.map((plan) => plan.plan_id)),
      ]),
    );

    config.valstaraPrices.prices.forEach((price, index) => {
      const path = ['valstaraPrices', 'prices', index];
      const plans = services.get(price.service_id);
      if (!plans) {
        context.addIssue({
          code: 'custom',
          message: `Valstara price for unknown service ${price.service_id}`,
          path,
        });
      } else if (!plans.has(price.plan_id)) {
        context.addIssue({
          code: 'custom',
          message: `Valstara price for unknown plan ${price.plan_id} of service ${price.service_id}`,
          path,
        });
      }

      const market = markets.get(price.market);
      if (!market) {
        context.addIssue({
          code: 'custom',
          message: `Valstara price for unknown market ${price.market}`,
          path,
        });
      } else if (market.currency !== price.currency) {
        context.addIssue({
          code: 'custom',
          message: `Valstara price in ${price.currency}, but market ${price.market} uses ${market.currency}`,
          path,
        });
      }
    });

    for (const key of duplicates(
      config.valstaraPrices.prices.map(
        (price) =>
          `${price.service_id}/${price.plan_id}/${price.market}/${price.term_months}`,
      ),
    )) {
      context.addIssue({
        code: 'custom',
        message: `duplicate Valstara price for ${key} months`,
        path: ['valstaraPrices', 'prices'],
      });
    }
  });

export type ConfigSet = z.infer<typeof configSetSchema>;

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

/** Every rule violation in the three files, with the file it is in. */
export function configIssues(input: Record<ConfigFileKey, unknown>): {
  config?: ConfigSet;
  issues: ConfigIssue[];
} {
  const result = configSetSchema.safeParse(input);
  if (result.success) {
    return { config: result.data, issues: [] };
  }
  return {
    issues: result.error.issues.map((issue) => {
      const [key, ...rest] = issue.path;
      const file = configFiles[key as ConfigFileKey] ?? String(key);
      return {
        file,
        path: rest.map(String).join('.'),
        message: issue.message,
      };
    }),
  };
}
