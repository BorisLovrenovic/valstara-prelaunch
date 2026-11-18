import { z } from 'zod';

import { duplicates } from './common.ts';
import { priceRecordSchema, recordIdentity } from './price-record.ts';

// data/price-index/latest.json and data/price-index/snapshots/*.json
// (docs/features/price-index.md#files), E11.6-03. A snapshot is the
// latest.json of one build, kept unchanged, so both files share one shape.

const priceIndexFileSchema = z
  .strictObject({
    /** When the build that wrote the file ran: RFC 3339, UTC. */
    built_at: z.iso.datetime(),
    records: z.array(priceRecordSchema),
  })
  .superRefine((file, context) => {
    for (const identity of duplicates(file.records.map(recordIdentity))) {
      context.addIssue({
        code: 'custom',
        message: `duplicate record ${identity}`,
        path: ['records'],
      });
    }
  });

/** The merged current view the pages build from. */
export const latestFileSchema = priceIndexFileSchema;

/** One build's latest.json, immutable once written. */
export const snapshotFileSchema = priceIndexFileSchema;

/** The file's top-level keys, in the order every data file writes them. */
export const priceIndexFileKeys = ['built_at', 'records'] as const;

export type LatestFile = z.infer<typeof latestFileSchema>;
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
