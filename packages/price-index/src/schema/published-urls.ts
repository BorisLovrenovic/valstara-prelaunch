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

export const publishedUrlsFile = 'data/price-index/published-urls.json';

const segment = slugPattern.source.slice(1, -1);

/** `/prices/{service}/{country}`: two lower-case kebab-case slugs. */
export const servicePagePathPattern = new RegExp(
  `^/prices/(${segment})/(${segment})$`,
  'u',
);

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

export const publishedUrlsFileSchema = z
  .strictObject({
    urls: z.array(publishedUrlSchema),
  })
  .superRefine((file, context) => {
    for (const path of duplicates(file.urls.map((entry) => entry.path))) {
      context.addIssue({
        code: 'custom',
        message: `duplicate URL ${path}`,
        path: ['urls'],
      });
    }
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

export type PublishedUrl = z.infer<typeof publishedUrlSchema>;
export type PublishedUrlsFile = z.infer<typeof publishedUrlsFileSchema>;
