import type { DatabaseConnection } from './pool.ts';

export type MailboxProvider =
  'gmail' | 'gmx' | 'microsoft' | 'other' | 'web_de';

export interface VerificationRateCounts {
  readonly signups: number;
  readonly verified: number;
}

export interface ProviderVerificationRateCounts extends VerificationRateCounts {
  readonly provider: MailboxProvider;
}

export interface VerificationRateRepository {
  counts(from: Date, until: Date): Promise<VerificationRateCounts>;
  providerCounts(
    from: Date,
    until: Date,
  ): Promise<readonly ProviderVerificationRateCounts[]>;
}

interface CountRow {
  readonly signups: string;
  readonly verified: string;
}

interface ProviderCountRow extends CountRow {
  readonly provider: MailboxProvider;
}

const providerCase = `
  CASE
    WHEN email_domain IN ('gmail.com', 'googlemail.com') THEN 'gmail'
    WHEN email_domain IN (
      'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'microsoft.com'
    ) THEN 'microsoft'
    WHEN email_domain IN ('gmx.com', 'gmx.net', 'gmx.de') THEN 'gmx'
    WHEN email_domain = 'web.de' THEN 'web_de'
    ELSE 'other'
  END
`;

export function createVerificationRateRepository(
  database: DatabaseConnection,
): VerificationRateRepository {
  return {
    async counts(from, until) {
      const row = await database.readOne<CountRow>({
        text: `
          SELECT
            COUNT(*)::text AS signups,
            COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::text AS verified
          FROM subscriber
          WHERE created_at >= $1 AND created_at < $2
        `,
        values: [from, until],
      });
      return countRow(row);
    },

    async providerCounts(from, until) {
      const rows = await database.list<ProviderCountRow>(
        {
          text: `
            SELECT
              ${providerCase} AS provider,
              COUNT(*)::text AS signups,
              COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::text AS verified
            FROM subscriber
            WHERE created_at >= $1 AND created_at < $2
            GROUP BY provider
            ORDER BY provider
          `,
          values: [from, until],
        },
        5,
      );
      return rows.map((row) => ({
        provider: row.provider,
        ...countRow(row),
      }));
    },
  };
}

function countRow(row: CountRow | null): VerificationRateCounts {
  return {
    signups: Number(row?.signups ?? 0),
    verified: Number(row?.verified ?? 0),
  };
}
