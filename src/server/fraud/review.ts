import { createAuditService } from '../audit/service.ts';
import { redactAuditDetail } from '../audit/redact-detail.ts';
import {
  createFraudReviewRepository,
  type FraudReviewOutcome,
} from '../db/fraud-review.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

export const fraudReviewBatchMaximum = 50;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface OpenFraudFlag {
  readonly evidence: ReturnType<typeof redactAuditDetail>;
  readonly id: string;
  readonly kind: string;
  readonly priority: number;
  readonly raisedAt: Date;
  readonly subscriber: {
    readonly confirmedReferrals: number;
    readonly country: string | null;
    readonly createdAt: Date;
    readonly emailDomain: string;
    readonly id: string;
    readonly referralTier: number;
    readonly status: string;
    readonly verifiedAt: Date | null;
  };
}

export interface FraudReviewService {
  openFlags(limit: number): Promise<readonly OpenFraudFlag[]>;
  review(
    flagId: string,
    outcome: FraudReviewOutcome,
    actor: string,
  ): Promise<void>;
}

export class FraudFlagNotFoundError extends Error {
  public constructor() {
    super('Fraud flag was not found.');
    this.name = 'FraudFlagNotFoundError';
  }
}

export class FraudFlagAlreadyReviewedError extends Error {
  public constructor() {
    super('Fraud flag already has a different review outcome.');
    this.name = 'FraudFlagAlreadyReviewedError';
  }
}

export function createFraudReviewService(
  database: DatabasePool,
): FraudReviewService {
  return {
    async openFlags(limit) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > fraudReviewBatchMaximum
      ) {
        throw new RangeError(
          `Fraud review batch limit must be between 1 and ${fraudReviewBatchMaximum}.`,
        );
      }

      const rows = await createFraudReviewRepository(database).listOpen(limit);
      return rows.map((row) => ({
        evidence: redactAuditDetail(row.detail),
        id: row.id,
        kind: row.kind,
        priority: row.priority,
        raisedAt: row.raised_at,
        subscriber: {
          confirmedReferrals: row.confirmed_referrals,
          country: row.country,
          createdAt: row.subscriber_created_at,
          emailDomain: row.email_domain,
          id: row.subscriber_id,
          referralTier: row.referral_tier,
          status: row.status,
          verifiedAt: row.verified_at,
        },
      }));
    },
    async review(flagId, outcome, rawActor) {
      const actor = rawActor.trim();
      if (!uuidPattern.test(flagId)) {
        throw new RangeError('A valid fraud flag id is required.');
      }
      if (outcome !== 'dismissed' && outcome !== 'upheld') {
        throw new RangeError('A valid fraud review outcome is required.');
      }
      if (actor === '') {
        throw new RangeError('An authenticated actor is required.');
      }

      await withTransaction(database, async (connection) => {
        const repository = createFraudReviewRepository(connection);
        const existing = await repository.findState(flagId);
        if (existing === null) {
          throw new FraudFlagNotFoundError();
        }

        if (existing.state === outcome) return;
        if (existing.state === 'dismissed') {
          throw new FraudFlagAlreadyReviewedError();
        }

        const updated = await repository.review(
          flagId,
          outcome,
          actor,
          existing.state,
        );
        if (updated !== 1) throw new FraudFlagAlreadyReviewedError();

        await createAuditService(connection).record({
          action: 'fraud.reviewed',
          actor,
          detail: { outcome },
          subjectId: flagId,
          subjectType: 'fraud_flag',
        });

        if (outcome === 'upheld') {
          const disqualified = await connection.execute({
            text: `
              UPDATE subscriber
              SET
                disqualification_previous_status = status,
                disqualified_by_flag_id = $2,
                disqualified_at = CURRENT_TIMESTAMP,
                status = 'disqualified',
                updated_at = CURRENT_TIMESTAMP
              WHERE id = $1
                AND status <> 'disqualified'
            `,
            values: [existing.subscriber_id, flagId],
          });

          if (disqualified === 1) {
            const rejectedEdges = await connection.execute({
              text: `
                UPDATE referral_edge
                SET
                  state_before_rejection = state,
                  state = 'rejected',
                  rejected_reason = 'referrer_disqualified'
                WHERE referrer_id = $1
                  AND state IN ('attributed', 'confirmed')
              `,
              values: [existing.subscriber_id],
            });
            const voidedEntries = await connection.execute({
              text: `
                UPDATE giveaway_entry
                SET
                  voided_at = CURRENT_TIMESTAMP,
                  voided_by_disqualification_flag_id = $2
                WHERE subscriber_id = $1
                  AND method = 'referral'
                  AND voided_at IS NULL
              `,
              values: [existing.subscriber_id, flagId],
            });
            await createAuditService(connection).record({
              action: 'subscriber.disqualified',
              actor,
              detail: { flagId, rejectedEdges, voidedEntries },
              subjectId: existing.subscriber_id,
              subjectType: 'subscriber',
            });
          }
          return;
        }

        const restored = await connection.execute({
          text: `
            UPDATE subscriber
            SET
              status = disqualification_previous_status,
              disqualified_at = NULL,
              disqualification_previous_status = NULL,
              disqualified_by_flag_id = NULL,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
              AND status = 'disqualified'
              AND disqualified_by_flag_id = $2
          `,
          values: [existing.subscriber_id, flagId],
        });
        if (restored === 1) {
          const restoredEdges = await connection.execute({
            text: `
              UPDATE referral_edge
              SET
                state = state_before_rejection,
                rejected_reason = NULL,
                state_before_rejection = NULL
              WHERE referrer_id = $1
                AND state = 'rejected'
                AND rejected_reason = 'referrer_disqualified'
                AND state_before_rejection IS NOT NULL
            `,
            values: [existing.subscriber_id],
          });
          const restoredEntries = await connection.execute({
            text: `
              UPDATE giveaway_entry
              SET voided_at = NULL, voided_by_disqualification_flag_id = NULL
              WHERE subscriber_id = $1
                AND voided_by_disqualification_flag_id = $2
            `,
            values: [existing.subscriber_id, flagId],
          });
          await createAuditService(connection).record({
            action: 'subscriber.disqualification_reversed',
            actor,
            detail: { flagId, restoredEdges, restoredEntries },
            subjectId: existing.subscriber_id,
            subjectType: 'subscriber',
          });
        }
      });
    },
  };
}
