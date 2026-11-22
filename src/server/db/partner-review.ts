import type {
  DatabaseClient,
  DatabaseConnection,
  DatabasePool,
} from './pool.ts';

// E11.7-06: the founder's review, contract and lifecycle commands
// (docs/features/admin.md#partners). All of their SQL lives here; the partner
// review service decides (docs/architecture/modules.md).

/** The largest page `partners list` returns (standing rule 13). */
export const partnerListPageLimit = 100;
/** The largest number of flagged referrals `partners show` lists. */
export const partnerFlaggedReferralLimit = 50;
/** The largest page the partners export reads at once (standing rule 13). */
export const partnerExportBatchSize = 500;

export type PartnerStatus =
  | 'unconfirmed'
  | 'applied'
  | 'approved'
  | 'contract_sent'
  | 'active'
  | 'paused'
  | 'terminated'
  | 'rejected';

/** The row a command locks and decides on, with its member and code. */
export interface PartnerReviewRow {
  readonly id: string;
  readonly subscriber_id: string | null;
  readonly status: PartnerStatus;
  readonly status_changed_at: Date;
  readonly partner_type: string;
  readonly requested_code: string | null;
  readonly university: string | null;
  readonly contract_sent_at: Date | null;
  /** `YYYY-MM-DD`, read as text so no time zone can shift it. */
  readonly contract_signed_at: string | null;
  readonly contract_version: string | null;
  readonly contract_reference: string | null;
  readonly notes: string | null;
  readonly personal_data_purged_at: Date | null;
  /** The partner code registered at approval, if any. */
  readonly code: string | null;
  readonly code_active: boolean | null;
}

export interface PartnerListFilter {
  readonly status: PartnerStatus | null;
  readonly partnerType: string | null;
  /** Applied on or after this instant (`--since`, D-052 Q4a). */
  readonly appliedSince: Date | null;
  /** Only partners whose status changed before this instant, in a waiting status. */
  readonly staleBefore: Date | null;
  readonly afterId: string | null;
}

export interface PartnerListRow {
  readonly id: string;
  readonly status: PartnerStatus;
  readonly partner_type: string;
  readonly full_name: string | null;
  readonly email: string | null;
  readonly code: string | null;
  readonly requested_code: string | null;
  readonly applied_at: Date;
  readonly status_changed_at: Date;
}

export interface PartnerDetailRow extends PartnerReviewRow {
  readonly email: string | null;
  readonly submitted_at: Date;
  readonly applied_at: Date | null;
  readonly full_name: string | null;
  readonly country_of_residence: string | null;
  readonly channels: string[] | null;
  readonly handles: string[] | null;
  readonly audience_size: string | null;
  readonly promotion_plan: string | null;
  readonly student_email: string | null;
  readonly company_name: string | null;
}

export interface PartnerReferralSummary {
  readonly confirmed: number;
  readonly pending: number;
  readonly voided: number;
  readonly flagged: number;
  /** The latest signup or confirmation among the partner's referrals (D-052 Q4b). */
  readonly last_activity_at: Date | null;
}

export interface PartnerFlaggedReferral {
  readonly referred_id: string;
  readonly state: string;
  readonly voided: boolean;
  readonly flag_kinds: string[];
}

export interface PartnerContractSigning {
  readonly signedOn: string;
  readonly version: string;
  readonly reference: string | null;
}

export interface PartnerReviewRepository {
  /** Locks the partner row for a command. Unconfirmed applications are never returned. */
  lock(id: string): Promise<PartnerReviewRow | null>;
  /** Registers the partner's code, inactive (D-044). False if the code is taken. */
  registerCode(code: string, partnerId: string): Promise<boolean>;
  /** Moves the status; extra columns are set only by their own transition. */
  transition(
    id: string,
    from: PartnerStatus,
    to: PartnerStatus,
    now: Date,
    contract?: { readonly sentAt: Date } | PartnerContractSigning,
  ): Promise<number>;
  setType(
    id: string,
    partnerType: string,
    university: string | null,
  ): Promise<number>;
  replaceNotes(id: string, notes: string): Promise<number>;
  list(
    filter: PartnerListFilter,
    limit: number,
  ): Promise<readonly PartnerListRow[]>;
  detail(id: string): Promise<PartnerDetailRow | null>;
  referralSummary(subscriberId: string): Promise<PartnerReferralSummary>;
  flaggedReferrals(
    subscriberId: string,
    limit: number,
  ): Promise<readonly PartnerFlaggedReferral[]>;
}

const reviewColumns = `
  p.id, p.subscriber_id, p.status, p.status_changed_at, p.partner_type,
  p.requested_code, p.university, p.contract_sent_at,
  to_char(p.contract_signed_at, 'YYYY-MM-DD') AS contract_signed_at,
  p.contract_version, p.contract_reference, p.notes,
  p.personal_data_purged_at, c.code, c.active AS code_active`;

