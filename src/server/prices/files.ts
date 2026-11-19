import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PriceSiteInputs } from './site.ts';

// The four files the price pages build from, read from a checkout (E11.6-10).
// The build scripts (the sitemap and the SEO check) and the tests read them
// here; the running site bundles the same files at build time
// (`./bundled.ts`), so both see exactly what the build saw.

export const priceSiteFiles = {
  latest: 'data/price-index/latest.json',
  catalogue: 'config/catalogue.json',
  markets: 'config/markets.json',
  ledger: 'data/price-index/published-urls.json',
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
  };
}
