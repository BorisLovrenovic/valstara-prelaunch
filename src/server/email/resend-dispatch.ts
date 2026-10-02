import { setTimeout as sleep } from 'node:timers/promises';

import type { AppConfig } from '../config.ts';
import type { DatabasePool } from '../db/pool.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';
import { createSharedLeaderboardSnapshotStore } from '../leaderboard/persisted.ts';
import { createRankingIntegrityService } from '../referral/ranking.ts';

import { dsrRenderers } from '../dsr/templates.ts';
import { createResendProvider } from './providers/resend.ts';
import type { BrevoContactProvider } from './providers/brevo.ts';
import { createTransactionalTemplateData } from './transactional-template-data.ts';
import { createTransactionalRenderers } from './transactional-templates.ts';
import { createWeeklyTemplate } from './weekly-template.ts';
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
  renderers?: ReadonlyMap<string, TemplateRenderer>,
  broadcast?: {
    readonly provider: BrevoContactProvider | null;
    readonly isEnabled: () => Promise<boolean>;
  },
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
      ...(broadcast?.provider ? [['brevo', broadcast.provider] as const] : []),
    ]),
    renderers:
      renderers ??
      new Map([
        ...dsrRenderers(config.emailBaseUrl, config.resendSendingDomain),
        ...createTransactionalRenderers({
          baseUrl: config.emailBaseUrl,
          sendingDomain: config.resendSendingDomain,
          data: createTransactionalTemplateData(database),
        }),
        ...(broadcast?.provider
          ? [
              [
                'weekly_campaign_update',
                createWeeklyTemplate({
                  baseUrl: config.emailBaseUrl,
                  sendingDomain: broadcast.provider.sendingDomain,
                  snapshotById: (id) =>
                    createSharedLeaderboardSnapshotStore(
                      database,
                      createRankingIntegrityService(database),
                      clock,
                    ).byId(id),
                }),
              ] as const,
            ]
          : []),
      ]),
    isBroadcastEnabled: broadcast?.isEnabled ?? (async () => false),
    operatorTask: async ({ emailSendId, code, provider }) => {
      await alerts.send({
        event: 'email_send_operator_task',
        detail: { email_send_id: emailSendId, code },
        occurredAt: clock(),
        severity: provider === 'brevo' ? 'P2' : 'P1',
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
