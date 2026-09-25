import type { DatabaseConnection } from './pool.ts';

export interface VerificationCompletionRepository {
  hasSurveyResponse(subscriberId: string): Promise<boolean>;
  markVerified(subscriberId: string, now: Date): Promise<number>;
  promotePendingMarketingConsent(
    subscriberId: string,
    now: Date,
  ): Promise<string | null>;
}

export function createVerificationCompletionRepository(
  database: DatabaseConnection,
): VerificationCompletionRepository {
  return {
    async hasSurveyResponse(subscriberId) {
      return (
        (
          await database.readOne<{ present: boolean }>({
            text: `
            SELECT EXISTS (
              SELECT 1 FROM survey_response WHERE subscriber_id = $1
            ) AS present
          `,
            values: [subscriberId],
          })
        )?.present ?? false
      );
    },
    async markVerified(subscriberId, now) {
      return database.execute({
        text: `
          UPDATE subscriber
          SET status = 'verified', verified_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'pending'
        `,
        values: [subscriberId, now],
      });
    },
    async promotePendingMarketingConsent(subscriberId, now) {
      const pending = await database.readOne<{
        marketing_opt_in_pending_version: string;
      }>({
        text: `
          SELECT marketing_opt_in_pending_version
          FROM subscriber
          WHERE id = $1 AND status = 'verified'
            AND marketing_opt_in_pending = true
            AND marketing_consent_at IS NULL
        `,
        values: [subscriberId],
      });
      if (pending === null) return null;
      const updated = await database.execute({
        text: `
          UPDATE subscriber
          SET marketing_consent_at = $2,
              marketing_consent_version = marketing_opt_in_pending_version,
              marketing_consent_source = 'signup',
              marketing_opt_in_pending = false,
              marketing_opt_in_pending_version = NULL,
              updated_at = $2
          WHERE id = $1 AND status = 'verified'
            AND marketing_opt_in_pending = true
            AND marketing_consent_at IS NULL
        `,
        values: [subscriberId, now],
      });
      if (updated !== 1)
        throw new Error('Pending marketing consent was not promoted.');
      return pending.marketing_opt_in_pending_version;
    },
  };
}
