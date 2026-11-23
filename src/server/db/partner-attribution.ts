import type { DatabaseConnection } from './pool.ts';

interface CodeOwner {
  readonly referrer_id: string;
  readonly owner_kind: 'member' | 'partner';
}

interface LivePartner {
  readonly id: string;
  readonly partner_type: string;
}

interface PartnerWork {
  readonly partner_id: string;
  readonly referrer_id: string;
}

interface RetroactiveEdge extends PartnerWork {
  readonly id: string;
  readonly referred_id: string;
}

export interface PartnerPerks {
  readonly active_partner: boolean;
  readonly welcome_discount_pct: number | null;
  readonly welcome_partner_code: string | null;
}

const eligiblePartner = `
  p.status = 'active' AND p.personal_data_purged_at IS NULL
  AND s.status = 'verified'
`;

const partnerCode = `
  JOIN referral_code c ON c.owner_kind = 'partner' AND c.owner_id = p.id
`;

// Fraud review rejects the referrer's edges for credit. The edge's prior
// confirmation still establishes what the friend earned.
export const earnedPartnerPerkEdge = `
  e.welcome_discount_pct IS NOT NULL AND e.voided_at IS NULL
  AND (e.state = 'confirmed' OR (
    e.state = 'rejected' AND e.rejected_reason = 'referrer_disqualified'
    AND e.state_before_rejection = 'confirmed'
  ))
`;

const retroactiveEdges = `
  FROM referral_edge e
  JOIN subscriber friend ON friend.id = e.referred_id
  JOIN subscriber s ON s.id = e.referrer_id
  JOIN partner p ON p.subscriber_id = s.id
  ${partnerCode}
  WHERE ${eligiblePartner} AND c.active
    AND e.partner_id IS NULL AND e.state = 'confirmed' AND e.voided_at IS NULL
    AND friend.status = 'verified'
    AND EXISTS (
      SELECT 1 FROM audit_log approval
      WHERE approval.subject_type = 'partner' AND approval.action = 'partner.approved'
        AND approval.subject_id = p.id::text
        AND friend.created_at < (approval.detail #>> '{after,status_changed_at}')::timestamptz
    )
`;

