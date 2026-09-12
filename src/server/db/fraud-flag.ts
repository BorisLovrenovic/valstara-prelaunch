import type { DatabaseConnection } from './pool.ts';

export interface ChallengeTimeoutFlagInsert {
  readonly id: string;
  readonly subscriberId: string;
}

export interface FraudFlagRepository {
  /**
   * Raises an open `challenge_timeout` flag for the subscriber, returning the
   * number of rows written (0 when one is already open, so a repeat signup
   * during a Turnstile outage does not spam the review queue). Best-effort
   * de-duplication: it is guarded by `WHERE NOT EXISTS`, not by a unique index,
   * because the review flag is metadata — a lost or duplicated one degrades the
   * queue, it never touches the committed subscriber row.
   */
  insertChallengeTimeoutFlag(
    input: ChallengeTimeoutFlagInsert,
  ): Promise<number>;
  insertSelfReferralFlag(input: SelfReferralFlagInsert): Promise<number>;
}

export interface SelfReferralFlagInsert {
  readonly id: string;
  readonly subscriberId: string;
}

// The detail never carries a token, a secret, a full IP or an email — only the
// machine reason (docs/data/model.md#fraud_flag, standing rule on redaction).
const challengeTimeoutDetail = JSON.stringify({
  reason: 'turnstile_provider_timeout',
});
const selfReferralDetail = JSON.stringify({ reason: 'self_referral' });

/**
 * The data layer for the one `fraud_flag` write E3-03 owns: the Turnstile
 * provider-timeout review flag (ADR-006, founder-authorised 2026-09-07). The
 * SQL lives here because `src/server/db` is the only place it may
 * (`docs/architecture/modules.md`). The E5 fraud module owns every other kind
 * and the review workflow (`docs/modules/fraud.md`); this path does not.
 */
export function createFraudFlagRepository(
  database: DatabaseConnection,
): FraudFlagRepository {
  return {
    async insertChallengeTimeoutFlag(input) {
      return database.execute({
        text: `
          INSERT INTO fraud_flag (id, subscriber_id, kind, detail, state)
          SELECT $1, $2, 'challenge_timeout', $3::jsonb, 'open'
          WHERE NOT EXISTS (
            SELECT 1
            FROM fraud_flag
            WHERE subscriber_id = $2
              AND kind = 'challenge_timeout'
              AND state = 'open'
          )
        `,
        values: [input.id, input.subscriberId, challengeTimeoutDetail],
      });
    },
    async insertSelfReferralFlag(input) {
      return database.execute({
        text: `
          INSERT INTO fraud_flag (id, subscriber_id, kind, detail, state)
          SELECT $1, $2, 'self_referral', $3::jsonb, 'open'
          WHERE NOT EXISTS (
            SELECT 1
            FROM fraud_flag
            WHERE subscriber_id = $2
              AND kind = 'self_referral'
              AND state = 'open'
          )
        `,
        values: [input.id, input.subscriberId, selfReferralDetail],
      });
    },
  };
}
