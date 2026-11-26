import type { DatabaseConnection } from './pool.ts';

// E11.8-01: the Trust Ledger's waitlist figures, as one aggregate over the
// subscriber table (docs/features/trust-ledger.md#the-waitlist-figures). It
// returns three counts and nothing about any person. Only verified rows are
// read: an unverified subscriber is never counted (standing rule 2). A
// referral counts only on a confirmed, non-voided edge, the definition every
// consumer of the confirmed count uses; a partner's link or code makes such
// an edge too, so partner referrals are counted (P11 Part 1).

export interface TrustLedgerWaitlistCounts {
  /** Verified subscribers when the query runs. */
  readonly verifiedTotal: number;
  /** Of those, the ones verified within the month. */
  readonly verifiedInMonth: number;
  /** Of those, the ones whose referral edge is confirmed and not voided. */
  readonly verifiedInMonthThroughReferral: number;
}

interface CountsRow {
  readonly verified_total: number;
  readonly verified_in_month: number;
  readonly verified_in_month_through_referral: number;
}

export interface TrustLedgerRepository {
  waitlistCounts(range: {
    readonly start: Date;
    readonly end: Date;
  }): Promise<TrustLedgerWaitlistCounts>;
}

export function createTrustLedgerRepository(
  database: DatabaseConnection,
): TrustLedgerRepository {
  return {
    async waitlistCounts({ start, end }) {
      const row = await database.readOne<CountsRow>({
        text: `
          SELECT
            count(*)::integer AS verified_total,
            count(*) FILTER (
              WHERE s.verified_at >= $1 AND s.verified_at < $2
            )::integer AS verified_in_month,
            count(*) FILTER (
              WHERE s.verified_at >= $1 AND s.verified_at < $2
                AND EXISTS (
                  SELECT 1
                  FROM referral_edge e
                  WHERE e.referred_id = s.id
                    AND e.state = 'confirmed'
                    AND e.voided_at IS NULL
                )
            )::integer AS verified_in_month_through_referral
          FROM subscriber s
          WHERE s.status = 'verified'
        `,
        values: [start, end],
      });
      if (row === null) throw new Error('The waitlist count returned no row.');
      return {
        verifiedTotal: row.verified_total,
        verifiedInMonth: row.verified_in_month,
        verifiedInMonthThroughReferral: row.verified_in_month_through_referral,
      };
    },
  };
}