const partnerCodeJoin = `
  LEFT JOIN referral_code c
    ON c.owner_kind = 'partner' AND c.owner_id = p.id`;

function assertLimit(limit: number, maximum: number, label: string): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`A ${label} limit must be between 1 and ${maximum}.`);
  }
}

export function createPartnerReviewRepository(
  database: DatabaseConnection,
): PartnerReviewRepository {
  return {
    lock(id) {
      return database.readOne<PartnerReviewRow>({
        text: `
          SELECT ${reviewColumns}
          FROM partner p ${partnerCodeJoin}
          WHERE p.id = $1 AND p.status <> 'unconfirmed'
          FOR UPDATE OF p
        `,
        values: [id],
      });
    },

    async registerCode(code, partnerId) {
      // DO NOTHING covers both a taken code and a code this partner already
      // holds, so the caller's transaction stays usable to report it.
      const inserted = await database.execute({
        text: `
          INSERT INTO referral_code (code, owner_kind, owner_id)
          VALUES ($1, 'partner', $2)
          ON CONFLICT DO NOTHING
        `,
        values: [code, partnerId],
      });
      return inserted === 1;
    },

    transition(id, from, to, now, contract) {
      const sentAt =
        contract !== undefined && 'sentAt' in contract ? contract.sentAt : null;
      const signing =
        contract !== undefined && 'signedOn' in contract ? contract : null;
      return database.execute({
        text: `
          UPDATE partner
          SET status = $3,
              status_changed_at = $4,
              contract_sent_at = CASE WHEN $5::boolean THEN $6::timestamptz
                ELSE contract_sent_at END,
              contract_signed_at = CASE WHEN $7::boolean THEN $8::date
                ELSE contract_signed_at END,
              contract_version = CASE WHEN $7::boolean THEN $9::text
                ELSE contract_version END,
              contract_reference = CASE WHEN $7::boolean THEN $10::text
                ELSE contract_reference END
          WHERE id = $1 AND status = $2 AND personal_data_purged_at IS NULL
        `,
        values: [
          id,
          from,
          to,
          now,
          sentAt !== null,
          sentAt,
          signing !== null,
          signing?.signedOn ?? null,
          signing?.version ?? null,
          signing?.reference ?? null,
        ],
      });
    },

    setType(id, partnerType, university) {
      return database.execute({
        text: `
          UPDATE partner
          SET partner_type = $2, university = COALESCE($3::text, university)
          WHERE id = $1 AND status <> 'unconfirmed'
            AND personal_data_purged_at IS NULL
        `,
        values: [id, partnerType, university],
      });
    },

    replaceNotes(id, notes) {
      return database.execute({
        text: `
          UPDATE partner SET notes = $2
          WHERE id = $1 AND status <> 'unconfirmed'
            AND personal_data_purged_at IS NULL
        `,
        values: [id, notes],
      });
    },

    list(filter, limit) {
      assertLimit(limit, partnerListPageLimit, 'partner list');
      return database.list<PartnerListRow>(
        {
          text: `
            SELECT p.id, p.status, p.partner_type, p.full_name, s.email,
              c.code, p.requested_code, p.applied_at, p.status_changed_at
            FROM partner p
            LEFT JOIN subscriber s ON s.id = p.subscriber_id
            ${partnerCodeJoin}
            WHERE p.status <> 'unconfirmed'
              AND ($1::text IS NULL OR p.status = $1)
              AND ($2::text IS NULL OR p.partner_type = $2)
              AND ($3::timestamptz IS NULL OR p.applied_at >= $3)
              AND ($4::timestamptz IS NULL OR (
                p.status IN ('applied', 'approved', 'contract_sent')
                AND p.status_changed_at < $4
              ))
              AND ($5::uuid IS NULL OR (p.applied_at, p.id) > (
                SELECT cursor.applied_at, cursor.id FROM partner cursor
                WHERE cursor.id = $5::uuid
              ))
            ORDER BY p.applied_at, p.id
          `,
          values: [
            filter.status,
            filter.partnerType,
            filter.appliedSince,
            filter.staleBefore,
            filter.afterId,
          ],
        },
        limit,
      );
    },

    detail(id) {
      return database.readOne<PartnerDetailRow>({
        text: `
          SELECT ${reviewColumns}, s.email, p.submitted_at, p.applied_at,
            p.full_name, p.country_of_residence, p.channels, p.handles,
            p.audience_size, p.promotion_plan, p.student_email, p.company_name
          FROM partner p
          LEFT JOIN subscriber s ON s.id = p.subscriber_id
          ${partnerCodeJoin}
          WHERE p.id = $1 AND p.status <> 'unconfirmed'
        `,
        values: [id],
      });
    },

    async referralSummary(subscriberId) {
      const row = await database.readOne<PartnerReferralSummary>({
        text: `
          SELECT
            count(*) FILTER (WHERE e.state = 'confirmed' AND e.voided_at IS NULL)::int
              AS confirmed,
            count(*) FILTER (WHERE e.state = 'attributed' AND e.voided_at IS NULL)::int
              AS pending,
            count(*) FILTER (WHERE e.voided_at IS NOT NULL)::int AS voided,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM fraud_flag f
              WHERE f.subscriber_id = e.referred_id AND f.state = 'open'
            ))::int AS flagged,
            GREATEST(max(e.created_at), max(e.confirmed_at)) AS last_activity_at
          FROM referral_edge e
          WHERE e.referrer_id = $1
        `,
        values: [subscriberId],
      });
      return (
        row ?? {
          confirmed: 0,
          pending: 0,
          voided: 0,
          flagged: 0,
          last_activity_at: null,
        }
      );
    },

    flaggedReferrals(subscriberId, limit) {
      assertLimit(limit, partnerFlaggedReferralLimit, 'flagged referral');
      return database.list<PartnerFlaggedReferral>(
        {
          text: `
            SELECT e.referred_id, e.state, e.voided_at IS NOT NULL AS voided,
              array_agg(DISTINCT f.kind ORDER BY f.kind) AS flag_kinds
            FROM referral_edge e
            JOIN fraud_flag f
              ON f.subscriber_id = e.referred_id AND f.state = 'open'
            WHERE e.referrer_id = $1
            GROUP BY e.id, e.referred_id, e.state, e.voided_at, e.created_at
            ORDER BY e.created_at, e.id
          `,
          values: [subscriberId],
        },
        limit,
      );
    },
  };
}

