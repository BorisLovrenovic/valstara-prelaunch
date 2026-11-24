import type { DatabaseConnection } from './pool.ts';

// E11.7-12: the candidates for the auto-invite and the partner's first-signup
// email. Each email's business key is the record that it was sent: one per
// member and one per partner, ever. Suppressed addresses are left out here,
// not later, so they cannot fill every batch.

export interface InviteCandidate {
  readonly subscriber_id: string;
}

export interface FirstSignupCandidate {
  readonly partner_id: string;
  readonly subscriber_id: string;
}

/**
 * A member is invited once they hold the threshold of confirmed, non-voided
 * referrals, are verified, have current marketing consent (ADR-027), and have
 * no partner application or partnership of their own: an invitation to apply
 * is not sent to someone who already did.
 */
const inviteEligible = `s.status = 'verified'
  AND s.marketing_consent_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM partner p WHERE p.subscriber_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM suppression x
    WHERE x.email_normalised = s.email_normalised)
  AND (SELECT count(*) FROM referral_edge e
    WHERE e.referrer_id = s.id AND e.state = 'confirmed'
      AND e.voided_at IS NULL) >= $1`;

/**
 * A partner is due once one confirmed, non-voided signup is credited to them
 * as a partner, while they can open their dashboard (active or paused), after
 * their welcome was queued, so the mails arrive in order.
 */
const firstSignupEligible = `p.status IN ('active', 'paused')
  AND p.personal_data_purged_at IS NULL
  AND s.status = 'verified'
  AND EXISTS (SELECT 1 FROM email_send w
    WHERE w.business_key = 'partner-welcome:' || p.id::text)
  AND EXISTS (SELECT 1 FROM referral_edge e
    WHERE e.partner_id = p.id AND e.state = 'confirmed'
      AND e.voided_at IS NULL)`;

export function createPartnerMilestoneMailRepository(
  database: DatabaseConnection,
) {
  return {
    findInviteDue(threshold: number, limit: number) {
      // `confirmed_referrals` is the indexed, recomputed count; the exact
      // edge count decides.
      return database.list<InviteCandidate>(
        {
          text: `SELECT s.id AS subscriber_id FROM subscriber s
            WHERE s.confirmed_referrals >= $1 AND ${inviteEligible}
              AND NOT EXISTS (SELECT 1 FROM email_send m
                WHERE m.business_key = 'partner-invite:' || s.id::text)
            ORDER BY s.id`,
          values: [threshold],
        },
        limit,
      );
    },

    /** Locks the member and re-checks eligibility inside the queueing transaction. */
    lockInviteEligible(subscriberId: string, threshold: number) {
      return database.readOne<{ id: string }>({
        text: `SELECT s.id FROM subscriber s
          WHERE s.id = $2 AND ${inviteEligible}
          FOR UPDATE OF s`,
        values: [threshold, subscriberId],
      });
    },

    findFirstSignupDue(limit: number) {
      return database.list<FirstSignupCandidate>(
        {
          text: `SELECT p.id AS partner_id, p.subscriber_id
            FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
            WHERE ${firstSignupEligible}
              AND NOT EXISTS (SELECT 1 FROM email_send m
                WHERE m.business_key = 'partner-first-signup:' || p.id::text)
              AND NOT EXISTS (SELECT 1 FROM suppression x
                WHERE x.email_normalised = s.email_normalised)
            ORDER BY p.id`,
        },
        limit,
      );
    },

    /** The caller holds the subscriber lock first, as activation does. */
    lockFirstSignupEligible(partnerId: string, subscriberId: string) {
      return database.readOne<{ id: string }>({
        text: `SELECT p.id FROM partner p
          JOIN subscriber s ON s.id = p.subscriber_id
          WHERE p.id = $1 AND p.subscriber_id = $2 AND ${firstSignupEligible}
          FOR UPDATE OF p`,
        values: [partnerId, subscriberId],
      });
    },

    lockSubscriber(subscriberId: string) {
      return database.readOne<{ id: string }>({
        text: `SELECT id FROM subscriber WHERE id = $1
          AND status NOT IN ('erasure_pending', 'erased') FOR UPDATE`,
        values: [subscriberId],
      });
    },
  };
}
