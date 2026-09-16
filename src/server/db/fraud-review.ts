import type { AuditDetail } from '../audit/types.ts';

import type { DatabaseConnection } from './pool.ts';

export type FraudReviewOutcome = 'dismissed' | 'upheld';

export interface OpenFraudFlagRow {
  readonly confirmed_referrals: number;
  readonly country: string | null;
  readonly detail: AuditDetail;
  readonly email_domain: string;
  readonly id: string;
  readonly kind: string;
  readonly priority: number;
  readonly raised_at: Date;
  readonly referral_tier: number;
  readonly status: string;
  readonly subscriber_created_at: Date;
  readonly subscriber_id: string;
  readonly verified_at: Date | null;
}

export interface FraudFlagReviewStateRow {
  readonly state: 'dismissed' | 'open' | 'upheld';
}

export interface FraudReviewRepository {
  findState(flagId: string): Promise<FraudFlagReviewStateRow | null>;
  listOpen(limit: number): Promise<readonly OpenFraudFlagRow[]>;
  review(
    flagId: string,
    outcome: FraudReviewOutcome,
    actor: string,
  ): Promise<number>;
}

export function createFraudReviewRepository(
  database: DatabaseConnection,
): FraudReviewRepository {
  return {
    findState(flagId) {
      return database.readOne<FraudFlagReviewStateRow>({
        text: 'SELECT state FROM fraud_flag WHERE id = $1',
        values: [flagId],
      });
    },
    listOpen(limit) {
      return database.list<OpenFraudFlagRow>(
        {
          text: `
            SELECT
              f.id::text,
              f.subscriber_id::text,
              f.kind,
              f.detail,
              f.created_at AS raised_at,
              CASE f.kind
                WHEN 'manual' THEN 1
                WHEN 'ip_velocity' THEN 2
                WHEN 'duplicate_identity' THEN 3
                WHEN 'self_referral' THEN 4
                WHEN 'disposable_domain' THEN 5
                WHEN 'challenge_timeout' THEN 6
                WHEN 'no_mx' THEN 7
                ELSE 8
              END AS priority,
              s.status,
              s.email_domain,
              s.country,
              s.confirmed_referrals,
              s.referral_tier,
              s.verified_at,
              s.created_at AS subscriber_created_at
            FROM fraud_flag f
            JOIN subscriber s ON s.id = f.subscriber_id
            WHERE f.state = 'open'
            ORDER BY priority ASC, f.created_at ASC, f.id ASC
          `,
        },
        limit,
      );
    },
    review(flagId, outcome, actor) {
      return database.execute({
        text: `
          UPDATE fraud_flag
          SET state = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND state = 'open'
        `,
        values: [flagId, outcome, actor],
      });
    },
  };
}
