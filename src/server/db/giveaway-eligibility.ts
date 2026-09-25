import type { DatabaseConnection } from './pool.ts';

export interface GiveawayEligibilityRepository {
  statusFor(subscriberId: string): Promise<string | null>;
}

export function createGiveawayEligibilityRepository(
  database: DatabaseConnection,
): GiveawayEligibilityRepository {
  return {
    async statusFor(subscriberId) {
      const row = await database.readOne<{ status: string }>({
        text: 'SELECT status FROM subscriber WHERE id = $1',
        values: [subscriberId],
      });
      return row?.status ?? null;
    },
  };
}
