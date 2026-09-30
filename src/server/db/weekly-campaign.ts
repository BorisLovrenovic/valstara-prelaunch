import type { DatabaseConnection } from './pool.ts';

export const maxWeeklyQueueBatch = 100;

export function createWeeklyCampaignRepository(db: DatabaseConnection) {
  return {
    run(isoWeek: string): Promise<{
      state: string;
      snapshot_id: string | null;
      alerted_at: Date | null;
    } | null> {
      return db.readOne({
        text: 'SELECT state, snapshot_id, alerted_at FROM weekly_campaign_run WHERE iso_week = $1',
        values: [isoWeek],
      });
    },
    async start(isoWeek: string, snapshotId: string, now: Date): Promise<void> {
      await db.execute({
        text: `INSERT INTO weekly_campaign_run (iso_week, state, snapshot_id, recorded_at)
          VALUES ($1, 'started', $2, $3) ON CONFLICT (iso_week) DO NOTHING`,
        values: [isoWeek, snapshotId, now],
      });
    },
    async skip(isoWeek: string, now: Date): Promise<boolean> {
      return (
        (await db.execute({
          text: `INSERT INTO weekly_campaign_run (iso_week, state, recorded_at)
          VALUES ($1, 'skipped', $2) ON CONFLICT (iso_week) DO UPDATE
          SET state = 'skipped', recorded_at = EXCLUDED.recorded_at
          WHERE weekly_campaign_run.state IN ('started', 'completed')`,
          values: [isoWeek, now],
        })) > 0
      );
    },
    async complete(isoWeek: string): Promise<void> {
      await db.execute({
        text: `UPDATE weekly_campaign_run SET state = 'completed'
          WHERE iso_week = $1 AND state = 'started'`,
        values: [isoWeek],
      });
    },
    async markAlerted(isoWeek: string, now: Date): Promise<void> {
      await db.execute({
        text: `UPDATE weekly_campaign_run SET alerted_at = $2
          WHERE iso_week = $1 AND state = 'skipped' AND alerted_at IS NULL`,
        values: [isoWeek, now],
      });
    },
    async unsent(isoWeek: string): Promise<number> {
      const row = await db.readOne<{ count: string }>({
        text: `SELECT COUNT(*)::text AS count FROM email_send
          WHERE template = 'weekly_campaign_update'
            AND business_key LIKE 'weekly:' || $1 || ':%'
            AND (state = 'queued' OR last_error = 'send_window_expired')`,
        values: [isoWeek],
      });
      return Number(row?.count ?? '0');
    },
    eligible(
      isoWeek: string,
      limit: number,
    ): Promise<readonly { id: string }[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > maxWeeklyQueueBatch)
        throw new RangeError('Weekly queue batch is out of range.');
      return db.list(
        {
          text: `SELECT s.id FROM subscriber s
          WHERE s.status = 'verified' AND s.marketing_consent_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM suppression x
              WHERE x.email_normalised = s.email_normalised)
            AND NOT EXISTS (SELECT 1 FROM email_send e
              WHERE e.business_key = 'weekly:' || $1 || ':' || s.id::text)
          ORDER BY s.id`,
          values: [isoWeek],
        },
        limit,
      );
    },
    async eligibleId(isoWeek: string, id: string): Promise<boolean> {
      return (
        (await db.readOne({
          text: `SELECT s.id FROM subscriber s WHERE s.id = $2
          AND s.status = 'verified' AND s.marketing_consent_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM suppression x
            WHERE x.email_normalised = s.email_normalised)
          AND NOT EXISTS (SELECT 1 FROM email_send e
            WHERE e.business_key = 'weekly:' || $1 || ':' || s.id::text)`,
          values: [isoWeek, id],
        })) !== null
      );
    },
  };
}
