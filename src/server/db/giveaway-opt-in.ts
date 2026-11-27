import type { AgePolicy, GiveawayOptInSource } from '../giveaway/age-policy.ts';

import type { DatabaseConnection } from './pool.ts';

/** The member's own giveaway box state, as `/me` shows it (E11.8-06). */
export interface GiveawayOptInState {
  readonly status: string;
  readonly admissionAgePolicy: AgePolicy | null;
  readonly giveawayOptInAt: Date | null;
  readonly giveawayOptInSource: GiveawayOptInSource | null;
}

export interface GiveawayOptInRepository {
  state(
    subscriberId: string,
    lock?: boolean,
  ): Promise<GiveawayOptInState | null>;
  /**
   * Records the 18+ box ticked on `/me`, once, for a verified member; returns
   * rows affected. The time never precedes the member's signup.
   */
  recordMemberStatusOptIn(subscriberId: string, now: Date): Promise<number>;
  /**
   * The member's confirmed, non-voided referrals inside the entry period, as
   * referrer, in ID order, at most `limit` after the previous page's last ID.
   */
  confirmedEdgesAsReferrer(
    referrerId: string,
    periodStart: Date,
    periodEnd: Date,
    limit: number,
    afterEdgeId: string | null,
  ): Promise<readonly string[]>;
}

export function createGiveawayOptInRepository(
  database: DatabaseConnection,
): GiveawayOptInRepository {
  return {
    async state(subscriberId, lock = false) {
      const row = await database.readOne<{
        status: string;
        admission_age_policy: AgePolicy | null;
        giveaway_opt_in_at: Date | null;
        giveaway_opt_in_source: GiveawayOptInSource | null;
      }>({
        text: `SELECT status, admission_age_policy, giveaway_opt_in_at,
                      giveaway_opt_in_source
               FROM subscriber WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
        values: [subscriberId],
      });
      return row === null
        ? null
        : {
            status: row.status,
            admissionAgePolicy: row.admission_age_policy,
            giveawayOptInAt: row.giveaway_opt_in_at,
            giveawayOptInSource: row.giveaway_opt_in_source,
          };
    },
    recordMemberStatusOptIn(subscriberId, now) {
      return database.execute({
        text: `
          UPDATE subscriber
          SET giveaway_opt_in_at = GREATEST($2::timestamptz, created_at),
              giveaway_opt_in_source = 'member_status',
              updated_at = $2
          WHERE id = $1 AND status = 'verified' AND giveaway_opt_in_at IS NULL
        `,
        values: [subscriberId, now],
      });
    },
    async confirmedEdgesAsReferrer(
      referrerId,
      periodStart,
      periodEnd,
      limit,
      afterEdgeId,
    ) {
      const rows = await database.list<{ id: string }>(
        {
          text: `SELECT id::text FROM referral_edge
                 WHERE referrer_id = $1 AND state = 'confirmed'
                   AND voided_at IS NULL
                   AND confirmed_at >= $2 AND confirmed_at < $3
                   AND ($4::uuid IS NULL OR id > $4)
                 ORDER BY id`,
          values: [referrerId, periodStart, periodEnd, afterEdgeId],
        },
        limit,
      );
      return rows.map((row) => row.id);
    },
  };
}
