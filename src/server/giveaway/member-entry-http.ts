import type { APIRoute } from 'astro';

import { memberStatusCopy } from '../../copy/member-status.ts';
import { DatabaseUnavailableError } from '../db/errors.ts';
import { hashedIpPrefix } from '../ratelimit/ip-prefix.ts';
import type { TurnstileOutcome } from '../turnstile/verify.ts';

import type {
  GiveawayMemberEntryInput,
  GiveawayMemberEntryOutcome,
} from './member-entry.ts';

export interface GiveawayEntryRouteDependencies {
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
  readonly enter: (
    input: GiveawayMemberEntryInput,
  ) => Promise<GiveawayMemberEntryOutcome>;
  readonly ipPrefixPepper: string;
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

const errorStatus = {
  invalid_input: 400,
  challenge_failed: 400,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
} as const;

function errorResponse(
  code: keyof typeof errorStatus,
  message: string,
): Response {
  return jsonResponse(errorStatus[code], { error: { code, message } });
}

/**
 * `POST /api/me/giveaway` (E11.8-06): the `/me` form with the 18+ giveaway
 * box, on the `POST /api/me/marketing` pattern. Turnstile is verified before
 * anything else; the service then reads the flags, rate-limits and
 * authenticates the status link. A tampered or expired link, a repeat and a
 * first entry get the same accepted response.
 */
export function createGiveawayEntryRoute(
  dependencies: GiveawayEntryRouteDependencies,
): APIRoute {
  const copy = memberStatusCopy.giveaway;
  return async ({ clientAddress, request }) => {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse('invalid_input', copy.invalidInput);
    }

    const turnstileToken = formData.get('turnstile_token');
    if (typeof turnstileToken !== 'string' || turnstileToken === '') {
      return errorResponse('challenge_failed', copy.challengeFailed);
    }
    let challenge: TurnstileOutcome;
    try {
      challenge = await dependencies.verifyTurnstile(turnstileToken);
    } catch {
      challenge = 'unavailable';
    }
    if (challenge === 'rejected') {
      return errorResponse('challenge_failed', copy.challengeFailed);
    }

    const token = formData.get('t');
    if (
      formData.get('giveaway_opt_in') !== 'yes' ||
      typeof token !== 'string'
    ) {
      return errorResponse('invalid_input', copy.invalidInput);
    }

    const ipPrefixHash =
      hashedIpPrefix(clientAddress, dependencies.ipPrefixPepper) ?? '';
    try {
      const outcome = await dependencies.enter({
        challengeTimedOut: challenge === 'unavailable',
        ipPrefixHash,
        token,
      });
      if (outcome === 'rate_limited') {
        return errorResponse('rate_limited', copy.rateLimited);
      }
      if (outcome === 'disabled') {
        return errorResponse('unavailable', copy.paused);
      }
      if (outcome === 'closed') {
        return errorResponse('unavailable', copy.closed);
      }
      return jsonResponse(200, { status: 'accepted', message: copy.saved });
    } catch (error) {
      return error instanceof DatabaseUnavailableError
        ? errorResponse('unavailable', copy.unavailable)
        : errorResponse('internal', copy.unavailable);
    }
  };
}
