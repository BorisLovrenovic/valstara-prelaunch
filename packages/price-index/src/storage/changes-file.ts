import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  changeEntryKeys,
  changeEntrySchema,
  changesFileSchema,
  type ChangeEntry,
  type ChangesFile,
} from '../schema/changes.ts';
import { writeFileAtomic, type AtomicWriteFs } from './atomic-write.ts';
import { PriceStoreError } from './price-store.ts';

// data/price-index/changes.json (E11.6-09). Append-only (epic rule 7): the
// tool only ever adds entries at the end, and CI fails any other change.
// Entries keep their append order, which is the order the builds found them.

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
    .join('; ');
}

function pick<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as T;
}

/** The canonical bytes of changes.json: fixed key order, append order kept. */
export function serialiseChanges(file: ChangesFile): string {
  const canonical = {
    changes: file.changes.map((entry) => pick(entry, changeEntryKeys)),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** The change log at `path`, validated, or null when there is none. */
export async function readChanges(path: string): Promise<ChangesFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PriceStoreError('not_json', `${path} is not JSON`);
  }
  const result = changesFileSchema.safeParse(data);
  if (!result.success) {
    throw new PriceStoreError(
      'invalid_data',
      `${path} is invalid: ${issuesText(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Adds `entries` at the end of the change log at `path`, atomically, in the
 * order given. The entries and the existing file are validated first, and
 * nothing is written if either fails, or if there is nothing to add. The
 * file must already exist.
 */
export async function appendChanges(
  path: string,
  entries: readonly ChangeEntry[],
  options: { fs?: AtomicWriteFs } = {},
): Promise<ChangesFile> {
  const checked = z.array(changeEntrySchema).safeParse(entries);
  if (!checked.success) {
    throw new PriceStoreError(
      'invalid_data',
      `a change is invalid: ${issuesText(checked.error)}`,
    );
  }
  const current = await readChanges(path);
  if (current === null) {
    throw new PriceStoreError('invalid_data', `${path} does not exist`);
  }
  if (checked.data.length === 0) {
    return current;
  }
  const next: ChangesFile = { changes: [...current.changes, ...checked.data] };
  await writeFileAtomic(path, serialiseChanges(next), {
    mode: 'replace',
    fs: options.fs,
  });
  return next;
}
