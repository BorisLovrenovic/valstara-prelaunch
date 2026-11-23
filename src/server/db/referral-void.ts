import type { DatabaseConnection } from './pool.ts';

// E11.7-02: the SQL behind voiding and un-voiding one referral. The service
// (src/server/referral/void.ts) owns the order of locks and the audit record.

export interface ReferralVoidEdgeRow {
  readonly id: string;
  readonly referrer_id: string | null;
  readonly referred_id: string | null;
  readonly partner_id: string | null;
  readonly state: 'attributed' | 'confirmed' | 'rejected';
  readonly voided_at: Date | null;
  readonly void_reason: string | null;
  readonly voided_by: string | null;
}

export interface ReferralVoidReferrerRow {
  readonly status: string;
  readonly confirmed_referrals: number;
}

export interface ReferralVoidRepository {
  /** The one edge for a referred person, without a lock. */
  findEdgeByReferred(referredId: string): Promise<ReferralVoidEdgeRow | null>;
  lockReferrer(referrerId: string): Promise<ReferralVoidReferrerRow | null>;
  lockEdge(edgeId: string): Promise<ReferralVoidEdgeRow | null>;
  markVoided(
    edgeId: string,
    voidedAt: Date,
    reason: string,
    actor: string,
  ): Promise<number>;
  clearVoid(edgeId: string): Promise<number>;
  /** True once any draw has committed its entry snapshot, aborted included. */
  drawSnapshotCommitted(): Promise<boolean>;
  /** The edge's referral entry: null when none has accrued. */
  entryVoided(edgeId: string): Promise<boolean | null>;
  voidEdgeEntry(edgeId: string, voidedAt: Date): Promise<number>;
  restoreEdgeEntry(edgeId: string): Promise<number>;
}

const edgeColumns = `id::text, referrer_id::text, referred_id::text, partner_id::text, state,
  voided_at, void_reason, voided_by`;

export function createReferralVoidRepository(
  database: DatabaseConnection,
): ReferralVoidRepository {
  return {
    findEdgeByReferred(referredId) {
      return database.readOne<ReferralVoidEdgeRow>({
        text: `SELECT ${edgeColumns} FROM referral_edge WHERE referred_id = $1`,
        values: [referredId],
      });
    },
    lockReferrer(referrerId) {
      return database.readOne<ReferralVoidReferrerRow>({
        text: `SELECT status, confirmed_referrals FROM subscriber
               WHERE id = $1 FOR UPDATE`,
        values: [referrerId],
      });
    },
    lockEdge(edgeId) {
      return database.readOne<ReferralVoidEdgeRow>({
        text: `SELECT ${edgeColumns} FROM referral_edge WHERE id = $1 FOR UPDATE`,
        values: [edgeId],
      });
    },
    markVoided(edgeId, voidedAt, reason, actor) {
      return database.execute({
        text: `UPDATE referral_edge
               SET voided_at = $2, void_reason = $3, voided_by = $4
               WHERE id = $1 AND voided_at IS NULL`,
        values: [edgeId, voidedAt, reason, actor],
      });
    },
    clearVoid(edgeId) {
      return database.execute({
        text: `UPDATE referral_edge
               SET voided_at = NULL, void_reason = NULL, voided_by = NULL
               WHERE id = $1 AND voided_at IS NOT NULL`,
        values: [edgeId],
      });
    },
    async drawSnapshotCommitted() {
      const row = await database.readOne<{ committed: boolean }>({
        text: `SELECT EXISTS (
                 SELECT 1 FROM giveaway_draw
                 WHERE snapshot_committed_at IS NOT NULL
               ) AS committed`,
      });
      return row?.committed ?? false;
    },
    async entryVoided(edgeId) {
      const row = await database.readOne<{ voided: boolean }>({
        text: `SELECT voided_at IS NOT NULL AS voided FROM giveaway_entry
               WHERE source_edge_id = $1 AND method = 'referral'`,
        values: [edgeId],
      });
      return row?.voided ?? null;
    },
    voidEdgeEntry(edgeId, voidedAt) {
      return database.execute({
        text: `UPDATE giveaway_entry
               SET voided_at = $2, voided_by_referral_void = true
               WHERE source_edge_id = $1 AND method = 'referral'
                 AND voided_at IS NULL`,
        values: [edgeId, voidedAt],
      });
    },
    restoreEdgeEntry(edgeId) {
      return database.execute({
        text: `UPDATE giveaway_entry
               SET voided_by_referral_void = false,
                   voided_at = CASE
                     WHEN voided_by_disqualification_flag_id IS NULL THEN NULL
                     ELSE voided_at
                   END
               WHERE source_edge_id = $1 AND method = 'referral'
                 AND voided_by_referral_void`,
        values: [edgeId],
      });
    },
  };
}
