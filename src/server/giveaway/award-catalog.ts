import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'astro/zod';

const productSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  name: z.string().min(1),
  retailValueEurCents: z.number().int().positive(),
  availableGlobally: z.boolean(),
  unavailableCountries: z.array(z.string().regex(/^[A-Z]{2}$/u)),
  replacementEligible: z.boolean(),
});

const catalogSchema = z.object({
  rulesVersion: z.string().regex(/^VAL-GW-[A-Z0-9]+-\d{8}-r[1-9]\d*$/u),
  approvedBy: z.string().min(1),
  bundleProductIds: z.array(productSchema.shape.id).min(1).max(100),
  products: z.array(productSchema).min(1).max(100),
});

export type AwardCatalog = z.infer<typeof catalogSchema>;
export type AwardProduct = z.infer<typeof productSchema>;

export function validateAwardCatalog(
  raw: unknown,
  rulesVersion: string,
  statedValueEurCents: number,
): AwardCatalog {
  const catalog = catalogSchema.parse(raw);
  if (catalog.rulesVersion !== rulesVersion) {
    throw new Error('The award catalog is not approved for these rules.');
  }
  const byId = new Map(
    catalog.products.map((product) => [product.id, product]),
  );
  if (
    byId.size !== catalog.products.length ||
    new Set(catalog.bundleProductIds).size !==
      catalog.bundleProductIds.length ||
    catalog.bundleProductIds.some((id) => !byId.has(id))
  ) {
    throw new Error('The award catalog has duplicate or unknown product IDs.');
  }
  const bundleValue = catalog.bundleProductIds.reduce(
    (sum, id) => sum + (byId.get(id)?.retailValueEurCents ?? 0),
    0,
  );
  if (bundleValue !== statedValueEurCents) {
    throw new Error(
      'The award catalog does not match the stated bundle value.',
    );
  }
  for (const product of catalog.products) {
    if (
      new Set(product.unavailableCountries).size !==
      product.unavailableCountries.length
    ) {
      throw new Error('The award catalog repeats a country for a product.');
    }
  }
  return catalog;
}

export async function loadAwardCatalog(
  rulesVersion: string,
  path = resolve(process.cwd(), 'src/content/giveaway-award-catalog.json'),
): Promise<AwardCatalog> {
  const source = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const rulesPath = resolve(
    process.cwd(),
    `src/content/giveaway-rules/${rulesVersion}.md`,
  );
  const rulesSource = await readFile(rulesPath, 'utf8');
  const statedValue = Number(
    rulesSource.match(
      /^prizeApproxRetailValueEur: ([1-9]\d*(?:\.\d{1,2})?)$/mu,
    )?.[1],
  );
  if (!Number.isFinite(statedValue)) {
    throw new Error('The award rules have no valid stated prize value.');
  }
  return validateAwardCatalog(
    source,
    rulesVersion,
    Math.round(statedValue * 100),
  );
}

export function availableProducts(
  catalog: AwardCatalog,
  country: string,
): {
  readonly original: readonly AwardProduct[];
  readonly unavailable: readonly AwardProduct[];
  readonly replacements: readonly AwardProduct[];
} {
  const byId = new Map(
    catalog.products.map((product) => [product.id, product]),
  );
  const bundle = catalog.bundleProductIds.map((id) => byId.get(id)!);
  const available = (product: AwardProduct) =>
    product.availableGlobally && !product.unavailableCountries.includes(country);
  return {
    original: bundle.filter(available),
    unavailable: bundle.filter((product) => !available(product)),
    replacements: catalog.products.filter(
      (product) =>
        product.replacementEligible &&
        available(product) &&
        !catalog.bundleProductIds.includes(product.id),
    ),
  };
}
