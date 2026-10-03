import type { DatabaseConnection } from './pool.ts';
import type { TokenPurpose } from '../verification/types.ts';

export interface VerificationTokenInsert {
  readonly id: string;
  readonly subscriberId: string;
  readonly tokenHash: Buffer;
  readonly purpose: TokenPurpose;
  readonly expiresAt: Date;
}

/**
 * The classification row read back when a fresh consume did not land, so the
 * service can decide between `already`, `expired`, `invalid` and a lost race.
 * `purpose` is returned unfiltered so a cross-purpose token resolves to
 * `invalid` (a status link must never consume as a verify link).
 */
export interface VerificationTokenClassification {
  readonly id: string;
  readonly subscriber_id: string;
  readonly purpose: string;
  readonly consumed_at: Date | null;
  readonly expires_at: Date;
}

export interface VerificationTokenRepository {
  insert(input: VerificationTokenInsert): Promise<void>;
  /**
   * The single-use primitive: an atomic update that consumes the token only
   * when it is unconsumed and unexpired for this exact purpose. Returns the
   * number of rows changed (1 on the sole successful consume, 0 for every
   * replay, expiry, cross-purpose or lost-race attempt). The `consumed_at
   * IS NULL` guard is what makes concurrent consumes safe without a lock.
   */
  consumeFresh(
    tokenHash: Buffer,
    purpose: TokenPurpose,
    now: Date,
  ): Promise<number>;
  findByHash(
    tokenHash: Buffer,
  ): Promise<VerificationTokenClassification | null>;
  /**
   * Batch-capped purge of tokens whose expiry is strictly before `before`.
   * Returns the number removed, so a caller can loop until it drains. Bounded
   * by `limit` because every sweep on this box caps its batch (standing rule
   * 13); a subquery selects the id set so the delete never scans unbounded.
   */
  purgeExpired(before: Date, limit: number): Promise<number>;
}

export function createVerificationTokenRepository(
  database: DatabaseConnection,
): VerificationTokenRepository {
  return {
    async insert(input) {
      await database.execute({
        text: `
          INSERT INTO verification_token (
            id, subscriber_id, token_hash, purpose, expires_at
          )
          VALUES ($1, $2, $3, $4, $5)
        `,
        values: [
          input.id,
          input.subscriberId,
          input.tokenHash,
          input.purpose,
          input.expiresAt,
        ],
      });
    },

    async consumeFresh(tokenHash, purpose, now) {
      return database.execute({
        text: `
          UPDATE verification_token
          SET consumed_at = $3
          WHERE token_hash = $1
            AND purpose = $2
            AND consumed_at IS NULL
            AND expires_at > $3
        `,
        values: [tokenHash, purpose, now],
      });
    },

    async findByHash(tokenHash) {
      return database.readOne<VerificationTokenClassification>({
        text: `
          SELECT id, subscriber_id, purpose, consumed_at, expires_at
          FROM verification_token
          WHERE token_hash = $1 AND EXISTS (SELECT 1 FROM subscriber s WHERE s.id=verification_token.subscriber_id AND s.status NOT IN ('erasure_pending','erased'))
        `,
        values: [tokenHash],
      });
    },

    async purgeExpired(before, limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('A purge limit must be a positive integer.');
      }

      return database.execute({
        text: `
          DELETE FROM verification_token
          WHERE id IN (
            SELECT id
            FROM verification_token
            WHERE expires_at < $1
            LIMIT $2
          )
        `,
        values: [before, limit],
      });
    },
  };
}
