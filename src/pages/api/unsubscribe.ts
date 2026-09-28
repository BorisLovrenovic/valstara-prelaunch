import type { APIRoute } from 'astro';

import { unsubscribeCopy } from '../../copy/unsubscribe.ts';
import { getConfig, getP1AlertConfiguration } from '../../server/config.ts';
import { createPool, type DatabasePool } from '../../server/db/pool.ts';
import { createUnsubscribeService } from '../../server/email/unsubscribe.ts';
import { hashedIpPrefix } from '../../server/ratelimit/ip-prefix.ts';
import { createUnsubscribeOperatorTaskTransport } from '../../server/verification-rate/p1-webhook.ts';

let database: DatabasePool | undefined;
function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export interface UnsubscribeRouteDependencies {
  readonly apply: ReturnType<typeof createUnsubscribeService>['apply'];
  readonly ipPrefixPepper: string;
}

export function createUnsubscribeRoute(
  dependencies: UnsubscribeRouteDependencies,
): APIRoute {
  return async ({ clientAddress, request, url }) => {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(400, {
        error: { code: 'invalid_input', message: unsubscribeCopy.invalidInput },
      });
    }
    if (form.has('template') || url.searchParams.has('template')) {
      return json(400, {
        error: { code: 'invalid_input', message: unsubscribeCopy.invalidInput },
      });
    }
    if (
      form.get('List-Unsubscribe') !== 'One-Click' ||
      [...form.keys()].some((key) => key !== 'List-Unsubscribe')
    ) {
      return json(400, {
        error: { code: 'invalid_input', message: unsubscribeCopy.invalidInput },
      });
    }
    const token = url.searchParams.get('token');
    if (token === null || token === '') {
      return json(400, {
        error: { code: 'token_invalid', message: unsubscribeCopy.invalid.body },
      });
    }
    try {
      const outcome = await dependencies.apply({
        token,
        action: 'message_unsubscribe',
        ipPrefixHash:
          hashedIpPrefix(clientAddress, dependencies.ipPrefixPepper) ?? '',
        requestId: request.headers.get('x-request-id') ?? undefined,
      });
      if (outcome === 'rate_limited')
        return json(429, {
          error: { code: 'rate_limited', message: unsubscribeCopy.rateLimited },
        });
      if (outcome === 'invalid')
        return json(400, {
          error: {
            code: 'token_invalid',
            message: unsubscribeCopy.invalid.body,
          },
        });
      return json(200, {
        status: 'accepted',
        message: unsubscribeCopy.complete.body,
      });
    } catch {
      return json(503, {
        error: {
          code: 'unavailable',
          message: unsubscribeCopy.unavailable.body,
        },
      });
    }
  };
}

function defaultDependencies(): UnsubscribeRouteDependencies {
  const config = getConfig();
  const alerts = createUnsubscribeOperatorTaskTransport(
    getP1AlertConfiguration(),
  );
  return {
    ipPrefixPepper: config.ipPrefixPepper,
    apply: createUnsubscribeService(getDatabase(), {
      tokenSecret: config.emailTokenSecret,
      onFailure: ({
        unsubscribeTokenId,
        emailSendId,
        tokenSha256,
        requestedAction,
        occurredAt,
      }) =>
        alerts.send({
          kind: 'operator_task',
          task: 'unsubscribe_apply_failed',
          unsubscribe_token_id: unsubscribeTokenId,
          email_send_id: emailSendId,
          token_sha256: tokenSha256,
          requested_action: requestedAction,
          occurred_at: occurredAt.toISOString(),
        }),
    }).apply,
  };
}

export const POST: APIRoute = (context) =>
  createUnsubscribeRoute(defaultDependencies())(context);
