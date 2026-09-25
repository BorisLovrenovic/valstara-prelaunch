import type { DatabaseConnection } from './pool.ts';

export interface MarketingPreferenceRow {
  readonly marketing_consent_at: Date | null;
  readonly status: string;
}

export interface MarketingRepository {
  findPreference(
    subscriberId: string,
    lock?: boolean,
  ): Promise<MarketingPreferenceRow | null>;
  grant(subscriberId: string, version: string, now: Date): Promise<void>;
  withdraw(subscriberId: string, now: Date): Promise<void>;
}

export function createMarketingRepository(
  database: DatabaseConnection,
): MarketingRepository {
  return {
    findPreference(subscriberId, lock = false) {
      return database.readOne<MarketingPreferenceRow>({
        text: lock
          ? `SELECT status, marketing_consent_at
             FROM (SELECT status, marketing_consent_at FROM subscriber WHERE id = $1 FOR UPDATE) AS locked`
          : 'SELECT status, marketing_consent_at FROM subscriber WHERE id = $1',
        values: [subscriberId],
      });
    },
    async grant(subscriberId, version, now) {
      await database.execute({
        text: `
          UPDATE subscriber
          SET marketing_consent_at = $3,
              marketing_consent_version = $2,
              marketing_consent_source = 'member_status',
              updated_at = $3
          WHERE id = $1 AND status = 'verified' AND marketing_consent_at IS NULL
        `,
        values: [subscriberId, version, now],
      });
    },
    async withdraw(subscriberId, now) {
      await database.execute({
        text: `
          UPDATE subscriber
          SET marketing_consent_at = NULL,
              marketing_consent_version = NULL,
              marketing_consent_source = NULL,
              updated_at = $2
          WHERE id = $1 AND status = 'verified' AND marketing_consent_at IS NOT NULL
        `,
        values: [subscriberId, now],
      });
    },
  };
}
