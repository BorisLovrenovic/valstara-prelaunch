import type { SeedProvider } from './seed-test.ts';
import type { DatabaseConnection } from './pool.ts';

export type BroadcastSeedState =
  | 'pending'
  | 'passed'
  | 'missing_plain_part'
  | 'tracking_pixel'
  | 'rewritten_link'
  | 'missing';

export interface BroadcastSeedRow {
  readonly marker: string;
  readonly state: BroadcastSeedState;
  readonly sent_at: Date | null;
  readonly alerted_at: Date | null;
}

export function createBroadcastSeedRepository(database: DatabaseConnection) {
  return {
    async ensure(
      weekStart: Date,
      provider: SeedProvider,
      marker: string,
    ): Promise<BroadcastSeedRow> {
      const week = weekStart.toISOString().slice(0, 10);
      await database.execute({
        text: `INSERT INTO email_broadcast_seed_test (week_start, provider, marker)
          VALUES ($1, $2, $3) ON CONFLICT (week_start, provider) DO NOTHING`,
        values: [week, provider, marker],
      });
      const row = await database.readOne<BroadcastSeedRow>({
        text: `SELECT marker, state, sent_at, alerted_at
          FROM email_broadcast_seed_test WHERE week_start = $1 AND provider = $2`,
        values: [week, provider],
      });
      if (row === null) throw new Error('broadcast_seed_record_unavailable');
      return row;
    },
    async markSent(
      weekStart: Date,
      provider: SeedProvider,
      at: Date,
    ): Promise<void> {
      await database.execute({
        text: `UPDATE email_broadcast_seed_test SET sent_at = COALESCE(sent_at, $3)
          WHERE week_start = $1 AND provider = $2`,
        values: [weekStart.toISOString().slice(0, 10), provider, at],
      });
    },
    async markChecked(
      weekStart: Date,
      provider: SeedProvider,
      state: BroadcastSeedState,
      at: Date,
    ): Promise<void> {
      await database.execute({
        text: `UPDATE email_broadcast_seed_test SET state = $3, checked_at = $4,
          alerted_at = CASE WHEN state <> $3 THEN NULL ELSE alerted_at END
          WHERE week_start = $1 AND provider = $2 AND state <> 'passed'`,
        values: [weekStart.toISOString().slice(0, 10), provider, state, at],
      });
    },
    async markAlerted(
      weekStart: Date,
      provider: SeedProvider,
      at: Date,
    ): Promise<void> {
      await database.execute({
        text: `UPDATE email_broadcast_seed_test SET alerted_at = COALESCE(alerted_at, $3)
          WHERE week_start = $1 AND provider = $2`,
        values: [weekStart.toISOString().slice(0, 10), provider, at],
      });
    },
  };
}
