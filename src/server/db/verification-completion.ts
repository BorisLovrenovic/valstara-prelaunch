import type { DatabaseConnection } from './pool.ts';

export interface VerificationCompletionRepository {
  hasSurveyResponse(subscriberId: string): Promise<boolean>;
  markVerified(subscriberId: string, now: Date): Promise<number>;
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
  };
}
