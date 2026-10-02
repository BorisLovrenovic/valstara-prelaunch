import type { DatabaseConnection } from './pool.ts';

export interface StatusTokenRow {
  readonly id: string;
  readonly consumed_at: Date | null;
  readonly expires_at: Date;
  readonly purpose: string;
  readonly subscriber_id: string;
}

export interface StatusLinkRepository {
  findToken(tokenHash: Buffer): Promise<StatusTokenRow | null>;
}

export function createStatusLinkRepository(
  database: DatabaseConnection,
): StatusLinkRepository {
  return {
    async findToken(tokenHash) {
      return database.readOne<StatusTokenRow>({
        text: `
          SELECT id, subscriber_id, purpose, expires_at, consumed_at
          FROM verification_token
          WHERE token_hash = $1 AND EXISTS (SELECT 1 FROM subscriber s WHERE s.id=verification_token.subscriber_id AND s.status NOT IN ('erasure_pending','erased'))
        `,
        values: [tokenHash],
      });
    },
  };
}
