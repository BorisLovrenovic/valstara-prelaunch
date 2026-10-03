import type { DatabaseConnection } from './pool.ts';

export type WebhookProvider = 'resend' | 'brevo';
export type DeliveryEvent = 'delivered' | 'bounce_hard' | 'complaint';

export const maxEmailReconciliationBatch = 100;
export type BrevoReconciliationStream =
  'brevo_hard_bounce' | 'brevo_spam' | 'brevo_blocklist';

export function createEmailWebhookRepository(database: DatabaseConnection) {
  return {
    async suppressAddress(
      emailNormalised: string,
      reason: 'bounce_hard' | 'complaint',
      source: WebhookProvider,
      at: Date,
    ): Promise<void> {
      // Delayed processor logs must not recreate an erased email. Lock the
      // live subject so suppression and erasure serialize in either order.
      const subject = await database.readOne<{ id: string }>({
        text: `SELECT id FROM subscriber WHERE email_normalised=$1
          AND status NOT IN ('erasure_pending','erased') FOR SHARE`,
        values: [emailNormalised],
      });
      if (subject === null) return;
      await database.execute({
        text: `INSERT INTO suppression (email_normalised, reason, source, created_at)
          VALUES ($1, $2, $3, $4) ON CONFLICT (email_normalised) DO NOTHING`,
        values: [emailNormalised, reason, source, at],
      });
    },
    async record(input: {
      provider: WebhookProvider;
      key: string;
      messageId: string;
      emailNormalised: string;
      event: DeliveryEvent;
      at: Date;
    }): Promise<boolean> {
      const inserted = await database.execute({
        text: `INSERT INTO email_webhook_event (event_key)
          VALUES ($1) ON CONFLICT DO NOTHING`,
        values: [input.key],
      });
      if (inserted === 0) return false;
      if (input.event !== 'delivered') {
        await this.suppressAddress(
          input.emailNormalised,
          input.event,
          input.provider,
          input.at,
        );
      }
      await database.execute({
        text: `UPDATE email_send SET state = $3, updated_at = $4
          WHERE provider = $1 AND
            (provider_message_id = $2 OR
              (provider = 'brevo' AND provider_message_id = '<' || $2 || '>'))
            AND state IN ('sent', 'delivered', 'bounced')
            AND (state <> 'bounced' OR $3 = 'complained')
            AND (state <> 'complained')`,
        values: [
          input.provider,
          input.messageId,
          input.event === 'bounce_hard'
            ? 'bounced'
            : input.event === 'complaint'
              ? 'complained'
              : 'delivered',
          input.at,
        ],
      });
      return true;
    },
    async findResendGaps(
      cutoff: Date,
      limit: number,
    ): Promise<readonly string[]> {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > maxEmailReconciliationBatch
      )
        throw new RangeError('Resend gap batch limit is out of range.');
      const rows = await database.list<{ id: string }>(
        {
          text: `SELECT id FROM email_send
          WHERE provider = 'resend' AND state = 'sent'
            AND gap_alerted_at IS NULL AND updated_at <= $1
          ORDER BY updated_at, id FOR UPDATE SKIP LOCKED`,
          values: [cutoff],
        },
        limit,
      );
      return rows.map((row) => row.id);
    },
    async markResendGaps(ids: readonly string[], at: Date): Promise<void> {
      if (ids.length === 0 || ids.length > maxEmailReconciliationBatch)
        throw new RangeError('Resend gap batch limit is out of range.');
      await database.execute({
        text: `UPDATE email_send SET gap_alerted_at = $2
          WHERE id = ANY($1::uuid[]) AND state = 'sent' AND gap_alerted_at IS NULL`,
        values: [ids, at],
      });
    },
    async reconciliationOffset(
      stream: BrevoReconciliationStream,
      windowStart: string,
    ): Promise<number> {
      await database.execute({
        text: `INSERT INTO email_reconciliation_cursor (stream, window_start, next_offset)
          VALUES ($1, $2::date, 0)
          ON CONFLICT (stream) DO UPDATE SET
            window_start = EXCLUDED.window_start, next_offset = 0
          WHERE email_reconciliation_cursor.window_start <> EXCLUDED.window_start`,
        values: [stream, windowStart],
      });
      const row = await database.readOne<{ next_offset: number }>({
        text: 'SELECT next_offset FROM email_reconciliation_cursor WHERE stream = $1',
        values: [stream],
      });
      if (row === null) throw new Error('email_reconciliation_cursor_missing');
      return row.next_offset;
    },
    async advanceReconciliationOffset(
      stream: BrevoReconciliationStream,
      windowStart: string,
      expected: number,
      scanned: number,
    ): Promise<void> {
      if (scanned < 0 || scanned > maxEmailReconciliationBatch)
        throw new RangeError('Brevo reconciliation page is out of range.');
      const updated = await database.execute({
        text: `UPDATE email_reconciliation_cursor SET next_offset = $4
          WHERE stream = $1 AND window_start = $2::date AND next_offset = $3`,
        values: [stream, windowStart, expected, expected + scanned],
      });
      if (updated !== 1) throw new Error('email_reconciliation_cursor_changed');
    },
  };
}
