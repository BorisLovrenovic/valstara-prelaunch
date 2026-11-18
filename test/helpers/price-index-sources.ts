import { readFileSync } from 'node:fs';

import type { CatalogueFile } from '../../packages/price-index/src/schema/catalogue.ts';
import type { MarketsFile } from '../../packages/price-index/src/schema/markets.ts';
import type {
  RawPage,
  SourceContext,
} from '../../packages/price-index/src/sources/source-adapter.ts';

// Shared by the E11.6-05 source tests: the founder-captured pages as a run's
// raw pages, and the committed configuration. Nothing here requests the
// source (epic rule 2). This file has no tests of its own.

export const origin = 'https://www.youfundceo.com';
export const fixtureDirectory =
  'packages/price-index/test/fixtures/youfundceo/pages';
export const observedAt = '2026-11-18T10:00:00Z';

/** A captured page's HTML. `copy: 'server'` reads the copy as the server sent it. */
export function fixtureHtml(
  name: string,
  copy: 'rendered' | 'server' = 'rendered',
): string {
  const suffix = copy === 'server' ? '.server.html' : '.html';
  return readFileSync(`${fixtureDirectory}/${name}${suffix}`, 'utf8');
}

/** The fixture file name of a source path: `/services/netflix/sweden` → `services__netflix__sweden`. */
export function fixtureName(path: string): string {
  return path.slice(1).replaceAll('/', '__');
}

export function okPage(path: string, html: string): [string, RawPage] {
  const url = `${origin}${path}`;
  return [url, { url, outcome: 'ok', html }];
}

/** Raw pages for the given source paths, each read from its fixture. */
export function capturedPages(
  paths: readonly string[],
  copy: 'rendered' | 'server' = 'rendered',
): Map<string, RawPage> {
  return new Map(
    paths.map((path) => okPage(path, fixtureHtml(fixtureName(path), copy))),
  );
}

export const indexPaths = ['/countries', '/services', '/price-moves'];

/** The twelve captured country × service pages. */
export const capturedServicePairs = [
  'adobe',
  'apple-music',
  'chatgpt',
  'netflix',
  'spotify',
  'youtube-premium',
].flatMap((service) =>
  ['sweden', 'united-states'].map(
    (country) => `/services/${service}/${country}`,
  ),
);

export function committedCatalogue(): CatalogueFile {
  return JSON.parse(
    readFileSync('config/catalogue.json', 'utf8'),
  ) as CatalogueFile;
}

export function committedMarkets(): MarketsFile {
  return JSON.parse(readFileSync('config/markets.json', 'utf8')) as MarketsFile;
}

/** The committed configuration with only the given market codes enabled. */
export function contextWithMarkets(
  codes: readonly string[] | 'all',
  catalogue: CatalogueFile = committedCatalogue(),
): SourceContext {
  const markets = committedMarkets();
  return {
    catalogue,
    markets: {
      markets: markets.markets.map((market) => ({
        ...market,
        enabled: codes === 'all' || codes.includes(market.code),
      })),
    },
  };
}

/** A deep copy whose every object and array is frozen. */
export function deepFrozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (typeof node === 'object' && node !== null) {
      for (const child of Object.values(node)) {
        freeze(child);
      }
      Object.freeze(node);
    }
  };
  freeze(copy);
  return copy;
}
