import type { DatabaseConnection } from './pool.ts';

// E11.7-11 (D-057): the partner welcome's candidates. A partner is due once
// they are active, their code is live and their member record can receive
// mail, until a welcome exists under their business key. The business key is
// the record that it was sent: one per partner, ever.

export interface WelcomeCandidate {
  readonly partner_id: string;
  readonly subscriber_id: string;
}

export interface WelcomeRecipient {
  readonly id: string;
  readonly subscriber_id: string;
}

const eligible = `p.status = 'active' AND p.personal_data_purged_at IS NULL
  AND s.status = 'verified' AND c.active`;

const owner = `FROM partner p
  JOIN subscriber s ON s.id = p.subscriber_id
  JOIN referral_code c ON c.owner_kind = 'partner' AND c.owner_id = p.id`;

export function createPartnerWelcomeRepository(database: DatabaseConnection) {
  return {
    /**
     * Suppressed addresses are left out here, not later, so they cannot fill
     * every batch; one that is unsuppressed becomes due again.
     */
    findDue(limit: number) {
      return database.list<WelcomeCandidate>(
        {
          text: `SELECT p.id AS partner_id, p.subscriber_id
            ${owner}
            WHERE ${eligible}
              AND NOT EXISTS (
                SELECT 1 FROM email_send e
                WHERE e.business_key = 'partner-welcome:' || p.id::text
              )
              AND NOT EXISTS (
                SELECT 1 FROM suppression x
                WHERE x.email_normalised = s.email_normalised
              )
            ORDER BY p.id`,
        },
        limit,
      );
    },

    /** The caller holds the subscriber lock first, as activation does. */
    lockEligible(partnerId: string, subscriberId: string) {
      return database.readOne<WelcomeRecipient>({
        text: `SELECT p.id, p.subscriber_id
          ${owner}
          WHERE p.id = $1 AND p.subscriber_id = $2 AND ${eligible}
          FOR UPDATE OF p`,
        values: [partnerId, subscriberId],
      });
    },

    /**
     * The welcome's code, read at dispatch from its link's owner, because a
     * queued payload holds only references. A partner who was terminated or
     * erased since has none, and the mail fails instead of sending.
     */
    async codeForDashboardToken(tokenId: string) {
      const row = await database.readOne<{ code: string }>({
        text: `SELECT c.code FROM verification_token t
          JOIN partner p ON p.subscriber_id = t.subscriber_id
          JOIN referral_code c ON c.owner_kind = 'partner' AND c.owner_id = p.id
          WHERE t.id = $1 AND t.purpose = 'partner_dashboard'
            AND p.status IN ('active', 'paused')
            AND p.personal_data_purged_at IS NULL`,
        values: [tokenId],
      });
      return row?.code ?? null;
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
