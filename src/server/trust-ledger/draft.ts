import { isTrustLedgerMonth } from './month.ts';

// E11.8-01: the new entry `trust-ledger draft --month YYYY-MM` writes. It
// holds the month's waitlist figures from the admin route and every other
// section empty, in the entry schema's order, for the founder to complete. An
// empty section fails the schema, so a draft cannot be built or published
// until it is complete. This module has no dependency, so the founder command
// line can load it under plain Node.

export interface TrustLedgerDraftFigures {
  readonly month: string;
  readonly countedAt: string;
  readonly verifiedTotal: number;
  readonly verifiedInMonth: number;
  readonly verifiedInMonthThroughReferral: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The figures in an admin route response for `month`, or null when the
 * response is not exactly what the route returns.
 */
export function readTrustLedgerFigures(
  body: Readonly<Record<string, unknown>>,
  month: string,
): TrustLedgerDraftFigures | null {
  const countedAt = body.counted_at;
  if (
    body.month !== month ||
    !isTrustLedgerMonth(month) ||
    typeof countedAt !== 'string' ||
    Number.isNaN(Date.parse(countedAt)) ||
    new Date(countedAt).toISOString() !== countedAt ||
    !isCount(body.verified_total) ||
    !isCount(body.verified_in_month) ||
    !isCount(body.verified_in_month_through_referral) ||
    body.verified_in_month_through_referral > body.verified_in_month ||
    body.verified_in_month > body.verified_total
  )
    return null;
  return {
    month,
    countedAt,
    verifiedTotal: body.verified_total,
    verifiedInMonth: body.verified_in_month,
    verifiedInMonthThroughReferral: body.verified_in_month_through_referral,
  };
}

/** The draft entry, in the schema's key order. */
export function trustLedgerDraft(figures: TrustLedgerDraftFigures) {
  return {
    month: figures.month,
    introduction: [],
    waitlist: {
      countedOn: figures.countedAt.slice(0, 10),
      total: figures.verifiedTotal,
      newThisMonth: figures.verifiedInMonth,
      joinedThroughReferral: figures.verifiedInMonthThroughReferral,
    },
    buildProgress: [],
    supplyReadiness: {
      note: [],
      total: { evaluated: null, verified: null, rejected: null },
      thisMonth: null,
      launchProducts: null,
      launchProductsWithVerifiedSupply: null,
    },
    partnerProgramme: {
      applicationsReceived: null,
      approved: null,
      active: null,
    },
    policyChanges: { items: [] },
    corrections: { items: [] },
    launchStatus: [],
    whatWentWrong: [],
    whatWeChanged: [],
    focusForNextMonth: [],
  };
}

/** The draft as the file's text: two-space JSON, as Prettier writes it. */
export function trustLedgerDraftSource(
  figures: TrustLedgerDraftFigures,
): string {
  return `${JSON.stringify(trustLedgerDraft(figures), null, 2)}\n`;
}
