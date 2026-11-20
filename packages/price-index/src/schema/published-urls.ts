import { z } from 'zod';

import {
  displayNameSchema,
  duplicates,
  slugPattern,
  slugSchema,
} from './common.ts';

// data/price-index/published-urls.json (E11.6-10): the ledger of every price
// URL ever published. `build-data` appends the URL of every page that passes
// the generation rule (`generatedPages` in src/publish) the first time it
// does; nothing else writes it. **Append-only** (epic rule 7): CI fails a
// change that edits, removes or reorders an entry
// (`scripts/ci/price-index-append-only.mjs`).
//
// The site reads it at build time: a ledger URL whose data is lost renders
// "temporarily unavailable" with `noindex`, and never answers 404, so a URL a
// search engine has indexed does not churn (docs/features/price-index.md#edge-
// cases-and-error-states). Each entry keeps the service's and the market's
// display names as they were when it was first published, so the page can
// still name itself after its service or market has left the configuration
// (D2: such a URL stays "temporarily unavailable" until it is retired).
//
// A retirement (E11.6-12, D2 and D-032 Q2) is a second entry appended after
// a URL's publication entry, never an edit of it: `price-index retire-url
// <url> --to <hub> --actor` appends `{ kind: "retired", path, to, actor,
// retired_on }`. A retired URL answers 301 to its `to`, a service or market
// hub, and is in no sitemap. A path has one publication entry and at most
// one retirement entry after it.

export const publishedUrlsFile = 'data/price-index/published-urls.json';

const segment = slugPattern.source.slice(1, -1);

/** `/prices/{service}/{country}`: two lower-case kebab-case slugs. */
export const servicePagePathPattern = new RegExp(
  `^/prices/(${segment})/(${segment})$`,
  'u',
);

/** `/prices/{service}`: the service hub (E11.6-12). */
export const serviceHubPathPattern = new RegExp(`^/prices/(${segment})$`, 'u');

/** `/prices/countries/{country}`: the market hub (E11.6-12). */
export const marketHubPathPattern = new RegExp(
  `^/prices/countries/(${segment})$`,
  'u',
);

/**
 * A hub path a retired URL may redirect to: a service hub or a market hub.
 * `/prices/countries` itself is not a service hub, because `countries` is a
 * reserved service id.
 */
export function isHubPath(path: string): boolean {
  return (
    marketHubPathPattern.test(path) ||
    (serviceHubPathPattern.test(path) && path !== '/prices/countries')
  );
}

export const publishedUrlSchema = z
  .strictObject({
    /** The page's path on the site, as it was first published. */
    path: z.string().regex(servicePagePathPattern, {
      error: 'must be /prices/{service}/{country} with kebab-case slugs',
    }),
    service_id: slugSchema,
    /** The market's ISO 3166-1 alpha-2 code, as in config/markets.json. */
    market: z
      .string()
      .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' }),
    /** The service's catalogue name when the URL was first published. */
    service_name: displayNameSchema,
    /**
     * The market's name at that time, as it reads in a sentence
     * (`name_in_sentence` in config/markets.json, else `name`).
     */
    market_name: displayNameSchema,
    /** The date of the build that first published it (its `built_at`). */
    first_published_on: z.iso.date(),
  })
  .superRefine((entry, context) => {
    const service = servicePagePathPattern.exec(entry.path)?.[1];
    if (service !== undefined && service !== entry.service_id) {
      context.addIssue({
        code: 'custom',
        message: `must name the service ${entry.service_id} in its path`,
        path: ['path'],
      });
    }
  });

/** The retirement of a published URL (E11.6-12, D-032 Q2). */
export const retiredUrlSchema = z.strictObject({
  kind: z.literal('retired'),
  /** A URL already published in the ledger, by an earlier entry. */
  path: z.string().regex(servicePagePathPattern, {
    error: 'must be /prices/{service}/{country} with kebab-case slugs',
  }),
  /** The hub it answers 301 to: `/prices/{service}` or `/prices/countries/{country}`. */
  to: z.string().refine(isHubPath, {
    error: 'must be a hub: /prices/{service} or /prices/countries/{country}',
  }),
  /** The person who retired it. */
  actor: displayNameSchema,
  /** The day it was retired, from the injected clock. */
  retired_on: z.iso.date(),
});

/**
 * A ledger entry: a URL's publication, or its later retirement. An entry
 * with a `kind` is read as a retirement and any other as a publication, so
 * each reports its own schema's issues rather than a union's.
 */
export const ledgerEntrySchema = z.unknown().transform((value, context) => {
  const retirement =
    typeof value === 'object' && value !== null && 'kind' in value;
  const result = (retirement ? retiredUrlSchema : publishedUrlSchema).safeParse(
    value,
  );
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    }
    return z.NEVER;
  }
  return result.data as LedgerEntry;
});

export function isRetirement(entry: LedgerEntry): entry is RetiredUrl {
  return 'kind' in entry && entry.kind === 'retired';
}

export const publishedUrlsFileSchema = z
  .strictObject({
    urls: z.array(ledgerEntrySchema),
  })
  .superRefine((file, context) => {
    const publications = file.urls.filter((entry) => !isRetirement(entry));
    for (const path of duplicates(publications.map((entry) => entry.path))) {
      context.addIssue({
        code: 'custom',
        message: `duplicate URL ${path}`,
        path: ['urls'],
      });
    }
    const published = new Set<string>();
    const retired = new Set<string>();
    file.urls.forEach((entry, index) => {
      if (!isRetirement(entry)) {
        published.add(entry.path);
        return;
      }
      if (!published.has(entry.path)) {
        context.addIssue({
          code: 'custom',
          message: `${entry.path} is retired before it is published`,
          path: ['urls', index, 'path'],
        });
      }
      if (retired.has(entry.path)) {
        context.addIssue({
          code: 'custom',
          message: `${entry.path} is retired twice`,
          path: ['urls', index, 'path'],
        });
      }
      retired.add(entry.path);
    });
  });

/** The keys of an entry, in the order the file writes them. */
export const publishedUrlKeys = [
  'path',
  'service_id',
  'market',
  'service_name',
  'market_name',
  'first_published_on',
] as const;

/** The keys of a retirement entry, in the order the file writes them. */
export const retiredUrlKeys = [
  'kind',
  'path',
  'to',
  'actor',
  'retired_on',
] as const;

export type PublishedUrl = z.infer<typeof publishedUrlSchema>;
export type RetiredUrl = z.infer<typeof retiredUrlSchema>;
export type LedgerEntry = PublishedUrl | RetiredUrl;
export type PublishedUrlsFile = z.infer<typeof publishedUrlsFileSchema>;
