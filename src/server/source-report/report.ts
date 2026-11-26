import { createAuditService } from '../audit/service.ts';
import type { DatabasePool } from '../db/pool.ts';
import {
  createSourceReportRepository,
  type SourceReportCounts,
  type SourceReportGroup,
} from '../db/source-report.ts';
import { withTransaction } from '../db/transaction.ts';

import {
  sourceReportLabels,
  utmCampaignPattern,
  type UtmConvention,
} from './convention-rules.ts';

// E11.8-02: the founder's per-platform signup report, read through
// GET /api/admin/reports/sources and `npm run report:sources`. For the
// signups created in a range of UTC calendar days it counts, per normalised
// utm_source, utm_medium and utm_campaign, the signups, the verified signups,
// the confirmed referrals those subscribers went on to make and their first
// survey completions; signups without UTM values are split into those that
// carried a valid signed ref and those that did not. Counts and labels only:
// a value off the convention is `other`, and no visitor-supplied text, email,
// code or id reaches the result. Every run is audited with the actor, the
// range and the row count, in the transaction that reads it, so an unaudited
// report never returns.

export type { SourceReportCounts } from '../db/source-report.ts';

/** The most rows one report holds; a larger range is refused. */
export const sourceReportMaximumRows = 2_000;

export interface SourceReportRow extends SourceReportCounts {
  readonly source: string;
  readonly medium: string;
  readonly campaign: string;
}

export interface SourceReport {
  /** The range's first and last UTC calendar day, inclusive. */
  readonly from: string;
  readonly to: string;
  readonly countedAt: Date;
  /** Signups that carried UTM values, by source, medium and campaign. */
  readonly rows: readonly SourceReportRow[];
  /** Signups without UTM values. */
  readonly withoutUtm: {
    /** With a valid signed ref: `referral link or code`. */
    readonly referral: SourceReportCounts;
    /** Without one: `none`. */
    readonly none: SourceReportCounts;
  };
  readonly totals: SourceReportCounts;
  /** Every row the report holds: the UTM rows and the two no-UTM rows. */
  readonly rowCount: number;
}

export type SourceReportRefusal = 'actor' | 'range' | 'too_many_rows';

export class SourceReportRefusedError extends Error {
  public readonly refusal: SourceReportRefusal;

  public constructor(refusal: SourceReportRefusal) {
    super(`The source report was refused: ${refusal}.`);
    this.name = 'SourceReportRefusedError';
    this.refusal = refusal;
  }
}

export interface SourceReportService {
  report(input: {
    readonly from: string;
    readonly to: string;
    readonly actor: string;
  }): Promise<SourceReport>;
}

const calendarDay = /^(\d{4})-(\d{2})-(\d{2})$/u;
const dayMilliseconds = 24 * 60 * 60 * 1_000;

/** The day's first instant in UTC, or null for anything but a real date. */
export function utcCalendarDay(value: string): Date | null {
  const match = calendarDay.exec(value);
  if (match === null) return null;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

/** From the first day's first instant to the instant after the last day. */
export function sourceReportRange(
  from: string,
  to: string,
): { start: Date; end: Date } | null {
  const start = utcCalendarDay(from);
  const last = utcCalendarDay(to);
  if (start === null || last === null || last < start) return null;
  return { start, end: new Date(last.getTime() + dayMilliseconds) };
}

const zero: SourceReportCounts = Object.freeze({
  signups: 0,
  verifiedSignups: 0,
  confirmedReferrals: 0,
  firstSurveyCompletions: 0,
});

function counts(group: SourceReportCounts): SourceReportCounts {
  return {
    signups: group.signups,
    verifiedSignups: group.verifiedSignups,
    confirmedReferrals: group.confirmedReferrals,
    firstSurveyCompletions: group.firstSurveyCompletions,
  };
}

function add(
  left: SourceReportCounts,
  right: SourceReportCounts,
): SourceReportCounts {
  return {
    signups: left.signups + right.signups,
    verifiedSignups: left.verifiedSignups + right.verifiedSignups,
    confirmedReferrals: left.confirmedReferrals + right.confirmedReferrals,
    firstSurveyCompletions:
      left.firstSurveyCompletions + right.firstSurveyCompletions,
  };
}

/**
 * The query classifies every value; this check refuses to return a label the
 * convention does not allow, so a defect there can never print stored text.
 */
function printable(
  value: string | null,
  allowed: (label: string) => boolean,
): string {
  if (value === null) throw new Error('A UTM row is missing a label.');
  if (
    value === sourceReportLabels.other ||
    value === sourceReportLabels.notSet ||
    allowed(value)
  )
    return value;
  throw new Error('The source report produced an unlisted label.');
}

export function createSourceReportService(
  database: DatabasePool,
  options: {
    readonly convention: UtmConvention;
    readonly clock?: () => Date;
  },
): SourceReportService {
  const clock = options.clock ?? (() => new Date());
  const sources = new Set(options.convention.utm_source);
  const media = new Set(options.convention.utm_medium);
  return {
    async report({ from, to, actor }) {
      if (actor.trim() === '' || actor.startsWith('system:'))
        throw new SourceReportRefusedError('actor');
      const range = sourceReportRange(from, to);
      if (range === null) throw new SourceReportRefusedError('range');
      const countedAt = clock();
      return withTransaction(database, async (connection) => {
        const groups = await createSourceReportRepository(connection).groups({
          ...range,
          sources: options.convention.utm_source,
          media: options.convention.utm_medium,
          campaignPattern: utmCampaignPattern.source,
          labels: sourceReportLabels,
          // One more than the cap: a result cut at the limit always holds
          // more rows than the cap, so it is refused, never shown in part.
          limit: sourceReportMaximumRows + 1,
        });
        const report = shape(groups, sources, media, {
          from,
          to,
          countedAt,
        });
        if (report.rowCount > sourceReportMaximumRows)
          throw new SourceReportRefusedError('too_many_rows');
        await createAuditService(connection).record({
          action: 'report.sources_counted',
          actor,
          // A range has no row of its own; it is in the detail.
          subjectId: null,
          subjectType: 'source_report',
          detail: { from, to, row_count: report.rowCount },
        });
        return report;
      });
    },
  };
}

function shape(
  groups: readonly SourceReportGroup[],
  sources: ReadonlySet<string>,
  media: ReadonlySet<string>,
  meta: { from: string; to: string; countedAt: Date },
): SourceReport {
  const rows: SourceReportRow[] = [];
  let referral = zero;
  let none = zero;
  for (const group of groups) {
    if (group.withoutUtm) {
      if (group.signedRef === true) referral = add(referral, counts(group));
      else none = add(none, counts(group));
      continue;
    }
    rows.push({
      source: printable(group.source, (value) => sources.has(value)),
      medium: printable(group.medium, (value) => media.has(value)),
      campaign: printable(group.campaign, (value) =>
        utmCampaignPattern.test(value),
      ),
      ...counts(group),
    });
  }
  const totals = [...rows, referral, none].reduce<SourceReportCounts>(
    (sum, row) => add(sum, counts(row)),
    zero,
  );
  return {
    ...meta,
    rows,
    withoutUtm: { referral, none },
    totals,
    rowCount: rows.length + 2,
  };
}
