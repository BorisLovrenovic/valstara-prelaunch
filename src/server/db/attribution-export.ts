import type { QueryResultRow } from 'pg';

import { earnedPartnerPerkEdge } from './partner-attribution.ts';
import type { DatabaseClient, DatabasePool } from './pool.ts';

// E11.7-14: the attribution export's reads. One repeatable-read, read-only
// snapshot serves every section, so the counts, the rows and a second run
// against an unchanged database all agree. Every page is keyset-paged by id
// and capped at `attributionExportBatchSize` rows.

export const attributionExportBatchSize = 500;

/**
 * The E11-06 customer export set: verified, unsuppressed, and therefore not
 * disqualified, departed, pending or erased (`docs/data/model.md`). Nobody
 * outside it appears in the attribution export.
 */
function inExportSet(alias: string): string {
  return `${alias}.status = 'verified' AND NOT EXISTS (
    SELECT 1 FROM suppression x WHERE x.email_normalised = ${alias}.email_normalised)`;
}

const partnerRows = `
  FROM partner p
  JOIN subscriber s ON s.id = p.subscriber_id
  LEFT JOIN referral_code c ON c.owner_kind = 'partner' AND c.owner_id = p.id
  WHERE p.status IN ('active', 'paused', 'terminated')
    AND p.personal_data_purged_at IS NULL
    AND ${inExportSet('s')}`;

/** A confirmed edge, voided or not, whose two people are both in the set. */
const referralRows = `
  FROM referral_edge e
  JOIN subscriber r ON r.id = e.referrer_id
  JOIN subscriber d ON d.id = e.referred_id
  LEFT JOIN referral_code c ON c.owner_kind = 'partner' AND c.owner_id = e.partner_id
  WHERE e.state = 'confirmed' AND ${inExportSet('r')} AND ${inExportSet('d')}`;

const couponRows = `
  FROM referral_coupon k
  JOIN subscriber s ON s.id = k.subscriber_id
  WHERE k.state = 'held' AND ${inExportSet('s')}`;

/**
 * A friend in the set whose earned welcome discount no referral record
 * carries: the D-058 entitlement kept after the partner's erasure, or an
 * earned partner edge whose referrer is outside the set (a disqualified,
 * departed or suppressed partner). A friend has at most one edge, so at most
 * one source applies, and the record names no partner, code or edge.
 */
const welcomeDiscountRows = `
  FROM subscriber s
  LEFT JOIN retained_partner_entitlement t
    ON t.subscriber_id = s.id AND t.wave_one
  LEFT JOIN LATERAL (
    SELECT e.welcome_discount_pct
    FROM referral_edge e
    JOIN subscriber r ON r.id = e.referrer_id
    WHERE e.referred_id = s.id AND ${earnedPartnerPerkEdge}
      AND NOT (e.state = 'confirmed' AND ${inExportSet('r')})
  ) earned ON true
  WHERE ${inExportSet('s')}
    AND (t.subscriber_id IS NOT NULL OR earned.welcome_discount_pct IS NOT NULL)`;

export interface AttributionPartnerRow {
  readonly id: string;
  readonly subscriber_id: string;
  readonly full_name: string | null;
  readonly email: string;
  readonly email_normalised: string;
  readonly country_of_residence: string | null;
  readonly partner_type: string;
  readonly status: string;
  readonly partner_code: string | null;
  readonly member_code: string | null;
  readonly approved_at: Date | null;
  readonly contract_signed_at: string | null;
  readonly contract_version: string | null;
  readonly display_name: string | null;
}

export interface AttributionReferralRow {
  readonly id: string;
  readonly referred_id: string;
  readonly referred_email: string;
  readonly referred_email_normalised: string;
  readonly referrer_id: string;
  readonly referrer_email_normalised: string;
  readonly partner_id: string | null;
  readonly partner_code: string | null;
  readonly attribution_method: string;
  readonly signup_at: Date;
  readonly confirmed_at: Date | null;
  readonly voided_at: Date | null;
  readonly void_reason: string | null;
  readonly referred_access_window: string | null;
  readonly welcome_discount_pct: number | null;
}

export interface AttributionCouponRow {
  readonly id: string;
  readonly subscriber_id: string;
  readonly email_normalised: string;
  readonly coupon_number: number;
  readonly percent: number;
}

export interface AttributionWelcomeDiscountRow {
  readonly id: string;
  readonly email: string;
  readonly email_normalised: string;
  readonly welcome_discount_pct: number;
}

