import type { DatabaseConnection } from './pool.ts';

export interface CampaignFlagRow {
  readonly enabled: boolean;
  readonly key: string;
}

export interface CampaignFlagRepository {
  list(keys: readonly string[]): Promise<readonly CampaignFlagRow[]>;
  set(key: string, enabled: boolean, actor: string): Promise<void>;
}

export function createCampaignFlagRepository(
  database: DatabaseConnection,
): CampaignFlagRepository {
  return {
    async list(keys) {
      return database.list<CampaignFlagRow>(
        {
          text: `
            SELECT key, enabled
            FROM campaign_flag
            WHERE key = ANY($1::text[])
            ORDER BY key
          `,
          values: [keys],
        },
        keys.length,
      );
    },
    async set(key, enabled, actor) {
      await database.execute({
        text: `
          INSERT INTO campaign_flag (key, enabled, updated_by)
          VALUES ($1, $2, $3)
          ON CONFLICT (key) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              updated_at = CURRENT_TIMESTAMP,
              updated_by = EXCLUDED.updated_by
        `,
        values: [key, enabled, actor],
      });
    },
  };
}
