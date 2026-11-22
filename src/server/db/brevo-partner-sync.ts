import {
  contractedPartnerColumns,
  contractedPartnerRows,
  type PartnerExportRow,
} from './partner-review.ts';
import type { DatabaseConnection } from './pool.ts';

export const maxPartnerSyncBatch = 500;

type DesiredContact = PartnerExportRow & { readonly fingerprint: Buffer };

const desiredContact = (filter: string) => `
  SELECT contact.*, sha256(convert_to(to_jsonb(contact)::text, 'UTF8')) AS fingerprint
  FROM (SELECT ${contractedPartnerColumns}, s.id AS subscriber_id
    ${contractedPartnerRows} ${filter}) contact`;

export function createBrevoPartnerSyncRepository(database: DatabaseConnection) {
  return {
    candidates(listId: number, limit: number) {
      if (!Number.isInteger(limit) || limit < 1 || limit > maxPartnerSyncBatch)
        throw new RangeError('Brevo partner sync batch is out of range.');
      return database.list<{ subscriber_id: string }>(
        {
          text: `SELECT COALESCE(desired.subscriber_id, applied.subscriber_id) AS subscriber_id
          FROM (${desiredContact('')}) desired
          FULL JOIN (SELECT b.subscriber_id, b.fingerprint FROM brevo_partner_sync b
            JOIN subscriber s ON s.id = b.subscriber_id
            WHERE b.list_id = $1 AND s.status NOT IN ('erasure_pending', 'erased')) applied
            ON applied.subscriber_id = desired.subscriber_id
          WHERE desired.subscriber_id IS NULL OR desired.fingerprint IS DISTINCT FROM applied.fingerprint
          ORDER BY (desired.subscriber_id IS NOT NULL), subscriber_id`,
          values: [listId],
        },
        limit,
      );
    },
    lockSubscriber(id: string) {
      return database.readOne<{ email_normalised: string }>({
        text: `SELECT email_normalised FROM subscriber
          WHERE id = $1 AND status NOT IN ('erasure_pending', 'erased') FOR SHARE`,
        values: [id],
      });
    },
    desired(id: string) {
      return database.readOne<DesiredContact>({
        text: desiredContact('AND s.id = $1'),
        values: [id],
      });
    },
    async stage(id: string, listId: number) {
      await database.execute({
        text: `INSERT INTO brevo_partner_sync (subscriber_id, list_id)
          SELECT s.id, $2 ${contractedPartnerRows} AND s.id = $1
          ON CONFLICT (subscriber_id, list_id) DO NOTHING`,
        values: [id, listId],
      });
    },
    lockApplication(id: string, listId: number) {
      return database.readOne<{ fingerprint: Buffer | null }>({
        text: `SELECT fingerprint FROM brevo_partner_sync
          WHERE subscriber_id = $1 AND list_id = $2 FOR NO KEY UPDATE`,
        values: [id, listId],
      });
    },
    async record(id: string, listId: number, fingerprint: Buffer, now: Date) {
      await database.execute({
        text: `UPDATE brevo_partner_sync SET fingerprint = $3, synced_at = $4
          WHERE subscriber_id = $1 AND list_id = $2`,
        values: [id, listId, fingerprint, now],
      });
    },
    async forget(id: string, listId: number) {
      await database.execute({
        text: 'DELETE FROM brevo_partner_sync WHERE subscriber_id = $1 AND list_id = $2',
        values: [id, listId],
      });
    },
  };
}
