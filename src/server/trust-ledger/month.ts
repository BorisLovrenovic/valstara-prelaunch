// E11.8-01: the Trust Ledger's month format, `YYYY-MM`, with no dependency,
// so the founder command line can load it under plain Node.
export const trustLedgerMonthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

export function isTrustLedgerMonth(value: string): boolean {
  return trustLedgerMonthPattern.test(value);
}