export interface AttributionExportCounts {
  readonly partners: number;
  readonly referrals: number;
  readonly coupons: number;
  readonly welcome_discounts: number;
}

export interface AttributionExportSnapshot {
  readonly counts: AttributionExportCounts;
  partners(
    afterId: string | null,
    limit: number,
  ): Promise<readonly AttributionPartnerRow[]>;
  referrals(
    afterId: string | null,
    limit: number,
  ): Promise<readonly AttributionReferralRow[]>;
  coupons(
    afterId: string | null,
    limit: number,
  ): Promise<readonly AttributionCouponRow[]>;
  welcomeDiscounts(
    afterId: string | null,
    limit: number,
  ): Promise<readonly AttributionWelcomeDiscountRow[]>;
  close(): Promise<void>;
}

function assertPageLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > attributionExportBatchSize
  ) {
    throw new RangeError(
      `An attribution export page holds 1 to ${attributionExportBatchSize} rows.`,
    );
  }
}

export async function openAttributionExportSnapshot(
  database: DatabasePool,
): Promise<AttributionExportSnapshot> {
  const connection: DatabaseClient = await database.connect();
  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await connection.execute({ text: 'ROLLBACK' });
    } finally {
      connection.release();
    }
  }

  function page<Row extends QueryResultRow>(
    columns: string,
    rows: string,
    idColumn: string,
  ) {
    return async (
      afterId: string | null,
      limit: number,
    ): Promise<readonly Row[]> => {
      if (closed) throw new Error('Attribution export snapshot is closed.');
      assertPageLimit(limit);
      return connection.list<Row>(
        {
          text: `SELECT ${columns} ${rows}
            AND ($1::uuid IS NULL OR ${idColumn} > $1::uuid)
            ORDER BY ${idColumn}`,
          values: [afterId],
        },
        limit,
      );
    };
  }

  try {
    await connection.execute({
      text: 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    });
    const counts = await connection.readOne<{
      partners: number;
      referrals: number;
      coupons: number;
      welcome_discounts: number;
    }>({
      text: `SELECT
        (SELECT count(*)::int ${partnerRows}) AS partners,
        (SELECT count(*)::int ${referralRows}) AS referrals,
        (SELECT count(*)::int ${couponRows}) AS coupons,
        (SELECT count(*)::int ${welcomeDiscountRows}) AS welcome_discounts`,
    });
    if (counts === null) {
      throw new Error('Attribution export counts were unavailable.');
    }
    return {
      counts: {
        partners: counts.partners,
        referrals: counts.referrals,
        coupons: counts.coupons,
        welcome_discounts: counts.welcome_discounts,
      },
      partners: page<AttributionPartnerRow>(
        `p.id, p.subscriber_id, p.full_name, s.email, s.email_normalised,
          p.country_of_residence, p.partner_type, p.status,
          c.code AS partner_code, s.referral_code AS member_code,
          (SELECT min((a.detail #>> '{after,status_changed_at}')::timestamptz)
            FROM audit_log a
            WHERE a.subject_type = 'partner' AND a.action = 'partner.approved'
              AND a.subject_id = p.id::text) AS approved_at,
          to_char(p.contract_signed_at, 'YYYY-MM-DD') AS contract_signed_at,
          p.contract_version, p.display_name`,
        partnerRows,
        'p.id',
      ),
      referrals: page<AttributionReferralRow>(
        `e.id, d.id AS referred_id, d.email AS referred_email,
          d.email_normalised AS referred_email_normalised,
          r.id AS referrer_id, r.email_normalised AS referrer_email_normalised,
          e.partner_id, c.code AS partner_code, e.attribution_method,
          d.created_at AS signup_at, e.confirmed_at, e.voided_at, e.void_reason,
          d.access_window AS referred_access_window, e.welcome_discount_pct`,
        referralRows,
        'e.id',
      ),
      coupons: page<AttributionCouponRow>(
        `k.id, k.subscriber_id, s.email_normalised, k.coupon_number::int AS coupon_number,
          k.percent::int AS percent`,
        couponRows,
        'k.id',
      ),
      welcomeDiscounts: page<AttributionWelcomeDiscountRow>(
        `s.id, s.email, s.email_normalised,
          COALESCE(earned.welcome_discount_pct, t.welcome_discount_pct) AS welcome_discount_pct`,
        welcomeDiscountRows,
        's.id',
      ),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
