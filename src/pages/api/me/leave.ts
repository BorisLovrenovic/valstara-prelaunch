import type { APIRoute } from 'astro';

import { memberStatusCopy } from '../../../copy/member-status.ts';
import { createAnalyticsService } from '../../../server/analytics/service.ts';
import { getConfig, getP1AlertConfiguration } from '../../../server/config.ts';
import { createPool, type DatabasePool } from '../../../server/db/pool.ts';
import { createUnsubscribeService } from '../../../server/email/unsubscribe.ts';
import { getFlagService } from '../../../server/flags/app-service.ts';
import { hashedIpPrefix } from '../../../server/ratelimit/ip-prefix.ts';
import {
  verifyTurnstileToken,
  type TurnstileOutcome,
} from '../../../server/turnstile/verify.ts';
import { createUnsubscribeOperatorTaskTransport } from '../../../server/verification-rate/p1-webhook.ts';

export interface LeaveRouteDependencies {
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
  readonly isEnabled: () => Promise<boolean>;
  readonly apply: ReturnType<typeof createUnsubscribeService>['apply'];
  readonly ipPrefixPepper: string;
}

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

export function createLeaveRoute(
  dependencies: LeaveRouteDependencies,
): APIRoute {
  return async ({ clientAddress, request }) => {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(400, {
        error: {
          code: 'invalid_input',
          message: memberStatusCopy.leave.invalidInput,
        },
      });
    }
    const challengeToken = form.get('turnstile_token');
    if (typeof challengeToken !== 'string' || challengeToken === '')
      return json(400, {
        error: {
          code: 'challenge_failed',
          message: memberStatusCopy.leave.challengeFailed,
        },
      });
    let challenge: TurnstileOutcome;
    try {
      challenge = await dependencies.verifyTurnstile(challengeToken);
    } catch {
      challenge = 'unavailable';
    }
    if (challenge === 'rejected')
      return json(400, {
        error: {
          code: 'challenge_failed',
          message: memberStatusCopy.leave.challengeFailed,
        },
      });
    const token = form.get('t');
    if (typeof token !== 'string' || token === '')
      return json(400, {
        error: {
          code: 'invalid_input',
          message: memberStatusCopy.leave.invalidInput,
        },
      });
    try {
      if (!(await dependencies.isEnabled()))
        return json(503, {
          error: {
            code: 'unavailable',
            message: memberStatusCopy.leave.unavailable,
          },
        });
      const outcome = await dependencies.apply({
        token,
        credential: 'status',
        action: 'leave_waitlist',
        challengeTimedOut: challenge === 'unavailable',
        ipPrefixHash:
          hashedIpPrefix(clientAddress, dependencies.ipPrefixPepper) ?? '',
        requestId: request.headers.get('x-request-id') ?? undefined,
      });
      if (outcome === 'rate_limited')
        return json(429, {
          error: {
            code: 'rate_limited',
            message: memberStatusCopy.leave.rateLimited,
          },
        });
      // The same accepted result covers an expired or tampered status link.
      return json(200, {
        status: 'accepted',
        message: memberStatusCopy.leave.saved,
      });
    } catch {
      return json(503, {
        error: {
          code: 'unavailable',
          message: memberStatusCopy.leave.unavailable,
        },
      });
    }
  };
}

function defaultDependencies(): LeaveRouteDependencies {
  const config = getConfig();
  const analytics = createAnalyticsService();
  return {
    verifyTurnstile: verifyTurnstileToken,
    isEnabled: () => getFlagService().isEnabled('member.dashboard'),
    ipPrefixPepper: config.ipPrefixPepper,
    apply: (input) => {
      const alerts = createUnsubscribeOperatorTaskTransport(
        getP1AlertConfiguration(),
      );
      return createUnsubscribeService(getDatabase(), {
        onEffectiveChange: () => {
          void analytics
            .track('unsubscribed', {
              source_template: 'member_status',
            })
            .catch(() => {});
        },
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
      }).apply(input);
    },
  };
}

export const POST: APIRoute = (context) =>
  createLeaveRoute(defaultDependencies())(context);
