import type { DatabaseConnection } from './pool.ts';

export interface BoundUnsubscribe {
  readonly email_send_id: string;
  readonly subscriber_id: string;
  readonly template: string;
  readonly provider: string;
  readonly email_normalised: string;
  readonly marketing_consent_at: Date | null;
  readonly suppressed: boolean;
}

export interface StatusUnsubscribeSubject {
  readonly email_normalised: string;
  readonly status: string;
  readonly suppressed: boolean;
}

export function createUnsubscribeRepository(connection: DatabaseConnection) {
  return {
    statusSubject(
      subscriberId: string,
    ): Promise<StatusUnsubscribeSubject | null> {
      return connection.readOne<StatusUnsubscribeSubject>({
        text: `SELECT s.email_normalised, s.status,
          EXISTS (SELECT 1 FROM suppression x WHERE x.email_normalised = s.email_normalised) AS suppressed
          FROM subscriber s WHERE s.id = $1`,
        values: [subscriberId],
      });
    },
    boundSend(tokenId: string): Promise<BoundUnsubscribe | null> {
      return connection.readOne<BoundUnsubscribe>({
        text: `SELECT e.id AS email_send_id, e.subscriber_id, e.template,
          e.provider, s.email_normalised, s.marketing_consent_at,
          EXISTS (SELECT 1 FROM suppression x
            WHERE x.email_normalised = s.email_normalised) AS suppressed
          FROM email_send e
          JOIN subscriber s ON s.id = e.subscriber_id
          WHERE e.unsubscribe_token_id = $1`,
        values: [tokenId],
      });
    },
    async withdrawMarketing(subscriberId: string, at: Date): Promise<boolean> {
      return (
        (await connection.execute({
          text: `UPDATE subscriber SET marketing_consent_at = NULL,
          marketing_consent_version = NULL,
          marketing_consent_source = NULL, updated_at = $2
          WHERE id = $1 AND marketing_consent_at IS NOT NULL`,
          values: [subscriberId, at],
        })) === 1
      );
    },
    async leaveWaitlist(subscriberId: string, at: Date): Promise<boolean> {
      return (
        (await connection.execute({
          text: `UPDATE subscriber SET status = 'unsubscribed',
          unsubscribed_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'verified'`,
          values: [subscriberId, at],
        })) === 1
      );
    },
    async suppress(
      emailNormalised: string,
      template: string,
      at: Date,
    ): Promise<void> {
      await connection.execute({
        text: `INSERT INTO suppression
          (email_normalised, reason, source, created_at)
          VALUES ($1, 'unsubscribe', $2, $3)
          ON CONFLICT (email_normalised) DO NOTHING`,
        values: [emailNormalised, template, at],
      });
    },
  };
}
