import type { APIRoute } from 'astro';

import { memberStatusCopy } from '../../../copy/member-status.ts';
import { marketingOptInCopy } from '../../../copy/marketing.ts';
import { getConfig } from '../../../server/config.ts';
import { DatabaseUnavailableError } from '../../../server/db/errors.ts';
import { createPool, type DatabasePool } from '../../../server/db/pool.ts';
import { getFlagService } from '../../../server/flags/app-service.ts';
import { hashedIpPrefix } from '../../../server/ratelimit/ip-prefix.ts';
import {
  createMarketingService,
  type MarketingChangeInput,
  type MarketingChangeOutcome,
} from '../../../server/subscriber/marketing.ts';
import {
  verifyTurnstileToken,
  type TurnstileOutcome,
} from '../../../server/turnstile/verify.ts';

export interface MarketingRouteDependencies {
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
  readonly change: (
    input: MarketingChangeInput,
  ) => Promise<MarketingChangeOutcome>;
  readonly ipPrefixPepper: string;
}

let database: DatabasePool | undefined;
function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(
  code:
    | 'invalid_input'
    | 'challenge_failed'
    | 'rate_limited'
    | 'unavailable'
    | 'internal',
): Response {
  const status =
    code === 'rate_limited'
      ? 429
      : code === 'unavailable'
        ? 503
        : code === 'internal'
          ? 500
          : 400;
  const message =
    code === 'invalid_input'
      ? memberStatusCopy.marketing.invalidInput
      : code === 'challenge_failed'
        ? memberStatusCopy.marketing.challengeFailed
        : code === 'rate_limited'
          ? memberStatusCopy.marketing.rateLimited
          : memberStatusCopy.marketing.unavailable;
  return jsonResponse(status, { error: { code, message } });
}

export function createMarketingRoute(
  dependencies: MarketingRouteDependencies,
): APIRoute {
  return async ({ clientAddress, request }) => {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse('invalid_input');
    }

    const turnstileToken = formData.get('turnstile_token');
    if (typeof turnstileToken !== 'string' || turnstileToken === '') {
      return errorResponse('challenge_failed');
    }
    let challenge: TurnstileOutcome;
    try {
      challenge = await dependencies.verifyTurnstile(turnstileToken);
    } catch {
      challenge = 'unavailable';
    }
    if (challenge === 'rejected') return errorResponse('challenge_failed');

    const marketing = formData.get('marketing');
    const token = formData.get('t');
    if (
      (marketing !== 'on' && marketing !== 'off') ||
      typeof token !== 'string'
    ) {
      return errorResponse('invalid_input');
    }

    const ipPrefixHash =
      hashedIpPrefix(clientAddress, dependencies.ipPrefixPepper) ?? '';
    try {
      const outcome = await dependencies.change({
        challengeTimedOut: challenge === 'unavailable',
        ipPrefixHash,
        marketing,
        token,
        version: marketingOptInCopy.version,
      });
      if (outcome === 'rate_limited') return errorResponse('rate_limited');
      if (outcome === 'disabled') {
        return jsonResponse(503, {
          error: {
            code: 'unavailable',
            message: memberStatusCopy.marketing.paused,
          },
        });
      }
      // Expired and tampered bearer links receive this same acknowledgement.
      return jsonResponse(200, {
        status: 'accepted',
        message: memberStatusCopy.marketing.saved,
      });
    } catch (error) {
      return errorResponse(
        error instanceof DatabaseUnavailableError ? 'unavailable' : 'internal',
      );
    }
  };
}

function defaultDependencies(): MarketingRouteDependencies {
  const config = getConfig();
  return {
    verifyTurnstile: (token) => verifyTurnstileToken(token),
    change: (input) =>
      createMarketingService(getDatabase(), { flags: getFlagService() }).change(
        input,
      ),
    ipPrefixPepper: config.ipPrefixPepper,
  };
}

export const POST: APIRoute = (context) =>
  createMarketingRoute(defaultDependencies())(context);
