import type { DatabaseConnection } from './pool.ts';

export interface GiveawayEntryRepository {
  lockSubscriber(subscriberId: string): Promise<{
    status: string;
    giveawayRulesVersion: string | null;
    verifiedAt: Date | null;
  } | null>;
  confirmedEdgeBelongsTo(
    sourceEdgeId: string,
    referrerId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<boolean>;
  insertEntry(input: {
    id: string;
    subscriberId: string;
    method: 'base' | 'referral';
    sourceEdgeId: string | null;
    rulesVersion: string;
    rulesSha256: Buffer;
  }): Promise<number>;
  stampFirstRulesVersion(
    subscriberId: string,
    rulesVersion: string,
  ): Promise<number>;
  confirmedEdgeFor(
    referredId: string,
  ): Promise<{ id: string; referrerId: string } | null>;
  missingEntitlements(
    start: Date,
    end: Date,
    limit: number,
  ): Promise<
    readonly {
      subscriberId: string;
      method: 'base' | 'referral';
      sourceEdgeId: string | null;
    }[]
  >;
}

export function createGiveawayEntryRepository(
  database: DatabaseConnection,
): GiveawayEntryRepository {
  return {
    async lockSubscriber(subscriberId) {
      const row = await database.readOne<{
        status: string;
        giveaway_rules_version: string | null;
        verified_at: Date | null;
      }>({
        text: `SELECT status, giveaway_rules_version, verified_at FROM subscriber
               WHERE id = $1 FOR UPDATE`,
        values: [subscriberId],
      });
      return row === null
        ? null
        : {
            status: row.status,
            giveawayRulesVersion: row.giveaway_rules_version,
            verifiedAt: row.verified_at,
          };
    },
    async confirmedEdgeBelongsTo(
      sourceEdgeId,
      referrerId,
      periodStart,
      periodEnd,
    ) {
      const row = await database.readOne<{ present: boolean }>({
        text: `SELECT EXISTS (
                 SELECT 1 FROM referral_edge
                 WHERE id = $1 AND referrer_id = $2 AND state = 'confirmed'
                   AND confirmed_at >= $3 AND confirmed_at < $4
               ) AS present`,
        values: [sourceEdgeId, referrerId, periodStart, periodEnd],
      });
      return row?.present ?? false;
    },
    insertEntry(input) {
      return database.execute({
        text: `INSERT INTO giveaway_entry
                 (id, subscriber_id, method, entries, rules_version,
                  rules_sha256, source_edge_id)
               VALUES ($1, $2, $3, 1, $4, $5, $6)
               ON CONFLICT ON CONSTRAINT uq_giveaway_entry_subscriber_method_source_edge
               DO NOTHING`,
        values: [
          input.id,
          input.subscriberId,
          input.method,
          input.rulesVersion,
          input.rulesSha256,
          input.sourceEdgeId,
        ],
      });
    },
    stampFirstRulesVersion(subscriberId, rulesVersion) {
      return database.execute({
        text: `UPDATE subscriber SET giveaway_rules_version = $2
               WHERE id = $1 AND giveaway_rules_version IS NULL`,
        values: [subscriberId, rulesVersion],
      });
    },
    async confirmedEdgeFor(referredId) {
      const row = await database.readOne<{ id: string; referrer_id: string }>({
        text: `SELECT id::text, referrer_id::text FROM referral_edge
               WHERE referred_id = $1 AND state = 'confirmed'`,
        values: [referredId],
      });
      return row === null ? null : { id: row.id, referrerId: row.referrer_id };
    },
    async missingEntitlements(start, end, limit) {
      const rows = await database.list<{
        subscriber_id: string;
        method: 'base' | 'referral';
        source_edge_id: string | null;
      }>(
        {
          text: `SELECT subscriber_id, method, source_edge_id FROM (
          SELECT s.id AS subscriber_id, 'base'::text AS method,
                 NULL::uuid AS source_edge_id, s.verified_at AS earned_at
          FROM subscriber s
          WHERE s.status = 'verified' AND s.verified_at >= $1
            AND s.verified_at < $2
            AND NOT EXISTS (
              SELECT 1 FROM giveaway_entry ge
              WHERE ge.subscriber_id = s.id AND ge.method = 'base'
            )
          UNION ALL
          SELECT e.referrer_id AS subscriber_id, 'referral'::text AS method,
                 e.id AS source_edge_id, e.confirmed_at AS earned_at
          FROM referral_edge e
          JOIN subscriber s ON s.id = e.referrer_id
          JOIN subscriber referred ON referred.id = e.referred_id
          WHERE e.state = 'confirmed' AND e.confirmed_at >= $1
            AND e.confirmed_at < $2 AND s.status = 'verified'
            AND s.verified_at >= $1 AND s.verified_at < $2
            AND referred.verified_at >= $1 AND referred.verified_at < $2
            AND NOT EXISTS (
              SELECT 1 FROM giveaway_entry ge
              WHERE ge.subscriber_id = e.referrer_id AND ge.method = 'referral'
                AND ge.source_edge_id = e.id
            )
        ) entitled ORDER BY earned_at, subscriber_id, method, source_edge_id`,
          values: [start, end],
        },
        limit,
      );
      return rows.map((row) => ({
        subscriberId: row.subscriber_id,
        method: row.method,
        sourceEdgeId: row.source_edge_id,
      }));
    },
  };
}
