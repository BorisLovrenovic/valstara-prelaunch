import type { DatabaseConnection } from './pool.ts';

export interface SurveyResponseRow {
  readonly answers: unknown;
  readonly version: string;
}

export interface SurveyResponseWrite {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly subscriberId: string;
  readonly version: string;
}

export interface SurveyResponseRepository {
  lockSubscriberStatus(subscriberId: string): Promise<string | null>;
  find(subscriberId: string): Promise<SurveyResponseRow | null>;
  insert(input: SurveyResponseWrite): Promise<void>;
  replace(input: Omit<SurveyResponseWrite, 'id'>): Promise<void>;
  setCategoryPreference(
    subscriberId: string,
    categories: readonly string[] | null,
  ): Promise<void>;
}

export function createSurveyResponseRepository(
  database: DatabaseConnection,
): SurveyResponseRepository {
  return {
    async lockSubscriberStatus(subscriberId) {
      const row = await database.readOne<{ status: string }>({
        text: 'SELECT status FROM subscriber WHERE id = $1 FOR UPDATE',
        values: [subscriberId],
      });
      return row?.status ?? null;
    },
    find(subscriberId) {
      return database.readOne<SurveyResponseRow>({
        text: 'SELECT answers, version FROM survey_response WHERE subscriber_id = $1',
        values: [subscriberId],
      });
    },
    async insert(input) {
      await database.execute({
        text: `
          INSERT INTO survey_response (id, subscriber_id, answers, version)
          VALUES ($1, $2, $3::jsonb, $4)
        `,
        values: [
          input.id,
          input.subscriberId,
          JSON.stringify(input.answers),
          input.version,
        ],
      });
    },
    async replace(input) {
      await database.execute({
        text: `
          UPDATE survey_response
          SET answers = $2::jsonb,
              version = $3
          WHERE subscriber_id = $1
        `,
        values: [
          input.subscriberId,
          JSON.stringify(input.answers),
          input.version,
        ],
      });
    },
    async setCategoryPreference(subscriberId, categories) {
      await database.execute({
        text: `
          UPDATE subscriber
          SET category_preference = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
        values: [subscriberId, categories],
      });
    },
  };
}
