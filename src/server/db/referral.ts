import type { DatabaseConnection } from './pool.ts';
import type { AccessWindow } from '../referral/config.ts';
import { countedSubscriberStatus } from './subscriber-maintenance.ts';

export interface ReferralEdgeForConfirmation {
  readonly id: string;
  readonly referrer_id: string;
}

export interface ReferralSubscriber {
  readonly access_window: AccessWindow | null;
  readonly confirmed_referrals: number;
  readonly referral_code: string | null;
  readonly referral_tier: number;
  readonly status: string;
}

export interface ReferralRepository {
  assignReferralCode(subscriberId: string, code: string): Promise<number>;
  assignReferrer(referredId: string, referrerId: string): Promise<number>;
  confirmEdge(referredId: string, now: Date): Promise<number>;
  countConfirmedEdges(referrerId: string): Promise<number>;
  findCode(subscriberId: string): Promise<string | null>;
  findEdgeForConfirmation(
    referredId: string,
  ): Promise<ReferralEdgeForConfirmation | null>;
  findSubscriber(subscriberId: string): Promise<ReferralSubscriber | null>;
  findSubscriberIdByCode(code: string): Promise<string | null>;
  findStrandedVerifiedReferralIds(limit: number): Promise<readonly string[]>;
  insertMilestoneAward(
    id: string,
    subscriberId: string,
    tier: number,
    rewardKind: 'discount' | 'entries' | 'wave_upgrade',
    state: 'held' | 'settled',
    now: Date,
  ): Promise<number>;
  insertAttributedEdge(
    id: string,
    referrerId: string,
    referredId: string,
  ): Promise<number>;
  setAccessWindow(subscriberId: string, window: AccessWindow): Promise<number>;
  setReferralCounterAndTier(
    subscriberId: string,
    confirmedReferrals: number,
    tier: number,
  ): Promise<number>;
  verificationOrder(subscriberId: string, verifiedAt: Date): Promise<number>;
}

export function createReferralRepository(
  database: DatabaseConnection,
): ReferralRepository {
  return {
    async assignReferralCode(subscriberId, code) {
      return database.execute({
        text: `
          UPDATE subscriber
          SET referral_code = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
            AND status = 'verified'
            AND referral_code IS NULL
        `,
        values: [subscriberId, code],
      });
    },

    async assignReferrer(referredId, referrerId) {
      return database.execute({
        text: `
          UPDATE subscriber
          SET referred_by_id = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND referred_by_id IS NULL
        `,
        values: [referredId, referrerId],
      });
    },

    async confirmEdge(referredId, now) {
      return database.execute({
        text: `
          UPDATE referral_edge
          SET state = 'confirmed', reward_state = 'settled', confirmed_at = $2
          WHERE referred_id = $1 AND state = 'attributed'
        `,
        values: [referredId, now],
      });
    },

    async countConfirmedEdges(referrerId) {
      const row = await database.readOne<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM referral_edge
          WHERE referrer_id = $1 AND state = 'confirmed'
        `,
        values: [referrerId],
      });
      return Number(row?.count ?? '0');
    },

    async findCode(subscriberId) {
      const row = await database.readOne<{ referral_code: string | null }>({
        text: 'SELECT referral_code FROM subscriber WHERE id = $1',
        values: [subscriberId],
      });
      return row?.referral_code ?? null;
    },

    async findEdgeForConfirmation(referredId) {
      return database.readOne<ReferralEdgeForConfirmation>({
        text: `
          SELECT id, referrer_id
          FROM referral_edge
          WHERE referred_id = $1 AND state = 'attributed'
        `,
        values: [referredId],
      });
    },

    async findSubscriber(subscriberId) {
      return database.readOne<ReferralSubscriber>({
        text: `
          SELECT status, referral_code, confirmed_referrals, referral_tier, access_window
          FROM subscriber
          WHERE id = $1
        `,
        values: [subscriberId],
      });
    },

    async findSubscriberIdByCode(code) {
      const row = await database.readOne<{ id: string }>({
        text: 'SELECT id FROM subscriber WHERE LOWER(referral_code) = LOWER($1)',
        values: [code],
      });
      return row?.id ?? null;
    },

    async findStrandedVerifiedReferralIds(limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(
          'A referral reconciliation limit must be positive.',
        );
      }
      const rows = await database.list<{ referred_id: string }>(
        {
          text: `
            SELECT edge.referred_id
            FROM referral_edge edge
            JOIN subscriber referred ON referred.id = edge.referred_id
            WHERE edge.state = 'attributed'
              AND referred.status = 'verified'
            ORDER BY edge.created_at, edge.id
          `,
        },
        limit,
      );
      return rows.map((row) => row.referred_id);
    },

    async insertMilestoneAward(id, subscriberId, tier, rewardKind, state, now) {
      return database.execute({
        text: `
          INSERT INTO milestone_award (id, subscriber_id, tier, reward_kind, state, awarded_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (subscriber_id, tier, reward_kind) DO NOTHING
        `,
        values: [id, subscriberId, tier, rewardKind, state, now],
      });
    },

    async insertAttributedEdge(id, referrerId, referredId) {
      return database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state
          )
          VALUES ($1, $2, $3, 'attributed', 'none')
          ON CONFLICT (referred_id) DO NOTHING
        `,
        values: [id, referrerId, referredId],
      });
    },

    async setAccessWindow(subscriberId, window) {
      return database.execute({
        text: `
          UPDATE subscriber
          SET access_window = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
        values: [subscriberId, window],
      });
    },

    async setReferralCounterAndTier(subscriberId, confirmedReferrals, tier) {
      return database.execute({
        text: `
          UPDATE subscriber
          SET confirmed_referrals = $2, referral_tier = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
        values: [subscriberId, confirmedReferrals, tier],
      });
    },

    async verificationOrder(subscriberId, verifiedAt) {
      const row = await database.readOne<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM subscriber
          WHERE status = $3
            AND (verified_at < $2 OR (verified_at = $2 AND id <= $1::uuid))
        `,
        values: [subscriberId, verifiedAt, countedSubscriberStatus],
      });
      return Number(row?.count ?? '0');
    },
  };
}
