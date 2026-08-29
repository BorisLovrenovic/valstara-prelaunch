import { createHash } from 'node:crypto';

import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

export type ThinVerificationResult = 'verified' | 'already' | 'invalid';

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export async function consumeThinVerificationToken(
  database: DatabasePool,
  token: string,
  now = new Date(),
): Promise<ThinVerificationResult> {
  if (token === '') {
    return 'invalid';
  }

  return withTransaction(database, async (connection) => {
    const existing = await connection.readOne<{
      consumed_at: Date | null;
      expires_at: Date;
      subscriber_id: string;
    }>({
      text: `
        SELECT subscriber_id, consumed_at, expires_at
        FROM verification_token
        WHERE token_hash = $1
          AND purpose = 'verify'
      `,
      values: [tokenHash(token)],
    });

    if (existing === null || existing.expires_at <= now) {
      return 'invalid';
    }
    if (existing.consumed_at !== null) {
      return 'already';
    }

    const consumed = await connection.execute({
      text: `
        UPDATE verification_token
        SET consumed_at = $2
        WHERE token_hash = $1
          AND purpose = 'verify'
          AND consumed_at IS NULL
          AND expires_at > $2
      `,
      values: [tokenHash(token), now],
    });

    if (consumed === 1) {
      await connection.execute({
        text: `
          UPDATE subscriber
          SET status = 'verified', verified_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'pending'
        `,
        values: [existing.subscriber_id, now],
      });
      return 'verified';
    }

    return 'already';
  });
}
