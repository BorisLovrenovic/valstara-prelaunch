import { createHash } from 'node:crypto';

import {
  createEmailWebhookRepository,
  type DeliveryEvent,
  type WebhookProvider,
} from '../db/email-webhook.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { normaliseEmail } from '../subscriber/normalise-email.ts';

export interface ParsedDeliveryEvent {
  readonly provider: WebhookProvider;
  readonly key: string;
  readonly messageId: string;
  readonly emailNormalised: string;
  readonly event: DeliveryEvent;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function address(value: unknown): string | null {
  return typeof value === 'string'
    ? (normaliseEmail(value)?.normalised ?? null)
    : null;
}

function eventKey(
  provider: WebhookProvider,
  messageId: string,
  event: string,
): string {
  return createHash('sha256')
    .update(`${provider}|${messageId}|${event}`, 'utf8')
    .digest('hex');
}

/** Returns null for an irrelevant or soft-bounce event, throws on malformed relevant data. */
export function parseDeliveryEvent(
  provider: WebhookProvider,
  payload: unknown,
  resendEventId?: string,
): ParsedDeliveryEvent | null {
  const body = object(payload);
  if (body === null) throw new Error('webhook_payload_invalid');
  if (provider === 'resend') {
    const kind = body.type;
    if (
      !['email.delivered', 'email.bounced', 'email.complained'].includes(
        String(kind),
      )
    )
      return null;
    const data = object(body.data);
    const recipient =
      Array.isArray(data?.to) && data.to.length === 1
        ? address(data.to[0])
        : null;
    const messageId = data?.email_id;
    if (
      recipient === null ||
      typeof messageId !== 'string' ||
      !messageId ||
      resendEventId === undefined
    )
      throw new Error('webhook_payload_invalid');
    if (kind === 'email.bounced') {
      const bounce = object(data?.bounce);
      if (bounce?.type !== 'Permanent') return null;
    }
    return {
      provider,
      key: resendEventId,
      messageId,
      emailNormalised: recipient,
      event:
        kind === 'email.delivered'
          ? 'delivered'
          : kind === 'email.complained'
            ? 'complaint'
            : 'bounce_hard',
    };
  }
  const kind = body.event;
  if (kind !== 'hard_bounce' && kind !== 'spam') return null;
  const messageId = body['message-id'] ?? body.messageId;
  const recipient = address(body.email);
  if (typeof messageId !== 'string' || !messageId || recipient === null)
    throw new Error('webhook_payload_invalid');
  const canonicalMessageId =
    messageId.startsWith('<') && messageId.endsWith('>')
      ? messageId.slice(1, -1)
      : messageId;
  if (canonicalMessageId === '') throw new Error('webhook_payload_invalid');
  return {
    provider,
    key: eventKey(provider, canonicalMessageId, kind),
    messageId: canonicalMessageId,
    emailNormalised: recipient,
    event: kind === 'spam' ? 'complaint' : 'bounce_hard',
  };
}

export function createEmailWebhookIngestor(
  database: DatabasePool,
  clock: () => Date,
) {
  return {
    async ingest(event: ParsedDeliveryEvent): Promise<boolean> {
      return withTransaction(database, (connection) =>
        createEmailWebhookRepository(connection).record({
          ...event,
          at: clock(),
        }),
      );
    },
  };
}
