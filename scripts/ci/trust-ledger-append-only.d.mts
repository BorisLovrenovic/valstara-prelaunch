export const trustLedgerEntryDirectory: string;
export const howWeCountFile: string;

export interface TrustLedgerAppendOnlyIssue {
  readonly message: string;
  readonly path: string;
  readonly scan: 'trust-ledger-append-only';
}

export function scanTrustLedgerAppendOnly(options: {
  readonly root: string;
  readonly base?: string | undefined;
}): TrustLedgerAppendOnlyIssue[];
