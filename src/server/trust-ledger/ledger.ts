import {
  trustLedgerEntryProblems,
  trustLedgerEntrySchema,
  type TrustLedgerEntry,
} from './entry-schema.ts';

export { isTrustLedgerMonth } from './month.ts';

// E11.8-01: the committed Trust Ledger, built from the entry files the site
// bundles at build (`bundled.ts`) or the prebuild check reads from disk. Each
// file is `YYYY-MM.json`, holds that month's entry, and passes the entry
// schema; anything else makes the whole ledger invalid, so the build fails
// rather than publishing a partial or wrong record.

export const trustLedgerDirectory = 'src/content/trust-ledger';
export const trustLedgerEntryFile = /^(\d{4}-(?:0[1-9]|1[0-2]))\.json$/u;

export interface TrustLedger {
  /** Every committed entry, newest month first. */
  readonly entries: readonly TrustLedgerEntry[];
  /** Whether any entry is committed: the links render only then. */
  readonly published: boolean;
}

export class TrustLedgerInvalidError extends Error {
  public readonly problems: readonly string[];

  public constructor(problems: readonly string[]) {
    super(`The Trust Ledger is invalid:\n${problems.join('\n')}`);
    this.name = 'TrustLedgerInvalidError';
    this.problems = problems;
  }
}

/**
 * The problems with a set of entry files, keyed by file name, each problem
 * prefixed with its file. An empty list means every file is a valid entry.
 */
export function trustLedgerFileProblems(
  files: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(files).sort()) {
    const match = trustLedgerEntryFile.exec(name);
    if (match === null) {
      problems.push(`${name}: an entry file is named YYYY-MM.json`);
      continue;
    }
    const value = files[name];
    for (const problem of trustLedgerEntryProblems(value))
      problems.push(`${name}: ${problem}`);
    const month =
      typeof value === 'object' && value !== null && 'month' in value
        ? (value as { month: unknown }).month
        : undefined;
    if (typeof month === 'string' && month !== match[1])
      problems.push(`${name}: its month is ${month}, not ${match[1]}`);
  }
  return problems;
}

/** The ledger of `files`; throws TrustLedgerInvalidError on any problem. */
export function createTrustLedger(
  files: Readonly<Record<string, unknown>>,
): TrustLedger {
  const problems = trustLedgerFileProblems(files);
  if (problems.length > 0) throw new TrustLedgerInvalidError(problems);
  const entries = Object.values(files)
    .map((value) => trustLedgerEntrySchema.parse(value))
    .sort((a, b) => b.month.localeCompare(a.month));
  return Object.freeze({
    entries: Object.freeze(entries),
    published: entries.length > 0,
  });
}
