import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  approvalEntryKeys,
  approvalEntrySchema,
  approvalsFileSchema,
  type ApprovalEntry,
  type ApprovalsFile,
} from '../schema/approvals.ts';
import { writeFileAtomic, type AtomicWriteFs } from './atomic-write.ts';
import { PriceStoreError } from './price-store.ts';

// data/price-index/approvals.json (E11.6-06). Append-only (epic rule 7): the
// tool only ever adds an entry at the end, and CI fails any other change.
// Entries keep their append order, which is the order decisions were made
// in, so "the last decision for a value counts" reads straight off the file.

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
    .join('; ');
}

function pick<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as T;
}

/** The canonical bytes of approvals.json: fixed key order, append order kept. */
export function serialiseApprovals(file: ApprovalsFile): string {
  const canonical = {
    approvals: file.approvals.map((entry) => pick(entry, approvalEntryKeys)),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** The approvals file at `path`, validated, or null when there is none. */
export async function readApprovals(
  path: string,
): Promise<ApprovalsFile | null> {
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
  const result = approvalsFileSchema.safeParse(data);
  if (!result.success) {
    throw new PriceStoreError(
      'invalid_data',
      `${path} is invalid: ${issuesText(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Adds `entry` at the end of the approvals file at `path`, atomically. The
 * entry and the existing file are both validated first, and nothing is
 * written if either fails. The file must already exist.
 */
export async function appendApproval(
  path: string,
  entry: ApprovalEntry,
  options: { fs?: AtomicWriteFs } = {},
): Promise<ApprovalsFile> {
  const checked = approvalEntrySchema.safeParse(entry);
  if (!checked.success) {
    throw new PriceStoreError(
      'invalid_data',
      `the decision is invalid: ${issuesText(checked.error)}`,
    );
  }
  const current = await readApprovals(path);
  if (current === null) {
    throw new PriceStoreError('invalid_data', `${path} does not exist`);
  }
  const next: ApprovalsFile = {
    approvals: [...current.approvals, checked.data],
  };
  await writeFileAtomic(path, serialiseApprovals(next), {
    mode: 'replace',
    fs: options.fs,
  });
  return next;
}
