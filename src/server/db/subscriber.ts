import type { DatabaseConnection } from './pool.ts';
import type { AgePolicy } from '../giveaway/age-policy.ts';
import type { UtmParameters } from '../referral/capture.ts';

export interface PendingSubscriberInsert {
  readonly id: string;
  readonly email: string;
  readonly emailNormalised: string;
  readonly emailDomain: string;
  readonly marketingOptInVersion: string | null;
  readonly signupIpPrefixHash: Buffer | null;
  readonly utm: UtmParameters | null;
  readonly signupHadRef: boolean;
  /** The age policy the row joins under (E11.8-06); written once. */
  readonly admissionAgePolicy: AgePolicy;
  /** The 18+ giveaway box was ticked on the signup form (E11.8-06). */
  readonly giveawayOptIn: boolean;
}

export interface SubscriberIdentity {
  readonly id: string;
  readonly status: string;
  readonly admissionAgePolicy: AgePolicy | null;
}

export interface SubscriberRepository {
  /** Inserts a `pending` row, doing nothing on the `email_normalised` conflict; returns rows affected. */
  insertPending(input: PendingSubscriberInsert): Promise<number>;
  findByNormalised(emailNormalised: string): Promise<SubscriberIdentity | null>;
  setPendingMarketingOptIn(
    subscriberId: string,
    version: string,
  ): Promise<void>;
  /** Records a signup-form tick of the 18+ box on a pending row, once. */
  setPendingGiveawayOptIn(subscriberId: string): Promise<void>;
}

/**
 * The data layer for the subscriber signup write path. All of its SQL lives
 * here because `src/server/db` is the only place SQL may (`docs/architecture/
 * modules.md`); the subscriber service orchestrates the transaction and the
 * business decisions, and calls these methods over the transaction connection.
 */
export function createSubscriberRepository(
  database: DatabaseConnection,
): SubscriberRepository {
  return {
    async insertPending(input) {
      return database.execute({
        text: `
          INSERT INTO subscriber (
            id,
            email,
            email_normalised,
            email_domain,
            marketing_opt_in_pending,
            marketing_opt_in_pending_version,
            signup_ip_prefix_hash,
            signup_had_ref,
            utm,
            admission_age_policy,
            giveaway_opt_in_at,
            giveaway_opt_in_source,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                  CASE WHEN $11::boolean THEN CURRENT_TIMESTAMP END,
                  CASE WHEN $11::boolean THEN 'signup' END,
                  'pending')
          ON CONFLICT (email_normalised) DO NOTHING
        `,
        values: [
          input.id,
          input.email,
          input.emailNormalised,
          input.emailDomain,
          input.marketingOptInVersion !== null,
          input.marketingOptInVersion,
          input.signupIpPrefixHash,
          input.signupHadRef,
          input.utm === null ? null : JSON.stringify(input.utm),
          input.admissionAgePolicy,
          input.giveawayOptIn,
        ],
      });
    },
    async findByNormalised(emailNormalised) {
      const row = await database.readOne<{
        id: string;
        status: string;
        admission_age_policy: AgePolicy | null;
      }>({
        text: `SELECT id, status, admission_age_policy FROM subscriber
               WHERE email_normalised = $1`,
        values: [emailNormalised],
      });
      return row === null
        ? null
        : {
            id: row.id,
            status: row.status,
            admissionAgePolicy: row.admission_age_policy,
          };
    },
    async setPendingMarketingOptIn(subscriberId, version) {
      await database.execute({
        text: `
          UPDATE subscriber
          SET marketing_opt_in_pending = true,
              marketing_opt_in_pending_version = $2,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'pending' AND marketing_consent_at IS NULL
        `,
        values: [subscriberId, version],
      });
    },
    async setPendingGiveawayOptIn(subscriberId) {
      // The tick time is the transaction's, as the row's created_at is, so
      // it can never precede the signup it belongs to.
      await database.execute({
        text: `
          UPDATE subscriber
          SET giveaway_opt_in_at = GREATEST(CURRENT_TIMESTAMP, created_at),
              giveaway_opt_in_source = 'signup',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'pending' AND giveaway_opt_in_at IS NULL
        `,
        values: [subscriberId],
      });
    },
  };
}
