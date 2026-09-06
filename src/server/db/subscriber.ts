import type { DatabaseConnection } from './pool.ts';

export interface PendingSubscriberInsert {
  readonly id: string;
  readonly email: string;
  readonly emailNormalised: string;
  readonly emailDomain: string;
  readonly country: string;
  readonly region: string | null;
}

export interface SubscriberIdentity {
  readonly id: string;
  readonly status: string;
}

export interface VerificationTokenInsert {
  readonly id: string;
  readonly subscriberId: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
}

export interface QueuedVerificationEmailInsert {
  readonly id: string;
  readonly subscriberId: string;
  readonly businessKey: string;
}

export interface SubscriberRepository {
  /** Inserts a `pending` row, doing nothing on the `email_normalised` conflict; returns rows affected. */
  insertPending(input: PendingSubscriberInsert): Promise<number>;
  findByNormalised(emailNormalised: string): Promise<SubscriberIdentity | null>;
  insertVerificationToken(input: VerificationTokenInsert): Promise<void>;
  insertQueuedVerificationEmail(
    input: QueuedVerificationEmailInsert,
  ): Promise<void>;
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
            country,
            region,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'pending')
          ON CONFLICT (email_normalised) DO NOTHING
        `,
        values: [
          input.id,
          input.email,
          input.emailNormalised,
          input.emailDomain,
          input.country,
          input.region,
        ],
      });
    },
    async findByNormalised(emailNormalised) {
      return database.readOne<SubscriberIdentity>({
        text: 'SELECT id, status FROM subscriber WHERE email_normalised = $1',
        values: [emailNormalised],
      });
    },
    async insertVerificationToken(input) {
      await database.execute({
        text: `
          INSERT INTO verification_token (
            id,
            subscriber_id,
            token_hash,
            purpose,
            expires_at
          )
          VALUES ($1, $2, $3, 'verify', $4)
        `,
        values: [
          input.id,
          input.subscriberId,
          input.tokenHash,
          input.expiresAt,
        ],
      });
    },
    async insertQueuedVerificationEmail(input) {
      await database.execute({
        text: `
          INSERT INTO email_send (
            id,
            subscriber_id,
            template,
            provider,
            business_key,
            state
          )
          VALUES ($1, $2, 'verification_test', 'resend', $3, 'queued')
        `,
        values: [input.id, input.subscriberId, input.businessKey],
      });
    },
  };
}
