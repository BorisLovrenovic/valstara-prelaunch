import catalogue from '../../../config/catalogue.json';
import markets from '../../../config/markets.json';
import valstaraPrices from '../../../config/valstara-prices.json';
import changes from '../../../data/price-index/changes.json';
import ledger from '../../../data/price-index/published-urls.json';

import { createPriceSite, type PriceSite } from './site.ts';

// The price data bundled into the server at build time (E11.6-10, D1). The
// pages render from these copies only: the running site never reads the
// repository's files, so nothing the price-index tool writes can reach it
// before the next build (epic rule 1). latest.json does not exist before the
// first `build-data`, so it is globbed, and no price page is generated.
const latestModules = import.meta.glob<unknown>(
  '/data/price-index/latest.json',
  { eager: true, import: 'default' },
);

let site: PriceSite | undefined;

/** The build's price site, validated once per process. */
export function bundledPriceSite(): PriceSite {
  site ??= createPriceSite({
    latest: Object.values(latestModules)[0] ?? null,
    catalogue,
    markets,
    ledger,
    changes,
    valstaraPrices,
  });
  return site;
}
