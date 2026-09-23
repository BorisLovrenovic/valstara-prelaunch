import type { DatabaseConnection } from './pool.ts';

export interface StatusTokenRow {
  readonly consumed_at: Date | null;
  readonly expires_at: Date;
  readonly purpose: string;
  readonly subscriber_id: string;
}

export interface QueuedStatusLinkEmail {
  readonly businessKey: string;
  readonly id: string;
  readonly subscriberId: string;
}

export interface StatusLinkRepository {
  findToken(tokenHash: Buffer): Promise<StatusTokenRow | null>;
  queueEmail(input: QueuedStatusLinkEmail): Promise<void>;
}

export function createStatusLinkRepository(
  database: DatabaseConnection,
): StatusLinkRepository {
  return {
    async findToken(tokenHash) {
      return database.readOne<StatusTokenRow>({
        text: `
          SELECT subscriber_id, purpose, expires_at, consumed_at
          FROM verification_token
          WHERE token_hash = $1
        `,
        values: [tokenHash],
      });
    },
    async queueEmail(input) {
      await database.execute({
        text: `
          INSERT INTO email_send (
            id, subscriber_id, template, provider, business_key, state
          )
          VALUES ($1, $2, 'status_link', 'resend', $3, 'queued')
        `,
        values: [input.id, input.subscriberId, input.businessKey],
      });
    },
  };
}
