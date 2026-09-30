import { randomUUID } from 'node:crypto';

import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

import {
  authenticateBrevoWebhook,
  authenticateResendWebhook,
} from './webhook-auth.ts';
import {
  parseDeliveryEvent,
  type ParsedDeliveryEvent,
} from './webhook-events.ts';

const maxWebhookBytes = 64 * 1024;
const authenticationFailureWindowMs = 15 * 60 * 1000;
const authenticationFailureThreshold = 3;

export type WebhookResult =
  | { readonly status: 200 }
  | { readonly status: 400; readonly code: 'invalid_input' }
  | { readonly status: 401; readonly code: 'unauthorized' }
  | { readonly status: 503; readonly code: 'unavailable' };

export interface WebhookReceiverDependencies {
  readonly resendSecret: string;
  readonly brevoToken: string;
  readonly ingest: (event: ParsedDeliveryEvent) => Promise<boolean>;
  readonly alerts: AlertTransport;
  readonly clock: () => Date;
  readonly writeFailureLog?: (entry: string) => void;
}

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maxWebhookBytes) {
      await reader.cancel();
      throw new Error('body_invalid');
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(bytes);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.byteLength;
  }
  return result;
}

export function createEmailWebhookReceiver(
  dependencies: WebhookReceiverDependencies,
) {
  const failureCounts = new Map<string, number>();
  let authWindowStart: number | null = null;
  let authFailures = 0;
  let authAlerted = false;

  async function resendFailure(
    reason:
      | 'auth_failed'
      | 'body_invalid'
      | 'payload_invalid'
      | 'storage_unavailable',
    authenticated: boolean,
  ): Promise<void> {
    failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
    const count = failureCounts.get(reason)!;
    (
      dependencies.writeFailureLog ??
      ((line: string) => process.stderr.write(line))
    )(
      `${JSON.stringify({ event: 'email_webhook_request_failed', request_id: randomUUID(), code: reason, count })}\n`,
    );
    if (authenticated) {
      await dependencies.alerts.send({
        event: 'email_webhook_ingest_failed',
        detail: { code: reason },
        occurredAt: dependencies.clock(),
        severity: 'P1',
      });
      return;
    }
    if (reason !== 'auth_failed') return;
    const now = dependencies.clock().getTime();
    if (
      authWindowStart === null ||
      now - authWindowStart >= authenticationFailureWindowMs
    ) {
      authWindowStart = now;
      authFailures = 0;
      authAlerted = false;
    }
    authFailures += 1;
    if (authFailures >= authenticationFailureThreshold && !authAlerted) {
      await dependencies.alerts.send({
        event: 'email_webhook_auth_failed',
        detail: { code: reason, count: authFailures },
        occurredAt: dependencies.clock(),
        severity: 'P2',
      });
      authAlerted = true;
    }
  }

  return {
    failureCounts(): ReadonlyMap<string, number> {
      return new Map(failureCounts);
    },
    async handle(provider: string, request: Request): Promise<WebhookResult> {
      if (provider !== 'resend' && provider !== 'brevo')
        return { status: 400, code: 'invalid_input' };
      if (
        provider === 'brevo' &&
        !authenticateBrevoWebhook(
          request.headers.get('authorization'),
          dependencies.brevoToken,
        )
      )
        return { status: 401, code: 'unauthorized' };
      let raw: Uint8Array;
      try {
        raw = await readLimitedBody(request);
      } catch {
        if (provider === 'resend') await resendFailure('body_invalid', false);
        return { status: 400, code: 'invalid_input' };
      }
      let resendId: string | null = null;
      if (provider === 'resend') {
        resendId = authenticateResendWebhook(
          request.headers,
          raw,
          dependencies.resendSecret,
          dependencies.clock(),
        );
        if (resendId === null) {
          await resendFailure('auth_failed', false);
          return { status: 401, code: 'unauthorized' };
        }
      }
      let event: ParsedDeliveryEvent | null;
      try {
        event = parseDeliveryEvent(
          provider,
          JSON.parse(Buffer.from(raw).toString('utf8')) as unknown,
          resendId ?? undefined,
        );
      } catch {
        if (provider === 'resend') await resendFailure('payload_invalid', true);
        return { status: 400, code: 'invalid_input' };
      }
      if (event === null) return { status: 200 };
      try {
        await dependencies.ingest(event);
        return { status: 200 };
      } catch {
        if (provider === 'resend')
          await resendFailure('storage_unavailable', true);
        return { status: 503, code: 'unavailable' };
      }
    },
  };
}
