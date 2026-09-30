import {
  createEmailWebhookRepository,
  maxEmailReconciliationBatch,
  type BrevoReconciliationStream,
} from '../db/email-webhook.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { normaliseEmail } from '../subscriber/normalise-email.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

import type { BrevoContactProvider } from './providers/brevo.ts';
import { parseDeliveryEvent } from './webhook-events.ts';

const maxReconciliationRun = 1_000;
const windowDays = 2;
const dayMs = 24 * 60 * 60 * 1_000;

export function createEmailReconciliationJob(
  database: DatabasePool,
  brevo: Pick<
    BrevoContactProvider,
    'listReconciliationEvents' | 'listBlockedContacts'
  > | null,
  alerts: AlertTransport,
  clock: () => Date,
  resendGapMinutes: number,
) {
  if (
    !Number.isInteger(resendGapMinutes) ||
    resendGapMinutes < 1 ||
    resendGapMinutes > 1440
  )
    throw new RangeError('Resend webhook gap window is out of range.');

  async function resendGaps(limit: number): Promise<number> {
    const at = clock();
    const cutoff = new Date(at.getTime() - resendGapMinutes * 60_000);
    return withTransaction(database, async (connection) => {
      const repository = createEmailWebhookRepository(connection);
      const ids = await repository.findResendGaps(
        cutoff,
        Math.min(limit, maxEmailReconciliationBatch),
      );
      if (ids.length === 0) return 0;
      await alerts.send({
        event: 'email_webhook_gap',
        detail: {
          kind: 'operator_task',
          task: 'replay_resend_webhooks',
          count: ids.length,
          email_send_ids: ids.join(','),
        },
        occurredAt: at,
        severity: 'P2',
      });
      await repository.markResendGaps(ids, at);
      return ids.length;
    });
  }

  async function brevoStream(
    stream: BrevoReconciliationStream,
    startDate: string,
    endDate: string,
    budget: number,
  ): Promise<number> {
    if (brevo === null) return 0;
    let scannedTotal = 0;
    while (scannedTotal < budget) {
      const offset = await createEmailWebhookRepository(
        database,
      ).reconciliationOffset(stream, startDate);
      const limit = Math.min(
        maxEmailReconciliationBatch,
        budget - scannedTotal,
      );
      const page =
        stream === 'brevo_blocklist'
          ? await brevo.listBlockedContacts({
              startDate,
              endDate,
              offset,
              limit,
            })
          : await brevo.listReconciliationEvents({
              event: stream === 'brevo_hard_bounce' ? 'hardBounces' : 'spam',
              startDate,
              endDate,
              offset,
              limit,
            });
      if (
        !Number.isInteger(page.scanned) ||
        page.scanned < 0 ||
        page.scanned > limit ||
        page.items.length > page.scanned
      )
        throw new Error('brevo_reconciliation_page_invalid');
      await withTransaction(database, async (connection) => {
        const repository = createEmailWebhookRepository(connection);
        if (stream === 'brevo_blocklist') {
          for (const item of page.items as readonly {
            email: string;
            reason: 'bounce_hard' | 'complaint';
          }[]) {
            const address = normaliseEmail(item.email);
            if (address === null)
              throw new Error('brevo_reconciliation_page_invalid');
            await repository.suppressAddress(
              address.normalised,
              item.reason,
              'brevo',
              clock(),
            );
          }
        } else {
          for (const item of page.items as readonly {
            email: string;
            messageId: string;
            event: 'hard_bounce' | 'spam';
          }[]) {
            const parsed = parseDeliveryEvent('brevo', {
              email: item.email,
              'message-id': item.messageId,
              event: item.event,
            });
            if (parsed === null)
              throw new Error('brevo_reconciliation_page_invalid');
            await repository.record({ ...parsed, at: clock() });
          }
        }
        await repository.advanceReconciliationOffset(
          stream,
          startDate,
          offset,
          page.scanned,
        );
      });
      scannedTotal += page.scanned;
      if (page.scanned < limit) break;
    }
    return scannedTotal;
  }

  return {
    async run(
      limit: number,
    ): Promise<{
      resendGaps: number;
      brevoScanned: number;
      brevoPaused: boolean;
    }> {
      if (!Number.isInteger(limit) || limit < 1 || limit > maxReconciliationRun)
        throw new RangeError('Email reconciliation limit is out of range.');
      const gaps = await resendGaps(limit);
      if (brevo === null)
        return { resendGaps: gaps, brevoScanned: 0, brevoPaused: true };
      const now = clock();
      const startDate = new Date(now.getTime() - windowDays * dayMs)
        .toISOString()
        .slice(0, 10);
      const endDate = now.toISOString().slice(0, 10);
      let remaining = limit;
      let scanned = 0;
      for (const stream of [
        'brevo_hard_bounce',
        'brevo_spam',
        'brevo_blocklist',
      ] as const) {
        if (remaining === 0) break;
        const count = await brevoStream(stream, startDate, endDate, remaining);
        scanned += count;
        remaining -= count;
      }
      return { resendGaps: gaps, brevoScanned: scanned, brevoPaused: false };
    },
  };
}
