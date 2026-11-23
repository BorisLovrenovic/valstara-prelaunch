import type { DatabaseConnection } from './pool.ts';
import type { AccessWindow } from '../referral/config.ts';
import type { ConfirmationRewardState } from '../referral/reward-state.ts';
import { countedSubscriberStatus } from './subscriber-maintenance.ts';

export interface ReferralEdgeForConfirmation {
  readonly id: string;
  readonly referrer_id: string;
  readonly partner_id: string | null;
}

export interface ReferralStatusAward {
  readonly reward_kind: 'discount' | 'entries' | 'merch' | 'wave_upgrade';
  readonly state: 'held' | 'settled';
  readonly tier: number;
}

export interface ReferralSubscriber {
  readonly access_window: AccessWindow | null;
  readonly confirmed_referrals: number;
  readonly referral_code: string | null;
  readonly referral_tier: number;
  readonly status: string;
  readonly verification_order_window: AccessWindow | null;
}

export interface ReferralRepository {
  assignReferralCode(subscriberId: string, code: string): Promise<number>;
  assignReferrer(referredId: string, referrerId: string): Promise<number>;
  confirmEdge(
    referredId: string,
    rewardState: ConfirmationRewardState,
    now: Date,
  ): Promise<number>;
  countConfirmedEdges(referrerId: string): Promise<number>;
  findCode(subscriberId: string): Promise<string | null>;
  findGiveawayEntryTotal(subscriberId: string): Promise<number>;
  findOwnReferralRank(subscriberId: string): Promise<number | null>;
  findActiveMilestoneAwards(
    subscriberId: string,
    limit: number,
  ): Promise<readonly ReferralStatusAward[]>;
  findEdgeForConfirmation(
    referredId: string,
  ): Promise<ReferralEdgeForConfirmation | null>;
  findSubscriber(subscriberId: string): Promise<ReferralSubscriber | null>;
  findSettledReferralTier(subscriberId: string): Promise<number>;
  findSubscriberIdsForCounterRepair(limit: number): Promise<readonly string[]>;
  findStrandedVerifiedReferralIds(limit: number): Promise<readonly string[]>;
  insertAttributedEdge(
    id: string,
    referrerId: string,
    referredId: string,
    signupConfirmedCount: number,
    partner: { readonly id: string; readonly discount: number } | null,
  ): Promise<number>;
  lockAccessWindowAssignment(): Promise<void>;
  lockSubscriber(subscriberId: string): Promise<ReferralSubscriber | null>;
  repairReferralCounterAndTier(
    subscriberId: string,
    confirmedReferrals: number,
    tier: number,
  ): Promise<boolean>;
  verificationOrder(): Promise<number>;
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

    async confirmEdge(referredId, rewardState, now) {
      return database.execute({
        text: `
          UPDATE referral_edge
          SET state = 'confirmed', reward_state = $2, confirmed_at = $3
          WHERE referred_id = $1 AND state = 'attributed'
        `,
        values: [referredId, rewardState, now],
      });
    },

    async countConfirmedEdges(referrerId) {
      const row = await database.readOne<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM referral_edge
          WHERE referrer_id = $1 AND state = 'confirmed' AND voided_at IS NULL
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

    async findGiveawayEntryTotal(subscriberId) {
      const row = await database.readOne<{ total: string }>({
        text: `
          SELECT COALESCE(SUM(entries), 0)::text AS total
          FROM giveaway_entry
          WHERE subscriber_id = $1 AND voided_at IS NULL
        `,
        values: [subscriberId],
      });
      return Number(row?.total ?? '0');
    },

    async findOwnReferralRank(subscriberId) {
      const row = await database.readOne<{ rank: number }>({
        text: `
          WITH eligible AS (
            SELECT
              subscriber.id,
              subscriber.confirmed_referrals,
              subscriber.verified_at
            FROM subscriber
            WHERE subscriber.status = 'verified'
              AND NOT EXISTS (
                SELECT 1
                FROM fraud_flag
                WHERE fraud_flag.subscriber_id = subscriber.id
                  AND fraud_flag.state <> 'dismissed'
              )
          ), ranked AS (
            SELECT
              id,
              (ROW_NUMBER() OVER (
                ORDER BY confirmed_referrals DESC, verified_at ASC NULLS LAST, id ASC
              ))::integer AS rank
            FROM eligible
          )
          SELECT rank
          FROM ranked
          WHERE id = $1
        `,
        values: [subscriberId],
      });
      return row?.rank ?? null;
    },

    async findActiveMilestoneAwards(subscriberId, limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(
          'A referral-status reward limit must be positive.',
        );
      }
      return database.list<ReferralStatusAward>(
        {
          text: `
            SELECT tier, reward_kind, state
            FROM milestone_award
            WHERE subscriber_id = $1
              AND state IN ('settled', 'held')
            ORDER BY tier, reward_kind
          `,
          values: [subscriberId],
        },
        limit,
      );
    },

