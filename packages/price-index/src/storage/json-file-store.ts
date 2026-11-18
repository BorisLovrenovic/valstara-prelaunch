import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  latestFileSchema,
  snapshotFileSchema,
  type LatestFile,
  type SnapshotFile,
} from '../schema/price-index-files.ts';
import { writeFileAtomic, type AtomicWriteFs } from './atomic-write.ts';
import {
  PriceStoreError,
  type PriceStore,
  type SnapshotRef,
} from './price-store.ts';
import { serialisePriceIndexFile } from './serialise.ts';

// The JSON-file PriceStore (E11.6-03): `<directory>/latest.json` and
// `<directory>/snapshots/YYYY-MM-DD[-N].json`, normally `data/price-index/`.
// Every write is validated, deterministic and atomic; snapshots are created,
// never replaced.

export interface JsonFileStoreOptions {
  /** The data directory, normally `<repository>/data/price-index`. */
  directory: string;
  /** The write calls, injectable so a test can crash a write part-way. */
  fs?: AtomicWriteFs;
}

/** The most snapshots one date can take, so a fault cannot loop for ever. */
export const maxSnapshotsPerDate = 999;

// The first snapshot of a date has no suffix; later ones are numbered from 2.
const snapshotNamePattern =
  /^(\d{4}-\d{2}-\d{2})(?:-([2-9]|[1-9][0-9]+))?\.json$/;
const dateSchema = z.iso.date();

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function snapshotName(date: string, sequence: number): string {
  return sequence === 1 ? `${date}.json` : `${date}-${sequence}.json`;
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
    .join('; ');
}

function validated<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PriceStoreError(
      'invalid_data',
      `${what} is invalid: ${issuesText(result.error)}`,
    );
  }
  return result.data;
}

export function createJsonFileStore(options: JsonFileStoreOptions): PriceStore {
  const latestPath = join(options.directory, 'latest.json');
  const snapshotDirectory = join(options.directory, 'snapshots');

  async function listSnapshots(): Promise<SnapshotRef[]> {
    let names: string[];
    try {
      names = await readdir(snapshotDirectory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return names
      .flatMap((name) => {
        const match = snapshotNamePattern.exec(name);
        if (!match || !dateSchema.safeParse(match[1]).success) {
          return [];
        }
        const sequence =
          match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
        return [{ name, date: match[1], sequence }];
      })
      .sort((a, b) =>
        a.date === b.date ? a.sequence - b.sequence : a.date < b.date ? -1 : 1,
      );
  }

  return {
    async readLatest() {
      let text: string;
      try {
        text = await readFile(latestPath, 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return null;
        }
        throw error;
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new PriceStoreError('not_json', `${latestPath} is not JSON`);
      }
      return validated(latestFileSchema, data, latestPath);
    },

    async writeLatest(latest: LatestFile) {
      const content = serialisePriceIndexFile(
        validated(latestFileSchema, latest, 'latest.json'),
      );
      await mkdir(options.directory, { recursive: true });
      await writeFileAtomic(latestPath, content, {
        mode: 'replace',
        fs: options.fs,
      });
    },

    async writeSnapshot(snapshot: SnapshotFile, date: string) {
      if (!dateSchema.safeParse(date).success) {
        throw new PriceStoreError(
          'invalid_date',
          `${JSON.stringify(date)} is not a YYYY-MM-DD date`,
        );
      }
      const content = serialisePriceIndexFile(
        validated(snapshotFileSchema, snapshot, 'the snapshot'),
      );
      await mkdir(snapshotDirectory, { recursive: true });
      const taken = (await listSnapshots()).filter((ref) => ref.date === date);
      const first = Math.max(0, ...taken.map((ref) => ref.sequence)) + 1;
      for (
        let sequence = first;
        sequence <= maxSnapshotsPerDate;
        sequence += 1
      ) {
        const name = snapshotName(date, sequence);
        try {
          await writeFileAtomic(join(snapshotDirectory, name), content, {
            mode: 'create',
            fs: options.fs,
          });
          return { name, date, sequence };
        } catch (error) {
          // Another writer took this number first: never replace, try the next.
          if (errorCode(error) !== 'EEXIST') {
            throw error;
          }
        }
      }
      throw new PriceStoreError(
        'snapshots_exhausted',
        `${date} already has ${maxSnapshotsPerDate} snapshots`,
      );
    },

    listSnapshots,
  };
}
