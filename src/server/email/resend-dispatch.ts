import { setTimeout as sleep } from 'node:timers/promises';

import type { AppConfig } from '../config.ts';
import type { DatabasePool } from '../db/pool.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

import { createResendProvider } from './providers/resend.ts';
import {
  createEmailService,
  maxDispatchBatch,
  type TemplateRenderer,
} from './service.ts';

const dispatchIntervalMs = 60_000;

export function createResendDispatcher(
  database: DatabasePool,
  config: Pick<
    AppConfig,
    'emailBaseUrl' | 'emailTokenSecret' | 'resendApiKey' | 'resendSendingDomain'
  >,
  alerts: AlertTransport,
  clock: () => Date,
  renderers: ReadonlyMap<string, TemplateRenderer> = new Map(),
) {
  return createEmailService(database, {
    clock,
    tokenSecret: config.emailTokenSecret,
    baseUrl: config.emailBaseUrl,
    providers: new Map([
      [
        'resend',
        createResendProvider(config.resendApiKey, config.resendSendingDomain),
      ],
    ]),
    renderers,
    isBroadcastEnabled: async () => false,
    operatorTask: async ({ emailSendId, code }) => {
      await alerts.send({
        event: 'email_send_operator_task',
        detail: { email_send_id: emailSendId, code },
        occurredAt: clock(),
        severity: 'P1',
      });
    },
  });
}

export async function runResendDispatch(
  dispatcher: Pick<ReturnType<typeof createResendDispatcher>, 'dispatch'>,
  alerts: AlertTransport,
  clock: () => Date,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await dispatcher.dispatch(maxDispatchBatch);
    } catch {
      try {
        await alerts.send({
          event: 'email_dispatch_failed',
          detail: { code: 'dispatch_unavailable' },
          occurredAt: clock(),
          severity: 'P1',
        });
      } catch {
        process.stderr.write(
          `${JSON.stringify({ event: 'email_dispatch_alert_failed', code: 'alert_unavailable' })}\n`,
        );
      }
    }
    try {
      await sleep(dispatchIntervalMs, undefined, { signal });
    } catch {
      return;
    }
  }
}
