import { z } from 'zod';

import {
  manualOverridesFileSchema,
  type ManualEntry,
  type ManualOverridesFile,
} from '../schema/manual-overrides.ts';
import { writeFileAtomic, type AtomicWriteFs } from './atomic-write.ts';
import { PriceStoreError } from './price-store.ts';

// data/price-index/manual-overrides.json (E11.6-08's `override` commands).
// The founder's hand-entered prices and `not_offered` confirmations. Unlike
// approvals.json it is not append-only: `override retire` removes an entry.
// It is written atomically and deterministically (epic rule 8): entries in
// identity order (service, plan, billing period, market) and each entry's
// keys in the schema's order, so a diff shows only real changes.

const commonKeys = [
  'kind',
  'market',
  'service_id',
  'plan_id',
  'billing_period',
] as const;
const verificationKeys = [
  'source_url',
  'verified_at',
  'verified_by',
  'note',
] as const;

/** A price entry's keys, in the order the file is written. */
export const priceOverrideKeys = [
  ...commonKeys,
  'price_local',
  'currency',
  'price_usd_source',
  ...verificationKeys,
] as const;

/** A `not_offered` entry's keys, in the order the file is written. */
export const notOfferedKeys = [...commonKeys, ...verificationKeys] as const;

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareEntries(a: ManualEntry, b: ManualEntry): number {
  return (
    compareText(a.service_id, b.service_id) ||
    compareText(a.plan_id, b.plan_id) ||
    compareText(a.billing_period, b.billing_period) ||
    compareText(a.market, b.market)
  );
}

function canonicalEntry(entry: ManualEntry): Record<string, unknown> {
  const keys: readonly string[] =
    entry.kind === 'price' ? priceOverrideKeys : notOfferedKeys;
  return Object.fromEntries(
    keys.map((key) => [key, (entry as Record<string, unknown>)[key]]),
  );
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
    .join('; ');
}

/** The canonical bytes of manual-overrides.json. Throws on an invalid file. */
export function serialiseManualOverrides(file: ManualOverridesFile): string {
  const result = manualOverridesFileSchema.safeParse(file);
  if (!result.success) {
    throw new PriceStoreError(
      'invalid_data',
      `the manual overrides are invalid: ${issuesText(result.error)}`,
    );
  }
  const canonical = {
    overrides: [...result.data.overrides]
      .sort(compareEntries)
      .map(canonicalEntry),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/**
 * Writes `file` to `path` atomically, after validating it against its
 * schema. Nothing is written when it is invalid.
 */
export async function writeManualOverrides(
  path: string,
  file: ManualOverridesFile,
  options: { fs?: AtomicWriteFs } = {},
): Promise<void> {
  await writeFileAtomic(path, serialiseManualOverrides(file), {
    mode: 'replace',
    fs: options.fs,
  });
}
