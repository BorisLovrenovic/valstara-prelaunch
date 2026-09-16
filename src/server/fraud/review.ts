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
        const updated = await repository.review(flagId, outcome, actor);
        if (updated === 0) {
          const existing = await repository.findState(flagId);
          if (existing === null) {
            throw new FraudFlagNotFoundError();
          }
          if (existing.state === outcome) {
            return;
          }
          throw new FraudFlagAlreadyReviewedError();
        }

        await createAuditService(connection).record({
          action: 'fraud.reviewed',
          actor,
          detail: { outcome },
          subjectId: flagId,
          subjectType: 'fraud_flag',
        });
      });
    },
  };
}
