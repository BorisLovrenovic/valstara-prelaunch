import type { DatabaseConnection } from './pool.ts';

export type QuotaProvider = 'resend' | 'brevo';

export interface QuotaDailyRow {
  readonly provider: QuotaProvider;
  readonly day: string;
  readonly total: string;
}

export function createEmailQuotaRepository(database: DatabaseConnection) {
  return {
    dailyAccepted(start: Date, end: Date): Promise<readonly QuotaDailyRow[]> {
      return database.list<QuotaDailyRow>(
        {
          text: `SELECT provider, day::text, SUM(total)::text AS total FROM (
            SELECT provider, (accepted_at AT TIME ZONE 'UTC')::date AS day,
              COUNT(*)::bigint AS total FROM email_send
            WHERE accepted_at >= $1 AND accepted_at < $2
              AND provider IN ('resend', 'brevo')
            GROUP BY provider, day
            UNION ALL
            SELECT 'resend', (sent_at AT TIME ZONE 'UTC')::date,
              COUNT(*)::bigint FROM email_seed_test
            WHERE sent_at >= $1 AND sent_at < $2 GROUP BY 2
            UNION ALL
            SELECT 'brevo', (sent_at AT TIME ZONE 'UTC')::date,
              COUNT(*)::bigint FROM email_broadcast_seed_test
            WHERE sent_at >= $1 AND sent_at < $2 GROUP BY 2
          ) accepted GROUP BY provider, day ORDER BY provider, day`,
          values: [start, end],
        },
        16,
      );
    },
    async currentBroadcastAudience(): Promise<number> {
      const row = await database.readOne<{ count: string }>({
        text: `SELECT COUNT(*)::text AS count FROM subscriber s
          WHERE s.status = 'verified' AND s.marketing_consent_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM suppression x
              WHERE x.email_normalised = s.email_normalised)`,
      });
      return Number(row?.count ?? '0');
    },
    async lockAlert(provider: QuotaProvider, day: string): Promise<void> {
      await database.readOne({
        text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        values: [`email-quota:${provider}:${day}`],
      });
    },
    async hasAlert(
      provider: QuotaProvider,
      day: string,
      severity: 'P1' | 'P2',
    ): Promise<boolean> {
      return (
        (await database.readOne({
          text: `SELECT 1 FROM email_quota_alert
            WHERE provider = $1 AND day = $2 AND severity = $3`,
          values: [provider, day, severity],
        })) !== null
      );
    },
    async recordAlert(
      provider: QuotaProvider,
      day: string,
      severity: 'P1' | 'P2',
      at: Date,
    ): Promise<void> {
      await database.execute({
        text: `INSERT INTO email_quota_alert (provider, day, severity, alerted_at)
          VALUES ($1, $2, $3, $4)`,
        values: [provider, day, severity, at],
      });
    },
  };
}
