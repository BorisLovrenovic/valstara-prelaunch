import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PriceSiteInputs } from './site.ts';

// The files the price pages build from, read from a checkout (E11.6-10; the
// price history and the Valstara prices, E11.6-11).
// The build scripts (the sitemap and the SEO check) and the tests read them
// here; the running site bundles the same files at build time
// (`./bundled.ts`), so both see exactly what the build saw.

export const priceSiteFiles = {
  latest: 'data/price-index/latest.json',
  catalogue: 'config/catalogue.json',
  markets: 'config/markets.json',
  ledger: 'data/price-index/published-urls.json',
  changes: 'data/price-index/changes.json',
  valstaraPrices: 'config/valstara-prices.json',
} as const;

async function readJson(root: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, file), 'utf8'));
}

/** The price site's inputs under `root`; latest.json may not exist yet. */
export async function readPriceSiteInputs(
  root: string,
): Promise<PriceSiteInputs> {
  let latest: unknown = null;
  try {
    latest = await readJson(root, priceSiteFiles.latest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    latest,
    catalogue: await readJson(root, priceSiteFiles.catalogue),
    markets: await readJson(root, priceSiteFiles.markets),
    ledger: await readJson(root, priceSiteFiles.ledger),
    changes: await readJson(root, priceSiteFiles.changes),
    valstaraPrices: await readJson(root, priceSiteFiles.valstaraPrices),
  };
}
