import { createAuditService } from '../audit/service.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createTrustLedgerRepository } from '../db/trust-ledger.ts';

import { isTrustLedgerMonth } from './month.ts';

// E11.8-01: the waitlist figures for one calendar month in UTC, read by the
// founder through GET /api/admin/trust-ledger/waitlist and the
// `trust-ledger draft` command. Counts only: verified subscribers in total at
// the run, those verified during the month, and those of them whose
// verification confirmed a referral edge. Every read is audited with the
// actor, the month and the three counts, in the transaction that reads them,
// so an unaudited read never returns.

export interface TrustLedgerWaitlistFigures {
  readonly month: string;
  /** When the counts were read; the entry's "Total" is on this day. */
  readonly countedAt: Date;
  readonly verifiedTotal: number;
  readonly verifiedInMonth: number;
  readonly verifiedInMonthThroughReferral: number;
}

export type TrustLedgerFiguresRefusal = 'month' | 'future_month' | 'actor';

export class TrustLedgerFiguresRefusedError extends Error {
  public readonly refusal: TrustLedgerFiguresRefusal;

  public constructor(refusal: TrustLedgerFiguresRefusal) {
    super(`The Trust Ledger figures were refused: ${refusal}.`);
    this.name = 'TrustLedgerFiguresRefusedError';
    this.refusal = refusal;
  }
}

export interface TrustLedgerFiguresService {
  figures(input: {
    readonly month: string;
    readonly actor: string;
  }): Promise<TrustLedgerWaitlistFigures>;
}

/** The month's first instant and the next month's, in UTC. */
export function trustLedgerMonthRange(month: string): {
  start: Date;
  end: Date;
} {
  const [year, monthNumber] = month.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1)),
    end: new Date(Date.UTC(year, monthNumber, 1)),
  };
}

export function createTrustLedgerFiguresService(
  database: DatabasePool,
  options: { readonly clock?: () => Date } = {},
): TrustLedgerFiguresService {
  const clock = options.clock ?? (() => new Date());
  return {
    async figures({ month, actor }) {
      if (actor.trim() === '' || actor.startsWith('system:'))
        throw new TrustLedgerFiguresRefusedError('actor');
      if (!isTrustLedgerMonth(month))
        throw new TrustLedgerFiguresRefusedError('month');
      const countedAt = clock();
      const range = trustLedgerMonthRange(month);
      // A month that has not begun has no figures to publish.
      if (range.start.getTime() > countedAt.getTime())
        throw new TrustLedgerFiguresRefusedError('future_month');
      return withTransaction(database, async (connection) => {
        const counts =
          await createTrustLedgerRepository(connection).waitlistCounts(range);
        await createAuditService(connection).record({
          action: 'trust_ledger.waitlist_counted',
          actor,
          // A month has no row of its own; it is in the detail.
          subjectId: null,
          subjectType: 'trust_ledger',
          detail: {
            month,
            counted_at: countedAt.toISOString(),
            verified_total: counts.verifiedTotal,
            verified_in_month: counts.verifiedInMonth,
            verified_in_month_through_referral:
              counts.verifiedInMonthThroughReferral,
          },
        });
        return { month, countedAt, ...counts };
      });
    },
  };
}
