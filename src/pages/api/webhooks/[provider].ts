import type { APIRoute } from 'astro';

import { webhookCopy } from '../../../copy/webhooks.ts';
import { getConfig, getP1AlertConfiguration } from '../../../server/config.ts';
import { createPool, type DatabasePool } from '../../../server/db/pool.ts';
import { createEmailWebhookIngestor } from '../../../server/email/webhook-events.ts';
import { createEmailWebhookReceiver } from '../../../server/email/webhook-receiver.ts';
import { createAlertWebhookTransport } from '../../../server/verification-rate/p1-webhook.ts';

export const prerender = false;

let database: DatabasePool | undefined;
function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

let receiver: ReturnType<typeof createEmailWebhookReceiver> | undefined;
function getReceiver(): ReturnType<typeof createEmailWebhookReceiver> {
  if (receiver === undefined) {
    const config = getConfig();
    const clock = (): Date => new Date();
    receiver = createEmailWebhookReceiver({
      resendSecret: config.resendWebhookSecret,
      brevoToken: config.brevoWebhookToken,
      ingest: createEmailWebhookIngestor(getDatabase(), clock).ingest,
      alerts: createAlertWebhookTransport(getP1AlertConfiguration()),
      clock,
    });
  }
  return receiver;
}

export function createWebhookRoute(
  handler: Pick<ReturnType<typeof createEmailWebhookReceiver>, 'handle'>,
): APIRoute {
  return async ({ params, request }) => {
    const result = await handler.handle(params.provider ?? '', request);
    if (result.status === 200)
      return new Response(null, {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      });
    const message =
      result.code === 'unauthorized'
        ? webhookCopy.unauthorized
        : result.code === 'unavailable'
          ? webhookCopy.unavailable
          : webhookCopy.invalid;
    return new Response(
      JSON.stringify({ error: { code: result.code, message } }),
      {
        status: result.status,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
  };
}

export const POST: APIRoute = (context) =>
  createWebhookRoute(getReceiver())(context);
