import type { DatabaseConnection } from './pool.ts';

export function createEmailTemplateRepository(database: DatabaseConnection) {
  return {
    async statusTokenSubject(tokenId: string): Promise<string | null> {
      const row = await database.readOne<{ subscriber_id: string }>({
        text: `SELECT subscriber_id::text FROM verification_token
          WHERE id = $1 AND purpose = 'status'`,
        values: [tokenId],
      });
      return row?.subscriber_id ?? null;
    },
    /**
     * Whether the subscriber's confirmed, non-voided referral edge points to
     * another member and not to a partner (E11.8-04). Only the answer leaves
     * the query: no identifier, code or other detail of the referrer.
     */
    async memberReferred(subscriberId: string): Promise<boolean> {
      const row = await database.readOne<{ referred: boolean }>({
        text: `SELECT EXISTS (
            SELECT 1 FROM referral_edge
            WHERE referred_id = $1 AND state = 'confirmed'
              AND voided_at IS NULL AND partner_id IS NULL
              AND referrer_id IS NOT NULL AND referrer_id <> referred_id
          ) AS referred`,
        values: [subscriberId],
      });
      return row?.referred === true;
    },
    async receiptEntries(
      subscriberId: string,
      rulesVersion: string,
    ): Promise<number> {
      const row = await database.readOne<{ entries: string }>({
        text: `SELECT count(*)::text AS entries FROM giveaway_entry
          WHERE subscriber_id = $1 AND rules_version = $2
            AND voided_at IS NULL`,
        values: [subscriberId, rulesVersion],
      });
      return Number(row?.entries ?? 0);
    },
    winnerDetails(
      awardId: string,
      subscriberId: string,
    ): Promise<{
      deadline: Date;
      rulesVersion: string;
    } | null> {
      return database.readOne({
        text: `SELECT a.response_deadline_at AS deadline,
            d.rules_version AS "rulesVersion"
          FROM giveaway_award a
          JOIN giveaway_draw d ON d.id = a.draw_id
          WHERE a.id = $1 AND a.subscriber_id = $2
            AND a.state = 'notified' AND d.state = 'published'`,
        values: [awardId, subscriberId],
      });
    },
  };
}
