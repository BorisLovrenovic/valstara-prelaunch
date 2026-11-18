import type { ApprovalEntry } from '../schema/approvals.ts';
import type { ManualEntry } from '../schema/manual-overrides.ts';
import type { PriceRecord } from '../schema/price-record.ts';

// The merge's notes for the founder (E11.6-06). They go in a record's
// `notes`, one line each, and say why a record has its status: both values
// of a conflict, the rule a value broke, the last value of a plan that
// disappeared. They are working notes in a data file, never page copy, and
// they name no person.

/** `149.00 SEK`, or `no price` for a record without one. */
export function valueText(
  value: Pick<PriceRecord, 'price_local' | 'currency'>,
): string {
  return value.price_local === null || value.currency === null
    ? 'no price'
    : `${value.price_local} ${value.currency}`;
}

function day(decision: ApprovalEntry): string {
  return decision.decided_at.slice(0, 10);
}

export const notes = {
  conflict(entry: ManualEntry): string {
    return entry.kind === 'price'
      ? `Conflict: the manual override says ${entry.price_local} ${entry.currency}, verified ${entry.verified_at} (${entry.source_url}). Neither value publishes until the scraped one is approved or rejected.`
      : `Conflict: the manual entry says this plan is not offered, verified ${entry.verified_at} (${entry.source_url}). Neither publishes until the scraped value is approved or rejected.`;
  },
  approved(decision: ApprovalEntry, value: string): string {
    return `${value} was approved on ${day(decision)}.`;
  },
  rejected(decision: ApprovalEntry, value: string): string {
    return `${value} was rejected on ${day(decision)}, so it stays unpublished.`;
  },
  rejectedForEntry(decision: ApprovalEntry, value: string): string {
    return `The scraped ${value} was rejected on ${day(decision)}, so the manual entry stands.`;
  },
  retirable(): string {
    return 'The scraped value matches the manual override, which can be retired.';
  },
  matchesOverride(): string {
    return 'The scraped value matches the manual override.';
  },
  beyondThreshold(percent: number, baseline: PriceRecord): string {
    return `Changed by more than ${percent}% from the last published value, ${valueText(baseline)} (${baseline.status}). It needs an approval.`;
  },
  otherCurrency(baseline: PriceRecord): string {
    return `The last published value, ${valueText(baseline)}, is in another currency, so the change cannot be measured. It needs an approval.`;
  },
  afterFlag(previous: PriceRecord): string {
    return `The previous record was ${previous.status}, so a new value needs an approval.`;
  },
  currencyMismatch(currency: string, market: string, expected: string): string {
    return `Breaks the currency check: ${currency} is not ${expected}, the currency of ${market}.`;
  },
  notAboveZero(): string {
    return 'Breaks the price check: the price is not above zero.';
  },
  unapprovable(): string {
    return 'No approval can publish it; a manual override can fill the gap.';
  },
  setAside(value: string): string {
    return `The scraped ${value} was set aside, so the manual entry fills the gap.`;
  },
  disappeared(previous: PriceRecord): string {
    return `Disappeared from the source; the last value was ${valueText(previous)}, observed ${previous.observed_at ?? 'on an unknown date'}.`;
  },
  disappearanceApproved(decision: ApprovalEntry): string {
    return `The disappearance was approved on ${day(decision)}.`;
  },
  kept(previous: PriceRecord, reason: string): string {
    return `Kept from ${previous.observed_at ?? 'an earlier run'}: this run could not read the page (${reason}).`;
  },
  stale(days: number): string {
    return `Stale: not refreshed within ${days} days.`;
  },
} as const;

/** The notes as stored: one line each, or null for none. */
export function joinNotes(lines: readonly (string | null)[]): string | null {
  const present = lines.filter(
    (line): line is string => line !== null && line.length > 0,
  );
  return present.length === 0 ? null : present.join('\n');
}
