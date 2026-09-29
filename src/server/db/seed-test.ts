import type { DatabaseConnection } from './pool.ts';

export type SeedProvider = 'gmail' | 'outlook' | 'gmx' | 'web_de';
export type SeedPlacement = 'pending' | 'inbox' | 'spam' | 'missing';

export interface SeedRow {
  readonly week_start: string;
  readonly provider: SeedProvider;
  readonly marker: string;
  readonly placement: SeedPlacement;
  readonly sent_at: Date | null;
  readonly checked_at: Date | null;
  readonly alerted_at: Date | null;
}

export interface SeedTestRepository {
  ensure(
    weekStart: Date,
    provider: SeedProvider,
    marker: string,
  ): Promise<SeedRow>;
  markSent(weekStart: Date, provider: SeedProvider, at: Date): Promise<void>;
  markPlacement(
    weekStart: Date,
    provider: SeedProvider,
    placement: Exclude<SeedPlacement, 'pending'>,
    at: Date,
  ): Promise<void>;
  markAlerted(weekStart: Date, provider: SeedProvider, at: Date): Promise<void>;
  latest(): Promise<readonly SeedRow[]>;
}

// pg parses DATE as local midnight; text keeps the UTC week key timezone-free.
const columns =
  'week_start::text AS week_start, provider, marker, placement, sent_at, checked_at, alerted_at';
const weekKey = (weekStart: Date): string =>
  weekStart.toISOString().slice(0, 10);

export function createSeedTestRepository(
  database: DatabaseConnection,
): SeedTestRepository {
  return {
    async ensure(weekStart, provider, marker) {
      await database.execute({
        text: `INSERT INTO email_seed_test (week_start, provider, marker)
          VALUES ($1, $2, $3) ON CONFLICT (week_start, provider) DO NOTHING`,
        values: [weekKey(weekStart), provider, marker],
      });
      const row = await database.readOne<SeedRow>({
        text: `SELECT ${columns} FROM email_seed_test
          WHERE week_start = $1 AND provider = $2`,
        values: [weekKey(weekStart), provider],
      });
      if (row === null) throw new Error('seed_record_unavailable');
      return row;
    },
    async markSent(weekStart, provider, at) {
      await database.execute({
        text: `UPDATE email_seed_test SET sent_at = COALESCE(sent_at, $3)
          WHERE week_start = $1 AND provider = $2`,
        values: [weekKey(weekStart), provider, at],
      });
    },
    async markPlacement(weekStart, provider, placement, at) {
      await database.execute({
        text: `UPDATE email_seed_test SET placement = $3, checked_at = $4,
          alerted_at = CASE WHEN placement <> $3 THEN NULL ELSE alerted_at END
          WHERE week_start = $1 AND provider = $2
            AND placement NOT IN ('inbox', 'spam')`,
        values: [weekKey(weekStart), provider, placement, at],
      });
    },
    async markAlerted(weekStart, provider, at) {
      await database.execute({
        text: `UPDATE email_seed_test SET alerted_at = COALESCE(alerted_at, $3)
          WHERE week_start = $1 AND provider = $2`,
        values: [weekKey(weekStart), provider, at],
      });
    },
    latest() {
      return database.list<SeedRow>(
        {
          text: `SELECT ${columns} FROM email_seed_test
          WHERE week_start = (SELECT MAX(week_start) FROM email_seed_test)
          ORDER BY provider`,
        },
        4,
      );
    },
  };
}