export function createPartnerAttributionRepository(db: DatabaseConnection) {
  return {
    findPerks(subscriberId: string) {
      return db.readOne<PartnerPerks>({
        text: `
          SELECT EXISTS (
            SELECT 1 FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
            ${partnerCode}
            WHERE p.subscriber_id = $1 AND ${eligiblePartner} AND c.active
          ) AS active_partner, COALESCE(earned.welcome_discount_pct,
            retained.welcome_discount_pct) AS welcome_discount_pct,
            earned.code AS welcome_partner_code
          FROM (SELECT $1::uuid AS subscriber_id) subject
          LEFT JOIN LATERAL (
            SELECT e.welcome_discount_pct, c.code
            FROM referral_edge e
            LEFT JOIN referral_code c
              ON c.owner_kind = 'partner' AND c.owner_id = e.partner_id
            WHERE e.referred_id = subject.subscriber_id AND ${earnedPartnerPerkEdge}
          ) earned ON true
          LEFT JOIN retained_partner_entitlement retained
            ON retained.subscriber_id = subject.subscriber_id AND retained.wave_one
        `,
        values: [subscriberId],
      });
    },

    findCodeOwner(code: string) {
      return db.readOne<CodeOwner>({
        text: `
          SELECT c.owner_kind, s.id AS referrer_id
          FROM referral_code c
          LEFT JOIN partner p ON c.owner_kind = 'partner' AND c.owner_id = p.id
          JOIN subscriber s ON s.id = CASE WHEN c.owner_kind = 'member'
            THEN c.owner_id ELSE p.subscriber_id END
          WHERE c.code = $1 AND c.active AND (
            c.owner_kind = 'member' OR p.status = 'active'
          ) AND s.status NOT IN ('erasure_pending', 'erased')
        `,
        values: [code],
      });
    },

    findLivePartner(referrerId: string, code: string | null) {
      return db.readOne<LivePartner>({
        text: `
          SELECT p.id, p.partner_type
          FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
          ${partnerCode}
          WHERE p.subscriber_id = $1 AND ${eligiblePartner}
            AND c.active AND ($2::text IS NULL OR c.code = $2)
        `,
        values: [referrerId, code],
      });
    },

    findLiveShortCode(code: string) {
      return db.readOne<{ code: string }>({
        text: `
          SELECT c.code
          FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
          ${partnerCode}
          WHERE c.code = $1 AND c.active AND ${eligiblePartner}
        `,
        values: [code],
      });
    },

    findDeferredPartners(limit: number) {
      return db.list<PartnerWork>(
        {
          text: `
          SELECT p.id AS partner_id, p.subscriber_id AS referrer_id
          FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
          ${partnerCode}
          WHERE ${eligiblePartner} AND NOT c.active
          ORDER BY p.id
        `,
        },
        limit,
      );
    },

    async setCodeActive(partnerId: string, active: boolean) {
      await db.readOne({
        text: 'SELECT set_partner_code_active($1, $2)',
        values: [partnerId, active],
      });
    },

    findRetroactiveEdges(limit: number) {
      return db.list<RetroactiveEdge>(
        {
          text: `
          SELECT e.id, e.referred_id, e.referrer_id, p.id AS partner_id
          ${retroactiveEdges}
          ORDER BY e.id
        `,
        },
        limit,
      );
    },

    findRetroactiveSignup(edgeId: string, partnerId: string) {
      return db.readOne<{
        signup_confirmed_count: number | null;
        partner_type: string;
      }>({
        text: `
          SELECT e.signup_confirmed_count, p.partner_type
          ${retroactiveEdges}
          AND e.id = $1 AND p.id = $2
          FOR UPDATE OF e FOR SHARE OF p
        `,
        values: [edgeId, partnerId],
      });
    },

    async countAtLegacySignup(edgeId: string) {
      const row = await db.readOne<{ count: number }>({
        text: `
          SELECT count(*)::int AS count
          FROM referral_edge target
          JOIN subscriber friend ON friend.id = target.referred_id
          JOIN referral_edge prior ON prior.referrer_id = target.referrer_id
          WHERE target.id = $1 AND prior.id <> target.id
            AND prior.state = 'confirmed' AND prior.confirmed_at < friend.created_at
            AND (prior.voided_at IS NULL OR prior.voided_at > friend.created_at)
            AND NOT EXISTS (
              SELECT 1 FROM audit_log v
              CROSS JOIN LATERAL (
                SELECT (v.detail #>> '{after,voided_at}')::timestamptz AS started_at
              ) interval_start
              CROSS JOIN LATERAL (
                SELECT max(GREATEST(u.at, interval_start.started_at)) AS ended_at
                FROM audit_log u
                WHERE u.subject_type = 'referral_edge' AND u.subject_id = v.subject_id
                  AND u.action = 'referral.unvoided'
                  AND (u.detail #>> '{before,voided_at}')::timestamptz = interval_start.started_at
              ) interval_end
              WHERE v.subject_type = 'referral_edge' AND v.subject_id = prior.id::text
                AND v.action = 'referral.voided'
                AND interval_start.started_at <= friend.created_at
                AND (interval_end.ended_at IS NULL OR interval_end.ended_at >= friend.created_at)
            )
        `,
        values: [edgeId],
      });
      return row?.count ?? 0;
    },

    attributeRetroactively(
      edgeId: string,
      partnerId: string,
      discount: number,
    ) {
      return db.execute({
        text: `
          UPDATE referral_edge SET partner_id = $2, attribution_method = 'retroactive',
            welcome_discount_pct = $3
          WHERE id = $1 AND partner_id IS NULL AND state = 'confirmed' AND voided_at IS NULL
        `,
        values: [edgeId, partnerId, discount],
      });
    },
  };
}
