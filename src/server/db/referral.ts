import type { DatabaseConnection } from './pool.ts';
import type { AccessWindow } from '../referral/config.ts';
import type {
  ConfirmationRewardState,
  MilestoneAwardState,
} from '../referral/reward-state.ts';
import { countedSubscriberStatus } from './subscriber-maintenance.ts';

export interface ReferralEdgeForConfirmation {
  readonly id: string;
  readonly referrer_id: string;
}

export interface ReferralStatusAward {
  readonly reward_kind: 'discount' | 'entries' | 'merch' | 'wave_upgrade';
  readonly state: 'held' | 'settled';
  readonly tier: number;
}

export interface ReferralSubscriber {
  readonly access_window: AccessWindow | null;
  readonly confirmed_referrals: number;
  readonly giveaway_eligible: boolean | null;
  readonly referral_code: string | null;
  readonly referral_tier: number;
  readonly status: string;
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
  findMilestoneBackfillCandidateIds(
    tier: number,
    threshold: number,
    limit: number,
  ): Promise<readonly string[]>;
  findEdgeForConfirmation(
    referredId: string,
  ): Promise<ReferralEdgeForConfirmation | null>;
  findHeldMilestoneAwardIds(limit: number): Promise<readonly string[]>;
  findHeldReferralEdgeIds(limit: number): Promise<readonly string[]>;
  findSubscriber(subscriberId: string): Promise<ReferralSubscriber | null>;
  findSubscriberIdByCode(code: string): Promise<string | null>;
  findSettledReferralTier(subscriberId: string): Promise<number>;
  findSubscriberIdsForCounterRepair(limit: number): Promise<readonly string[]>;
  findStrandedVerifiedReferralIds(limit: number): Promise<readonly string[]>;
  insertMilestoneAward(
    id: string,
    subscriberId: string,
    tier: number,
    rewardKind: 'discount' | 'entries' | 'wave_upgrade',
    state: Exclude<MilestoneAwardState, 'void'>,
    now: Date,
  ): Promise<number>;
  insertAttributedEdge(
    id: string,
    referrerId: string,
    referredId: string,
  ): Promise<number>;
  lockAccessWindowAssignment(): Promise<void>;
  lockSubscriber(subscriberId: string): Promise<ReferralSubscriber | null>;
  setAccessWindow(subscriberId: string, window: AccessWindow): Promise<number>;
  setReferralCounterAndTier(
    subscriberId: string,
    confirmedReferrals: number,
    tier: number,
  ): Promise<number>;
  repairReferralCounterAndTier(
    subscriberId: string,
    confirmedReferrals: number,
    tier: number,
  ): Promise<boolean>;
  verificationOrder(): Promise<number>;
  voidMilestoneAwards(ids: readonly string[], state: 'void'): Promise<number>;
  voidReferralEdges(ids: readonly string[], state: 'void'): Promise<number>;
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

    async findMilestoneBackfillCandidateIds(tier, threshold, limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('A milestone backfill limit must be positive.');
      }
      return (
        await database.list<{ id: string }>(
          {
            text: `
              SELECT subscriber.id
              FROM subscriber
              JOIN referral_edge
                ON referral_edge.referrer_id = subscriber.id
               AND referral_edge.state = 'confirmed'
              WHERE subscriber.status = 'verified'
                AND NOT EXISTS (
                  SELECT 1
                  FROM milestone_award
                  WHERE milestone_award.subscriber_id = subscriber.id
                    AND milestone_award.tier = $1
                )
              GROUP BY subscriber.id, subscriber.created_at
              HAVING COUNT(referral_edge.id) >= $2
              ORDER BY subscriber.created_at, subscriber.id
            `,
            values: [tier, threshold],
          },
          limit,
        )
      ).map((row) => row.id);
    },

    async findEdgeForConfirmation(referredId) {
      return database.readOne<ReferralEdgeForConfirmation>({
        text: `
          SELECT edge.id, edge.referrer_id
          FROM referral_edge edge
          JOIN subscriber referred ON referred.id = edge.referred_id
          WHERE edge.referred_id = $1
            AND edge.state = 'attributed'
            AND referred.status = 'verified'
        `,
        values: [referredId],
      });
    },

    async findHeldMilestoneAwardIds(limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('A held-award query limit must be positive.');
      }
      const rows = await database.list<{ id: string }>(
        {
          text: `
            SELECT id
            FROM milestone_award
            WHERE state = 'held'
            ORDER BY awarded_at, id
          `,
        },
        limit,
      );
      return rows.map((row) => row.id);
    },

    async findHeldReferralEdgeIds(limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('A held-edge query limit must be positive.');
      }
      const rows = await database.list<{ id: string }>(
        {
          text: `
            SELECT id
            FROM referral_edge
            WHERE reward_state = 'held'
            ORDER BY confirmed_at NULLS LAST, created_at, id
          `,
        },
        limit,
      );
      return rows.map((row) => row.id);
    },

    async findSubscriber(subscriberId) {
      return database.readOne<ReferralSubscriber>({
        text: `
          SELECT status, referral_code, confirmed_referrals, referral_tier,
                 access_window, giveaway_eligible
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

    async lockAccessWindowAssignment() {
      await database.readOne({
        text: "SELECT pg_advisory_xact_lock(hashtext('valstara:access-window-assignment'))",
      });
    },

    async lockSubscriber(subscriberId) {
      return database.readOne<ReferralSubscriber>({
        text: `
          SELECT status, referral_code, confirmed_referrals, referral_tier,
                 access_window, giveaway_eligible
          FROM subscriber
          WHERE id = $1
          FOR UPDATE
        `,
        values: [subscriberId],
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

    async voidMilestoneAwards(ids, state) {
      if (ids.length === 0) {
        return 0;
      }
      return database.execute({
        text: `
          UPDATE milestone_award
          SET state = $2
          WHERE id = ANY($1::uuid[]) AND state = 'held'
        `,
        values: [ids, state],
      });
    },

    async voidReferralEdges(ids, state) {
      if (ids.length === 0) {
        return 0;
      }
      return database.execute({
        text: `
          UPDATE referral_edge
          SET reward_state = $2
          WHERE id = ANY($1::uuid[]) AND reward_state = 'held'
        `,
        values: [ids, state],
      });
    },
  };
}
