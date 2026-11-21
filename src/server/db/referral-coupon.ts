import type { DatabaseConnection } from './pool.ts';
import type { AccessWindow } from '../referral/config.ts';
import type { CouponState } from '../referral/reward-state.ts';

// E11.7-03: the SQL behind the coupon ladder and wave 1. The recompute
// (src/server/referral/rewards.ts) owns the rules; this file only reads and
// writes the rows.

/** More coupons than any configured ladder holds; a read past it is refused. */
export const referralCouponReadLimit = 100;

export interface ReferralCouponRow {
  readonly id: string;
  readonly coupon_number: number;
  readonly percent: number | null;
  readonly state: CouponState;
}

export interface ReferralWaveRow {
  readonly access_window: AccessWindow | null;
  readonly verification_order_window: AccessWindow | null;
}

export interface ReferralCouponRepository {
  /** The owner's coupons in coupon order, held and void. */
  listCoupons(subscriberId: string): Promise<readonly ReferralCouponRow[]>;
  insertCoupon(
    id: string,
    subscriberId: string,
    couponNumber: number,
    percent: number,
    now: Date,
  ): Promise<number>;
  updateCoupon(
    id: string,
    state: CouponState,
    percent: number | null,
    now: Date,
  ): Promise<number>;
  findWaves(subscriberId: string): Promise<ReferralWaveRow | null>;
  setAccessWindow(subscriberId: string, window: AccessWindow): Promise<number>;
  /** Records the verification-order window once, with the access window it gives. */
  assignVerificationOrderWindow(
    subscriberId: string,
    window: AccessWindow,
  ): Promise<number>;
}

export function createReferralCouponRepository(
  database: DatabaseConnection,
): ReferralCouponRepository {
  return {
    async listCoupons(subscriberId) {
      const rows = await database.list<ReferralCouponRow>(
        {
          text: `
            SELECT id::text, coupon_number, percent, state
            FROM referral_coupon
            WHERE subscriber_id = $1
            ORDER BY coupon_number
          `,
          values: [subscriberId],
        },
        referralCouponReadLimit + 1,
      );
      if (rows.length > referralCouponReadLimit) {
        throw new Error(
          'A referrer holds more coupons than any ladder allows.',
        );
      }
      return rows;
    },

    insertCoupon(id, subscriberId, couponNumber, percent, now) {
      return database.execute({
        text: `
          INSERT INTO referral_coupon (
            id, subscriber_id, coupon_number, percent, state, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, 'held', $5, $5)
        `,
        values: [id, subscriberId, couponNumber, percent, now],
      });
    },

    updateCoupon(id, state, percent, now) {
      return database.execute({
        text: `
          UPDATE referral_coupon
          SET state = $2, percent = $3, updated_at = GREATEST($4, created_at)
          WHERE id = $1
        `,
        values: [id, state, percent, now],
      });
    },

    findWaves(subscriberId) {
      return database.readOne<ReferralWaveRow>({
        text: `
          SELECT access_window, verification_order_window
          FROM subscriber
          WHERE id = $1
        `,
        values: [subscriberId],
      });
    },

    setAccessWindow(subscriberId, window) {
      return database.execute({
        text: `
          UPDATE subscriber
          SET access_window = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
        values: [subscriberId, window],
      });
    },

    assignVerificationOrderWindow(subscriberId, window) {
      return database.execute({
        text: `
          UPDATE subscriber
          SET verification_order_window = $2, access_window = $2,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND verification_order_window IS NULL
        `,
        values: [subscriberId, window],
      });
    },
  };
}
