import { z } from 'astro/zod';

import { trustLedgerMonthPattern } from './month.ts';

// E11.8-01: one Trust Ledger entry, `src/content/trust-ledger/YYYY-MM.json`,
// for Phase 1 (docs/features/trust-ledger.md#phase-1-pre-launch-december-2026--september-2027)
// and the three closing sections. Every object is strict, so a key the schema
// does not name (a supplier's name, a price, revenue, a margin, a person) is
// refused rather than ignored. Every figure is an exact count: a non-negative
// integer. Text is the founder's plain words, one paragraph or list item per
// string, rendered as text, never as Markdown or HTML (epic rule 1: counts
// only, and no personal data reaches a page).

export { trustLedgerMonthPattern };
export const trustLedgerDatePattern = /^\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/u;

export const trustLedgerTextLimits = Object.freeze({
  paragraphCharacters: 1_200,
  itemCharacters: 400,
  listItems: 40,
  paragraphs: 12,
});

/** The first month whose entry must give the month's own supplier figures. */
export const trustLedgerMonthlySupplierFiguresFrom = '2027-01';

/** The three build-progress states (P11 Part 1: done, in progress or next). */
export const buildProgressStatuses = ['done', 'in progress', 'next'] as const;

const emailAddress = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const webAddress = /(?:https?:\/\/|www\.)/iu;
const ipv4Address = /(?:^|[^\d])(?:\d{1,3}\.){3}\d{1,3}(?!\d)/u;
const markup = /[<>]/u;

/** Why a piece of entry text is refused, or null when it is plain words. */
export function trustLedgerTextProblem(text: string): string | null {
  if (text.trim() !== text) return 'starts or ends with a space';
  if (text === '') return 'is empty';
  if (/[\r\n\t]/u.test(text)) return 'spans more than one line';
  if (emailAddress.test(text)) return 'holds an email address';
  if (ipv4Address.test(text)) return 'holds an IP address';
  if (webAddress.test(text)) return 'holds a web address';
  if (markup.test(text)) return 'holds markup';
  if (text.includes('!')) return 'has an exclamation mark';
  return null;
}

function text(maximum: number) {
  return z
    .string()
    .max(maximum)
    .superRefine((value, context) => {
      const problem = trustLedgerTextProblem(value);
      if (problem !== null)
        context.addIssue({ code: 'custom', message: `The text ${problem}.` });
    });
}

const paragraph = text(trustLedgerTextLimits.paragraphCharacters);
const item = text(trustLedgerTextLimits.itemCharacters);
const paragraphs = z
  .array(paragraph)
  .min(1)
  .max(trustLedgerTextLimits.paragraphs);
const items = z.array(item).min(1).max(trustLedgerTextLimits.listItems);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function isCalendarDate(value: string): boolean {
  if (!trustLedgerDatePattern.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const calendarDate = z
  .string()
  .refine(isCalendarDate, 'Write the date as YYYY-MM-DD, a real date.');

const supplierCounts = z
  .strictObject({ evaluated: count, verified: count, rejected: count })
  .refine(
    ({ evaluated, verified, rejected }) => verified + rejected === evaluated,
    'Each supplier evaluated is counted once, as verified or rejected, so verified + rejected must equal evaluated.',
  );

const datedItems = z.strictObject({
  items: z
    .array(z.strictObject({ date: calendarDate, text: item }))
    .min(1)
    .max(trustLedgerTextLimits.listItems),
});
const noneStatement = z.strictObject({ none: paragraph });

export const trustLedgerEntrySchema = z
  .strictObject({
    month: z
      .string()
      .regex(trustLedgerMonthPattern, 'Write the month as YYYY-MM.'),
    introduction: paragraphs,
    // Written by `trust-ledger draft` from the admin route's counts.
    waitlist: z
      .strictObject({
        countedOn: calendarDate,
        total: count,
        newThisMonth: count,
        joinedThroughReferral: count,
      })
      .refine(
        ({ total, newThisMonth, joinedThroughReferral }) =>
          joinedThroughReferral <= newThisMonth && newThisMonth <= total,
        'Joined through a referral cannot exceed new this month, and new this month cannot exceed the total.',
      ),
    buildProgress: z
      .array(z.strictObject({ item, status: z.enum(buildProgressStatuses) }))
      .min(1)
      .max(trustLedgerTextLimits.listItems),
    supplyReadiness: z
      .strictObject({
        note: z.array(paragraph).max(trustLedgerTextLimits.paragraphs),
        total: supplierCounts,
        // From January 2027, each entry also gives the month's own figures
        // (P11 Part 2); null is allowed only before then (refined below).
        thisMonth: supplierCounts.nullable(),
        launchProducts: count,
        launchProductsWithVerifiedSupply: count,
      })
      .refine(
        ({ launchProducts, launchProductsWithVerifiedSupply }) =>
          launchProductsWithVerifiedSupply <= launchProducts,
        'Launch products with verified supply cannot exceed launch products.',
      ),
    partnerProgramme: z
      .strictObject({
        applicationsReceived: count,
        approved: count,
        active: count,
      })
      .refine(
        ({ applicationsReceived, approved, active }) =>
          active <= approved && approved <= applicationsReceived,
        'Active cannot exceed approved, and approved cannot exceed applications received.',
      ),
    policyChanges: z.union([datedItems, noneStatement]),
    corrections: z.union([datedItems, noneStatement]),
    launchStatus: paragraphs,
    whatWentWrong: paragraphs,
    whatWeChanged: paragraphs,
    focusForNextMonth: items,
    // A month that changes "How we count" says what changed and why (P11
    // Part 1). The append-only guard refuses a changed "How we count" unless
    // a new entry carries this section.
    howWeCountChanges: paragraphs.optional(),
  })
  .refine(
    ({ month, waitlist }) => waitlist.countedOn.slice(0, 7) >= month,
    'The waitlist figures are counted on or after the first day of their month.',
  )
  // D-077 Q3: P11 Part 2 promises "From January 2027, each entry also gives
  // that month's figures", so from 2027-01 the month's supplier figures are
  // required. `trust-ledger draft` writes null, so a 2027 draft fails here
  // until the founder completes it.
  .refine(
    ({ month, supplyReadiness }) =>
      month < trustLedgerMonthlySupplierFiguresFrom ||
      supplyReadiness.thisMonth !== null,
    {
      path: ['supplyReadiness', 'thisMonth'],
      message: `From ${trustLedgerMonthlySupplierFiguresFrom}, supplyReadiness.thisMonth must give the month's own supplier figures (evaluated, verified and rejected), not null.`,
    },
  );

export type TrustLedgerEntry = z.infer<typeof trustLedgerEntrySchema>;

/** The schema's issues for `value`, one readable line each, or none. */
export function trustLedgerEntryProblems(value: unknown): string[] {
  const result = trustLedgerEntrySchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}