    async findEdgeForConfirmation(referredId) {
      return database.readOne<ReferralEdgeForConfirmation>({
        text: `
          SELECT edge.id, edge.referrer_id, edge.partner_id
          FROM referral_edge edge
          JOIN subscriber referred ON referred.id = edge.referred_id
          WHERE edge.referred_id = $1
            AND edge.referrer_id IS NOT NULL AND edge.state = 'attributed'
            AND referred.status = 'verified'
        `,
        values: [referredId],
      });
    },

    async findSubscriber(subscriberId) {
      return database.readOne<ReferralSubscriber>({
        text: `
          SELECT status, referral_code, confirmed_referrals, referral_tier,
                 access_window, verification_order_window
          FROM subscriber
          WHERE id = $1
        `,
        values: [subscriberId],
      });
    },

    async findSettledReferralTier(subscriberId) {
      const row = await database.readOne<{ tier: number }>({
        text: `
          SELECT COALESCE(MAX(tier), 0)::integer AS tier
          FROM milestone_award
          WHERE subscriber_id = $1 AND state = 'settled'
        `,
        values: [subscriberId],
      });
      return row?.tier ?? 0;
    },

    async findSubscriberIdsForCounterRepair(limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('A counter repair limit must be positive.');
      }
      const rows = await database.list<{ id: string }>(
        {
          text: `
            SELECT id
            FROM subscriber
            WHERE status = 'verified'
            ORDER BY id
            FOR UPDATE SKIP LOCKED
          `,
        },
        limit,
      );
      return rows.map((row) => row.id);
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

    async insertAttributedEdge(
      id,
      referrerId,
      referredId,
      signupConfirmedCount,
      partner,
    ) {
      return database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state,
            signup_confirmed_count, partner_id, welcome_discount_pct
          )
          VALUES ($1, $2, $3, 'attributed', 'none', $4, $5, $6)
          ON CONFLICT (referred_id) DO NOTHING
        `,
        values: [
          id,
          referrerId,
          referredId,
          signupConfirmedCount,
          partner?.id ?? null,
          partner?.discount ?? null,
        ],
      });
    },

    async lockAccessWindowAssignment() {
      await database.readOne({
        text: "SELECT pg_advisory_xact_lock(hashtext('valstara:access-window-assignment'))",
      });
    },

    async lockSubscriber(subscriberId) {
      return database.readOne<ReferralSubscriber>({
        text: `
          SELECT status, referral_code, confirmed_referrals, referral_tier,
                 access_window, verification_order_window
          FROM subscriber
          WHERE id = $1
          FOR UPDATE
        `,
        values: [subscriberId],
      });
    },

    async repairReferralCounterAndTier(subscriberId, confirmedReferrals, tier) {
      const corrected = await database.execute({
        text: `
          UPDATE subscriber
          SET confirmed_referrals = $2, referral_tier = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
            AND (confirmed_referrals, referral_tier) IS DISTINCT FROM ($2, $3)
        `,
        values: [subscriberId, confirmedReferrals, tier],
      });
      return corrected === 1;
    },

    async verificationOrder() {
      const row = await database.readOne<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM subscriber
          WHERE status = $1
        `,
        values: [countedSubscriberStatus],
      });
      return Number(row?.count ?? '0');
    },
  };
}
