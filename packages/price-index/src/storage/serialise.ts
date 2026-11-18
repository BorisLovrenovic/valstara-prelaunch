import {
  priceIndexFileKeys,
  type LatestFile,
} from '../schema/price-index-files.ts';
import { priceRecordKeys, type PriceRecord } from '../schema/price-record.ts';

// Deterministic data files (epic rule 8, E11.6-03): keys in a fixed order,
// records in identity order, two-space indentation and a trailing newline.
// The same data always serialises to the same bytes, whatever order it was
// built in, so a diff shows only real changes and the file passes Prettier.

const identityKeys = [
  'service_id',
  'plan_id',
  'billing_period',
  'market',
] as const satisfies readonly (keyof PriceRecord)[];

/** Records in identity order: service, plan, billing period, then market. */
export function compareRecords(a: PriceRecord, b: PriceRecord): number {
  for (const key of identityKeys) {
    if (a[key] !== b[key]) {
      // Code-unit order, never locale order, so every machine agrees.
      return a[key] < b[key] ? -1 : 1;
    }
  }
  return 0;
}

function pick<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as T;
}

/** The canonical bytes of a latest.json or snapshot file. */
export function serialisePriceIndexFile(file: LatestFile): string {
  const canonical = pick(
    {
      ...file,
      records: [...file.records]
        .sort(compareRecords)
        .map((record) => pick(record, priceRecordKeys)),
    },
    priceIndexFileKeys,
  );
  return `${JSON.stringify(canonical, null, 2)}\n`;
}
