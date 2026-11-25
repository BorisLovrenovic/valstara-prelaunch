import { trustLedgerCopy } from '../../copy/trust-ledger.ts';

import type { TrustLedgerEntry } from './entry-schema.ts';
import type { TrustLedger } from './ledger.ts';

// E11.8-01: what `/trust-ledger` shows. The newest entry first, then every
// earlier entry, each section in the founder's fixed order (Phase 1's
// sections, then the three closing sections). Every figure is printed exactly,
// with digit grouping only; nothing is rounded.

export type TrustLedgerBlock =
  | { readonly kind: 'paragraphs'; readonly paragraphs: readonly string[] }
  | { readonly kind: 'list'; readonly items: readonly string[] };

export interface TrustLedgerSectionView {
  readonly id: string;
  readonly heading: string;
  readonly blocks: readonly TrustLedgerBlock[];
}

export interface TrustLedgerEntryView {
  readonly month: string;
  readonly id: string;
  readonly heading: string;
  readonly newest: boolean;
  readonly sections: readonly TrustLedgerSectionView[];
}

const monthFormat = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const countFormat = new Intl.NumberFormat('en-GB', {
  maximumFractionDigits: 0,
  useGrouping: true,
});

/** "December 2026" for `2026-12`. */
export function trustLedgerMonthLabel(month: string): string {
  return monthFormat.format(new Date(`${month}-01T00:00:00.000Z`));
}

/** "1 December 2026" for `2026-12-01`. */
export function trustLedgerDateLabel(date: string): string {
  return dateFormat.format(new Date(`${date}T00:00:00.000Z`));
}

/** An exact count with digit grouping: "1,287". */
export function trustLedgerCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`A Trust Ledger figure is a count, not ${value}.`);
  return countFormat.format(value);
}

const copy = trustLedgerCopy;
const figure = (label: string, value: number) =>
  copy.figure(label, trustLedgerCount(value));
const share = (label: string, part: number, whole: number) =>
  copy.figure(
    label,
    copy.share(trustLedgerCount(part), trustLedgerCount(whole)),
  );

function paragraphs(values: readonly string[]): TrustLedgerBlock {
  return { kind: 'paragraphs', paragraphs: values };
}

function list(values: readonly string[]): TrustLedgerBlock {
  return { kind: 'list', items: values };
}

function datedOrNone(
  section: TrustLedgerEntry['policyChanges'],
): TrustLedgerBlock {
  return 'none' in section
    ? paragraphs([section.none])
    : list(
        section.items.map(({ date, text }) =>
          copy.datedItem(trustLedgerDateLabel(date), text),
        ),
      );
}

function sections(
  entry: TrustLedgerEntry,
): [keyof typeof copy.sections, TrustLedgerBlock[]][] {
  const { waitlist, supplyReadiness: supply, partnerProgramme } = entry;
  const supplyLines = [
    figure(copy.supply.evaluated, supply.total.evaluated),
    figure(copy.supply.verified, supply.total.verified),
    figure(copy.supply.rejected, supply.total.rejected),
    ...(supply.thisMonth === null
      ? []
      : [
          figure(copy.supply.evaluatedThisMonth, supply.thisMonth.evaluated),
          figure(copy.supply.verifiedThisMonth, supply.thisMonth.verified),
          figure(copy.supply.rejectedThisMonth, supply.thisMonth.rejected),
        ]),
    figure(copy.supply.launchProducts, supply.launchProducts),
    share(
      copy.supply.withVerifiedSupply,
      supply.launchProductsWithVerifiedSupply,
      supply.launchProducts,
    ),
  ];
  return [
    ['introduction', [paragraphs(entry.introduction)]],
    [
      'waitlist',
      [
        paragraphs([
          copy.waitlist.countedOn(trustLedgerDateLabel(waitlist.countedOn)),
        ]),
        list([
          figure(copy.waitlist.total, waitlist.total),
          figure(copy.waitlist.newThisMonth, waitlist.newThisMonth),
          share(
            copy.waitlist.joinedThroughReferral,
            waitlist.joinedThroughReferral,
            waitlist.newThisMonth,
          ),
        ]),
      ],
    ],
    [
      'buildProgress',
      [
        list(
          entry.buildProgress.map(({ item, status }) =>
            copy.figure(item, status),
          ),
        ),
      ],
    ],
    [
      'supplyReadiness',
      [
        ...(supply.note.length === 0 ? [] : [paragraphs(supply.note)]),
        list(supplyLines),
      ],
    ],
    [
      'partnerProgramme',
      [
        list([
          figure(
            copy.partners.applicationsReceived,
            partnerProgramme.applicationsReceived,
          ),
          figure(copy.partners.approved, partnerProgramme.approved),
          figure(copy.partners.active, partnerProgramme.active),
        ]),
      ],
    ],
    ['policyChanges', [datedOrNone(entry.policyChanges)]],
    ['corrections', [datedOrNone(entry.corrections)]],
    ...(entry.howWeCountChanges === undefined
      ? []
      : ([['howWeCountChanges', [paragraphs(entry.howWeCountChanges)]]] as [
          keyof typeof copy.sections,
          TrustLedgerBlock[],
        ][])),
    ['launchStatus', [paragraphs(entry.launchStatus)]],
    ['whatWentWrong', [paragraphs(entry.whatWentWrong)]],
    ['whatWeChanged', [paragraphs(entry.whatWeChanged)]],
    ['focusForNextMonth', [list(entry.focusForNextMonth)]],
  ];
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

/** Every entry of `ledger`, newest first, ready to render. */
export function trustLedgerView(
  ledger: TrustLedger,
): readonly TrustLedgerEntryView[] {
  return ledger.entries.map((entry, index) => {
    const id = `trust-ledger-${entry.month}`;
    return {
      month: entry.month,
      id,
      heading: trustLedgerMonthLabel(entry.month),
      newest: index === 0,
      sections: sections(entry).map(([key, blocks]) => ({
        id: `${id}-${kebab(key)}`,
        heading: copy.sections[key],
        blocks,
      })),
    };
  });
}
