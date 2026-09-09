import type { APIRoute } from 'astro';
import { setTimeout as systemSleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import { resendVerificationCopy } from '../../copy/resend-verification.ts';
import { getConfig } from '../../server/config.ts';
import { createFraudFlagRepository } from '../../server/db/fraud-flag.ts';
import { createPool, type DatabasePool } from '../../server/db/pool.ts';
import { consumeRateLimit } from '../../server/ratelimit/consume.ts';
import { hashedIpPrefix } from '../../server/ratelimit/ip-prefix.ts';
import { normaliseEmail } from '../../server/subscriber/normalise-email.ts';
import {
  createResendVerificationService,
  type ResendVerificationInput,
  type ResendVerificationOutcome,
} from '../../server/subscriber/resend-verification.ts';
import {
  verifyTurnstileToken,
  type TurnstileOutcome,
} from '../../server/turnstile/verify.ts';

export const resendVerificationRateLimitWindowMs = 15 * 60 * 1_000;
export const resendVerificationAddressLimit = 1;
export const resendVerificationIpPrefixLimit = 5;
export const resendVerificationStrictIpPrefixLimit = 2;
export const resendVerificationMinimumResponseMs = 250;
export const resendVerificationResponseTargetMs = 500;

const invalidAddressRateLimitKey = 'invalid';

export interface ResendVerificationRouteDependencies {
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
  readonly consumeAddressRateLimit: (
    emailNormalised: string,
    now: Date,
  ) => Promise<'ok' | 'rate_limited'>;
  readonly consumeIpRateLimit: (
    ipAddress: string,
    now: Date,
    strict: boolean,
  ) => Promise<'ok' | 'rate_limited'>;
  readonly resendVerification: (
    input: ResendVerificationInput,
  ) => Promise<ResendVerificationOutcome>;
  readonly flagChallengeTimeout: (subscriberId: string) => Promise<void>;
  readonly clock?: () => Date;
  readonly monotonicClock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
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
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function acceptedResponse(): Response {
  return jsonResponse(200, {
    status: 'pending',
    message: resendVerificationCopy.accepted,
  });
}

function errorResponse(
  code: 'challenge_failed' | 'rate_limited' | 'unavailable',
): Response {
  const status =
    code === 'challenge_failed' ? 400 : code === 'rate_limited' ? 429 : 503;
  const message =
    code === 'challenge_failed'
      ? resendVerificationCopy.challengeFailed
      : code === 'rate_limited'
        ? resendVerificationCopy.rateLimited
        : resendVerificationCopy.unavailable;
  return jsonResponse(status, { error: { code, message } });
}

export function createResendVerificationRoute(
  dependencies: ResendVerificationRouteDependencies,
): APIRoute {
  const clock = dependencies.clock ?? (() => new Date());
  const monotonicClock =
    dependencies.monotonicClock ??
    (() => Number(process.hrtime.bigint() / 1_000_000n));
  const sleep = dependencies.sleep ?? systemSleep;

  return async ({ clientAddress, request }) => {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      // A malformed body cannot contain a usable challenge token. Do not let
      // it bypass the public write route's challenge boundary.
      return errorResponse('challenge_failed');
    }

    // Turnstile is intentionally the first dependency call on this public
    // write route. A timeout follows the established accept-and-flag policy on
    // signup; no subscriber exists here to flag, so it is treated as unavailable.
    const turnstileToken = formData.get('turnstile_token');
    if (typeof turnstileToken !== 'string') {
      return errorResponse('challenge_failed');
    }
    const challenge = await dependencies.verifyTurnstile(turnstileToken);
    if (challenge === 'rejected') {
      return errorResponse('challenge_failed');
    }
    const challengeTimedOut = challenge === 'unavailable';

    const startedAt = monotonicClock();
    const now = clock();
    const email = formData.get('email');
    const rawEmail = typeof email === 'string' ? email : '';
    const normalised = normaliseEmail(rawEmail);
    const addressKey = normalised?.normalised ?? invalidAddressRateLimitKey;

    try {
      if (
        (await dependencies.consumeIpRateLimit(
          clientAddress,
          now,
          challengeTimedOut,
        )) !== 'ok' ||
        (await dependencies.consumeAddressRateLimit(addressKey, now)) !== 'ok'
      ) {
        return errorResponse('rate_limited');
      }

      const resendWork = (async () => {
        const outcome = await dependencies.resendVerification({
          email: rawEmail,
          now,
          verificationUrl: (token) => {
            const verificationUrl = new URL('/verify', request.url);
            verificationUrl.searchParams.set('token', token);
            return verificationUrl.toString();
          },
        });
        if (challengeTimedOut && outcome.pendingSubscriberId !== null) {
          // The resend path may know the pending subscriber, but that fact
          // never reaches the response. Preserve the established
          // timeout-review signal.
          try {
            await dependencies.flagChallengeTimeout(
              outcome.pendingSubscriberId,
            );
          } catch {
            // The resend work is committed; a failed review marker must not
            // turn a real person's retry into a false failure.
          }
        }
      })();

      const remaining =
        resendVerificationResponseTargetMs - (monotonicClock() - startedAt);
      if (remaining <= 0) {
        // A known-address operation must never make this route take longer
        // than the public response deadline. Its outcome remains private and
        // any later rejection is deliberately consumed.
        void resendWork.catch(() => undefined);
        return acceptedResponse();
      }

      const responseDeadline = sleep(remaining);
      const finishedBeforeDeadline = await Promise.race([
        resendWork.then(
          () => true,
          // Resend work is intentionally private: its failure cannot expose
          // address membership through the public response.
          () => true,
        ),
        responseDeadline.then(() => false),
      ]);
      if (!finishedBeforeDeadline) {
        // The same accepted response is returned at the deadline whether the
        // address is known or unknown. The already-started database work can
        // finish without leaking its outcome through request timing.
        void resendWork.catch(() => undefined);
        return acceptedResponse();
      }

      // Reuse the deadline promise rather than starting a second timer: all
      // successful post-rate-limit paths finish their response window here.
      await responseDeadline;
    } catch {
      return errorResponse('unavailable');
    }

    return acceptedResponse();
  };
}

export function createResendVerificationRateLimits(
  database: DatabasePool,
  ipPrefixPepper: string,
): Pick<
  ResendVerificationRouteDependencies,
  'consumeAddressRateLimit' | 'consumeIpRateLimit'
> {
  return {
    async consumeAddressRateLimit(emailNormalised, now) {
      const count = await consumeRateLimit(
        database,
        `resend-verification:address:${emailNormalised}`,
        resendVerificationRateLimitWindowMs,
        now,
      );
      return count > resendVerificationAddressLimit ? 'rate_limited' : 'ok';
    },
    async consumeIpRateLimit(ipAddress, now, strict) {
      const prefixHash = hashedIpPrefix(ipAddress, ipPrefixPepper);
      if (prefixHash === null) {
        return 'rate_limited';
      }
      const count = await consumeRateLimit(
        database,
        `resend-verification:ip:${prefixHash}`,
        resendVerificationRateLimitWindowMs,
        now,
      );
      const limit = strict
        ? resendVerificationStrictIpPrefixLimit
        : resendVerificationIpPrefixLimit;
      return count > limit ? 'rate_limited' : 'ok';
    },
  };
}

function defaultDependencies(): ResendVerificationRouteDependencies {
  const config = getConfig();
  const rateLimits = createResendVerificationRateLimits(
    getDatabase(),
    config.ipPrefixPepper,
  );
  return {
    verifyTurnstile: (token) => verifyTurnstileToken(token),
    ...rateLimits,
    resendVerification: createResendVerificationService(getDatabase()),
    async flagChallengeTimeout(subscriberId) {
      await createFraudFlagRepository(getDatabase()).insertChallengeTimeoutFlag(
        { id: randomUUID(), subscriberId },
      );
    },
  };
}

export const POST: APIRoute = (context) =>
  createResendVerificationRoute(defaultDependencies())(context);