export interface PartnerExportRow {
  readonly id: string;
  readonly email: string;
  readonly email_normalised: string;
  readonly full_name: string;
  readonly status: PartnerStatus;
  readonly partner_type: string;
  readonly code: string | null;
  readonly contract_signed_at: string;
  readonly contract_version: string;
  readonly confirmed_referrals: number;
  readonly pending_referrals: number;
  readonly marketing_consent: boolean;
}

export interface PartnerExportSnapshot {
  readonly rowCount: number;
  page(
    afterId: string | null,
    limit: number,
  ): Promise<readonly PartnerExportRow[]>;
  close(): Promise<void>;
}

// Shared by the founder's review CSV and the automatic Brevo partner sync.
// A partner holds at most one code (uq_referral_code_partner_owner).
export const contractedPartnerRows = `
  FROM partner p
  JOIN subscriber s ON s.id = p.subscriber_id
  ${partnerCodeJoin}
  WHERE p.status IN ('active', 'paused', 'terminated')
    AND p.personal_data_purged_at IS NULL
    AND s.verified_at IS NOT NULL
    AND s.status NOT IN ('erasure_pending', 'erased')
    AND NOT EXISTS (
      SELECT 1 FROM suppression x WHERE x.email_normalised = s.email_normalised
    )`;

export const contractedPartnerColumns = `
  p.id, s.email, s.email_normalised, p.full_name, p.status,
  p.partner_type, c.code,
  to_char(p.contract_signed_at, 'YYYY-MM-DD') AS contract_signed_at,
  p.contract_version,
  (SELECT count(*) FROM referral_edge e
    WHERE e.referrer_id = p.subscriber_id
      AND e.state = 'confirmed' AND e.voided_at IS NULL
  )::int AS confirmed_referrals,
  (SELECT count(*) FROM referral_edge e
    WHERE e.referrer_id = p.subscriber_id
      AND e.state = 'attributed' AND e.voided_at IS NULL
  )::int AS pending_referrals,
  s.marketing_consent_at IS NOT NULL AS marketing_consent`;

/**
 * One repeatable-read, read-only snapshot of the partners export, counted
 * before the first row is read so the audit records the exact row count.
 */
export async function openPartnerExportSnapshot(
  database: DatabasePool,
): Promise<PartnerExportSnapshot> {
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

  try {
    await connection.execute({
      text: 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    });
    const count = await connection.readOne<{ row_count: number }>({
      text: `SELECT count(*)::int AS row_count ${contractedPartnerRows}`,
    });
    if (count === null) {
      throw new Error('Partner export snapshot count was unavailable.');
    }
    return {
      rowCount: count.row_count,
      async page(afterId, limit) {
        if (closed) throw new Error('Partner export snapshot is closed.');
        assertLimit(limit, partnerExportBatchSize, 'partner export page');
        return connection.list<PartnerExportRow>(
          {
            text: `
              SELECT ${contractedPartnerColumns}
              ${contractedPartnerRows}
                AND ($1::uuid IS NULL OR p.id > $1::uuid)
              ORDER BY p.id
            `,
            values: [afterId],
          },
          limit,
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
