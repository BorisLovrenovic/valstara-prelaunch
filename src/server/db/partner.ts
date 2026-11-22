import type { DatabaseConnection } from './pool.ts';

/** The largest batch the retention purge clears in one statement (standing rule 13). */
export const partnerPurgeBatchLimit = 500;

export interface PartnerApplicationInsert {
  readonly id: string;
  readonly subscriberId: string;
  readonly createdSubscriber: boolean;
  readonly confirmationTokenId: string;
  readonly submittedAt: Date;
  readonly fullName: string;
  readonly countryOfResidence: string;
  readonly partnerType: string;
  readonly channels: readonly string[];
  readonly handles: readonly string[];
  readonly audienceSize: string;
  readonly promotionPlan: string;
  readonly requestedCode: string;
  readonly university: string | null;
  readonly studentEmail: string | null;
  readonly companyName: string | null;
}

export interface PartnerConfirmationTarget {
  readonly id: string;
  readonly subscriber_id: string | null;
  readonly status: string;
}

export interface PartnerRepository {
  insertApplication(input: PartnerApplicationInsert): Promise<void>;
  /** A confirmed application or partnership already exists for the member. */
  hasLiveApplication(subscriberId: string): Promise<boolean>;
  /** The application a confirmation token belongs to, locked for update. */
  lockByConfirmationToken(
    tokenId: string,
  ): Promise<PartnerConfirmationTarget | null>;
  /** Locks the member row and returns its status. */
  lockSubscriber(subscriberId: string): Promise<string | null>;
  markApplied(id: string, now: Date): Promise<number>;
  /**
   * Clears the personal fields of at most `limit` unconfirmed or rejected
   * applications that reached that state before `before`.
   */
  purgeRetired(before: Date, now: Date, limit: number): Promise<number>;
}

/**
 * The data layer for the partner application (E11.7-05). All of its SQL
 * lives here (`docs/architecture/modules.md`); the partner service decides.
 */
export function createPartnerRepository(
  database: DatabaseConnection,
): PartnerRepository {
  return {
    async insertApplication(input) {
      await database.execute({
        text: `
          INSERT INTO partner (
            id, subscriber_id, status, status_changed_at, submitted_at,
            created_subscriber, confirmation_token_id, full_name,
            country_of_residence, partner_type, channels, handles,
            audience_size, promotion_plan, requested_code, university,
            student_email, company_name, age_confirmed, programme_terms_agreed
          )
          VALUES (
            $1, $2, 'unconfirmed', $3, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12, $13, $14, $15, $16, true, true
          )
        `,
        values: [
          input.id,
          input.subscriberId,
          input.submittedAt,
          input.createdSubscriber,
          input.confirmationTokenId,
          input.fullName,
          input.countryOfResidence,
          input.partnerType,
          [...input.channels],
          [...input.handles],
          input.audienceSize,
          input.promotionPlan,
          input.requestedCode,
          input.university,
          input.studentEmail,
          input.companyName,
        ],
      });
    },

    async hasLiveApplication(subscriberId) {
      const row = await database.readOne<{ present: boolean }>({
        text: `
          SELECT EXISTS (
            SELECT 1 FROM partner
            WHERE subscriber_id = $1
              AND status NOT IN ('unconfirmed', 'rejected')
          ) AS present
        `,
        values: [subscriberId],
      });
      return row?.present ?? false;
    },

    lockByConfirmationToken(tokenId) {
      return database.readOne<PartnerConfirmationTarget>({
        text: `
          SELECT id, subscriber_id, status FROM partner
          WHERE confirmation_token_id = $1
          FOR UPDATE
        `,
        values: [tokenId],
      });
    },

    async lockSubscriber(subscriberId) {
      const row = await database.readOne<{ status: string }>({
        text: 'SELECT status FROM subscriber WHERE id = $1 FOR UPDATE',
        values: [subscriberId],
      });
      return row?.status ?? null;
    },

    async markApplied(id, now) {
      return database.execute({
        text: `
          UPDATE partner
          SET status = 'applied', applied_at = $2, status_changed_at = $2
          WHERE id = $1 AND status = 'unconfirmed'
            AND personal_data_purged_at IS NULL
        `,
        values: [id, now],
      });
    },

    async purgeRetired(before, now, limit) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > partnerPurgeBatchLimit
      ) {
        throw new RangeError(
          `A partner purge limit must be between 1 and ${partnerPurgeBatchLimit}.`,
        );
      }
      return database.execute({
        text: `
          UPDATE partner AS target
          SET ${purgedPersonalFields}, personal_data_purged_at = $2
          WHERE target.id = ANY (ARRAY(
            SELECT candidate.id FROM partner AS candidate
            WHERE candidate.personal_data_purged_at IS NULL
              AND candidate.status IN ('unconfirmed', 'rejected')
              AND candidate.status_changed_at < $1
            ORDER BY candidate.status_changed_at, candidate.id
            LIMIT $3
            FOR UPDATE SKIP LOCKED
          ))
            AND target.personal_data_purged_at IS NULL
        `,
        values: [before, now, limit],
      });
    },
  };
}

/**
 * Every personal field of a `partner` row, cleared together with its member
 * link, for the retention purge and for erasure (E9-05). Only the status,
 * the partner type and the timestamps remain.
 */
export const purgedPersonalFields = `
  subscriber_id = NULL,
  confirmation_token_id = NULL,
  full_name = NULL,
  country_of_residence = NULL,
  channels = NULL,
  handles = NULL,
  audience_size = NULL,
  promotion_plan = NULL,
  requested_code = NULL,
  university = NULL,
  student_email = NULL,
  company_name = NULL,
  age_confirmed = NULL,
  programme_terms_agreed = NULL`;
