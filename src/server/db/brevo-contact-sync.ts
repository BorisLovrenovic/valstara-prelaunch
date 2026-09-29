import type { DatabaseConnection } from './pool.ts';

export interface BrevoSyncCandidate {
  readonly email_normalised: string;
  readonly email: string;
  readonly eligible: boolean;
}

export const maxBrevoSyncBatch = 100;

export function createBrevoContactSyncRepository(database: DatabaseConnection) {
  return {
    candidates(limit: number): Promise<readonly BrevoSyncCandidate[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > maxBrevoSyncBatch)
        throw new RangeError('Brevo sync batch is out of range.');
      return database.list<BrevoSyncCandidate>(
        {
          text: `SELECT s.email_normalised, s.email,
          (s.status = 'verified' AND s.marketing_consent_at IS NOT NULL
            AND x.email_normalised IS NULL) AS eligible
          FROM subscriber s
          LEFT JOIN suppression x ON x.email_normalised = s.email_normalised
          LEFT JOIN brevo_contact_sync b
            ON b.email_normalised = s.email_normalised
          WHERE (s.status = 'verified' AND s.marketing_consent_at IS NOT NULL
            AND x.email_normalised IS NULL)
              IS DISTINCT FROM COALESCE(b.listed, false)
            OR (b.listed AND b.email IS DISTINCT FROM s.email)
          ORDER BY s.email_normalised`,
        },
        limit,
      );
    },
    async record(candidate: BrevoSyncCandidate, now: Date): Promise<void> {
      await database.execute({
        text: `INSERT INTO brevo_contact_sync
          (email_normalised, email, listed, synced_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (email_normalised) DO UPDATE SET
            email = EXCLUDED.email, listed = EXCLUDED.listed,
            synced_at = EXCLUDED.synced_at`,
        values: [
          candidate.email_normalised,
          candidate.email,
          candidate.eligible,
          now,
        ],
      });
    },
  };
}
