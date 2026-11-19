import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  publishedUrlKeys,
  publishedUrlSchema,
  publishedUrlsFileSchema,
  type PublishedUrl,
  type PublishedUrlsFile,
} from '../schema/published-urls.ts';
import { writeFileAtomic, type AtomicWriteFs } from './atomic-write.ts';
import { PriceStoreError } from './price-store.ts';

// data/price-index/published-urls.json (E11.6-10). Append-only (epic rule 7):
// the tool only ever adds entries at the end, and CI fails any other change.
// Entries keep their append order: each build adds its newly published URLs
// in path order.

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
    .join('; ');
}

function pick<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as T;
}

/** The canonical bytes of the ledger: fixed key order, append order kept. */
export function serialisePublishedUrls(file: PublishedUrlsFile): string {
  const canonical = {
    urls: file.urls.map((entry) => pick(entry, publishedUrlKeys)),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** The ledger at `path`, validated, or null when there is none. */
export async function readPublishedUrls(
  path: string,
): Promise<PublishedUrlsFile | null> {
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
  const result = publishedUrlsFileSchema.safeParse(data);
  if (!result.success) {
    throw new PriceStoreError(
      'invalid_data',
      `${path} is invalid: ${issuesText(result.error)}`,
    );
  }
  return result.data;
}

/**
 * The entries of `candidates` the ledger does not yet hold, by path, in path
 * order (code-unit order), so a rebuild appends nothing twice and the file's
 * order does not depend on the order pages were found in.
 */
export function newPublishedUrls(
  ledger: PublishedUrlsFile,
  candidates: readonly PublishedUrl[],
): PublishedUrl[] {
  const known = new Set(ledger.urls.map((entry) => entry.path));
  const fresh = new Map<string, PublishedUrl>();
  for (const candidate of candidates) {
    if (!known.has(candidate.path) && !fresh.has(candidate.path)) {
      fresh.set(candidate.path, candidate);
    }
  }
  return [...fresh.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/**
 * Adds `entries` at the end of the ledger at `path`, atomically, in the
 * order given. The entries and the existing file are validated first, and
 * nothing is written if either fails, if an entry's URL is already in the
 * ledger, or if there is nothing to add. The file must already exist.
 */
export async function appendPublishedUrls(
  path: string,
  entries: readonly PublishedUrl[],
  options: { fs?: AtomicWriteFs } = {},
): Promise<PublishedUrlsFile> {
  const checked = z.array(publishedUrlSchema).safeParse(entries);
  if (!checked.success) {
    throw new PriceStoreError(
      'invalid_data',
      `a published URL is invalid: ${issuesText(checked.error)}`,
    );
  }
  const current = await readPublishedUrls(path);
  if (current === null) {
    throw new PriceStoreError('invalid_data', `${path} does not exist`);
  }
  if (checked.data.length === 0) {
    return current;
  }
  const next = publishedUrlsFileSchema.safeParse({
    urls: [...current.urls, ...checked.data],
  });
  if (!next.success) {
    throw new PriceStoreError(
      'invalid_data',
      `the ledger would be invalid: ${issuesText(next.error)}`,
    );
  }
  await writeFileAtomic(path, serialisePublishedUrls(next.data), {
    mode: 'replace',
    fs: options.fs,
  });
  return next.data;
}
