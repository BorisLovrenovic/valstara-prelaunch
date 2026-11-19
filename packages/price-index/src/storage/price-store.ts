import type { LatestFile, SnapshotFile } from '../schema/price-index-files.ts';

// The PriceStore interface (E11.6-03, ADR-033). The pipeline reads and writes
// the price index only through it, so a different store plugs in later with
// no pipeline change. Its one implementation is JSON files in the repository
// (`json-file-store.ts`).

/** A snapshot, named by its build date and its order within that date. */
export interface SnapshotRef {
  /** The file name: `2026-12-01.json`, then `2026-12-01-2.json`, … */
  readonly name: string;
  /** The build date, `YYYY-MM-DD`. */
  readonly date: string;
  /** 1 for the date's first snapshot, 2 for its second, and so on. */
  readonly sequence: number;
}

export interface PriceStore {
  /** The current latest.json, or null before the first build wrote one. */
  readLatest(): Promise<LatestFile | null>;
  /** Replaces latest.json atomically. Invalid data is refused unwritten. */
  writeLatest(latest: LatestFile): Promise<void>;
  /**
   * Adds an immutable snapshot for `date` (`YYYY-MM-DD`). A date that already
   * has one gets the next numeric suffix; an existing snapshot is never
   * replaced.
   */
  writeSnapshot(snapshot: SnapshotFile, date: string): Promise<SnapshotRef>;
  /** Every snapshot, oldest first. */
  listSnapshots(): Promise<SnapshotRef[]>;
  /** One snapshot `listSnapshots` listed, validated (E11.6-09). */
  readSnapshot(ref: SnapshotRef): Promise<SnapshotFile>;
}

export const priceStoreErrorCodes = [
  /** Data that fails its schema, refused before anything is written. */
  'invalid_data',
  /** A stored file that is not JSON. */
  'not_json',
  /** A snapshot date that is not a real `YYYY-MM-DD` date. */
  'invalid_date',
  /** A date whose snapshot numbers are all taken. */
  'snapshots_exhausted',
] as const;

export type PriceStoreErrorCode = (typeof priceStoreErrorCodes)[number];

export class PriceStoreError extends Error {
  readonly code: PriceStoreErrorCode;

  constructor(code: PriceStoreErrorCode, message: string) {
    super(message);
    this.name = 'PriceStoreError';
    this.code = code;
  }
}
