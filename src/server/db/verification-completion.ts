import type { DatabaseConnection } from './pool.ts';

export interface VerificationCompletionRepository {
  markVerified(subscriberId: string, now: Date): Promise<number>;
}

export function createVerificationCompletionRepository(
  database: DatabaseConnection,
): VerificationCompletionRepository {
  return {
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
