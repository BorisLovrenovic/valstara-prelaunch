import type { APIRoute } from 'astro';
import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as systemSleep } from 'node:timers/promises';

import { marketingOptInWordingByVersion } from '../../copy/marketing.ts';
import { sourceBucket } from '../../server/analytics/funnel.ts';
import { createAnalyticsService } from '../../server/analytics/service.ts';
import { signupCopy } from '../../copy/signup.ts';
import { getConfig } from '../../server/config.ts';
import { DatabaseUnavailableError } from '../../server/db/errors.ts';
import { createFraudFlagRepository } from '../../server/db/fraud-flag.ts';
import { createPool, type DatabasePool } from '../../server/db/pool.ts';
import { getFlagService } from '../../server/flags/app-service.ts';
import {
  createFraudService,
  type FraudService,
} from '../../server/fraud/service.ts';
import {
  createReferralCaptureService,
  type ReferralCapture,
} from '../../server/referral/capture.ts';
import { createReferralService } from '../../server/referral/service.ts';
import { consumeRateLimit } from '../../server/ratelimit/consume.ts';
import {
  createSignupService,
  type SignupInput,
  type SignupOutcome,
} from '../../server/subscriber/signup.ts';
import {
  verifyTurnstileToken,
  type TurnstileOutcome,
} from '../../server/turnstile/verify.ts';

const ipRateLimitWindowMs = 15 * 60 * 1_000;
const ipRateLimitMaxAttempts = 5;
// The Turnstile provider-timeout path cannot confirm the challenge, so it falls
// through to a stricter per-prefix limit than a confirmed request (ADR-006,
// fallbacks.md "Turnstile unavailable"). Its own bucket, so it does not share a
// counter with confirmed signups from the same prefix.
const strictIpRateLimitMaxAttempts = 2;
const maxEmailLength = 254;
export const signupResponseTargetMs = 500;

/**
 * The closed error-code set this route can return, each with its HTTP status.
 * Every entry is a code from `docs/api/README.md#closed-code-set`; a test
 * reconciles this catalogue against that table, so an unmapped code — one added
 * here but not documented, or a status that disagrees — fails CI.
 */
export const signupErrorCatalogue = {
  blocked_domain: 400,
  invalid_input: 400,
  invalid_email: 400,
  challenge_failed: 400,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
} as const;

export type SignupErrorCode = keyof typeof signupErrorCatalogue;

const errorMessages: Record<SignupErrorCode, string> = {
  blocked_domain: signupCopy.blockedDomain,
  invalid_input: signupCopy.invalidInput,
  invalid_email: signupCopy.invalidEmail,
  challenge_failed: signupCopy.challengeFailed,
  rate_limited: signupCopy.rateLimited,
  unavailable: signupCopy.unavailable,
  internal: signupCopy.internal,
};

export interface SignupRouteDependencies {
  readonly onRejected?: (reason: SignupErrorCode) => void;
  readonly isSignupEnabled: () => Promise<boolean>;
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
  readonly consumeIpRateLimit: (
    prefixHash: string,
    now: Date,
    strict: boolean,
  ) => Promise<'ok' | 'rate_limited'>;
  readonly signup: (input: SignupInput) => Promise<SignupOutcome>;
  readonly verifyReferralCapture?: (
    signed: string | null,
  ) => ReferralCapture | null;
  readonly flagChallengeTimeout: (subscriberId: string) => Promise<void>;
  readonly ipPrefixPepper: string;
  readonly clock?: () => Date;
  readonly monotonicClock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

let database: DatabasePool | undefined;
let fraudService: FraudService | undefined;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

function getFraudService(): FraudService {
  fraudService ??= createFraudService(getDatabase());
  return fraudService;
}

/**
 * The raw client address is confined to this route boundary. It is reduced to
 * an IPv4 /24 or IPv6 /64 before HMACing, and only the hash may leave here.
 */
export function hashIpPrefix(
  clientAddress: string | undefined,
  pepper: string,
): Buffer | null {
  const address = clientAddress?.split('%', 1)[0] ?? '';
  if (isIP(address) === 4) {
    const prefix = `${address.split('.').slice(0, 3).join('.')}.0/24`;
    return createHmac('sha256', pepper).update(prefix).digest();
  }
  if (isIP(address) !== 6) return null;

  const [left = '', right = ''] = address.toLowerCase().split('::');
  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === '' ? [] : right.split(':');
  const missingParts = 8 - leftParts.length - rightParts.length;
  const prefix = `${[
    ...leftParts,
    ...Array.from({ length: missingParts }, () => '0'),
    ...rightParts,
  ]
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join(':')}::/64`;
  return createHmac('sha256', pepper).update(prefix).digest();
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

function errorResponse(code: SignupErrorCode): Response {
  return jsonResponse(signupErrorCatalogue[code], {
    error: { code, message: errorMessages[code] },
  });
}

interface ValidBody {
  readonly email: string;
  readonly marketingOptInVersion: string | null;
}

function validateBody(formData: FormData): ValidBody | null {
  const rawEmail = formData.get('email');
  if (
    typeof rawEmail !== 'string' ||
    rawEmail === '' ||
    rawEmail.length > maxEmailLength
  ) {
    return null;
  }

  const marketingOptIn = formData.get('marketing_opt_in');
  if (
    marketingOptIn !== null &&
    (typeof marketingOptIn !== 'string' ||
      !Object.hasOwn(marketingOptInWordingByVersion, marketingOptIn))
  ) {
    return null;
  }

  // The raw email keeps its exact form for normalisation (which rejects
  // surrounding whitespace as a malformed address → invalid_email).
  return { email: rawEmail, marketingOptInVersion: marketingOptIn };
}

export function createSignupRoute(
  dependencies: SignupRouteDependencies,
): APIRoute {
  const clock = dependencies.clock ?? (() => new Date());
  const monotonicClock =
    dependencies.monotonicClock ??
    (() => Number(process.hrtime.bigint() / 1_000_000n));
  const sleep = dependencies.sleep ?? systemSleep;
  const rejected = (reason: SignupErrorCode): Response => {
    try {
      dependencies.onRejected?.(reason);
    } catch {
      /* Analytics is best-effort. */
    }
    return errorResponse(reason);
  };
  const dependencyRejection = (error: unknown): Response =>
    rejected(
      error instanceof DatabaseUnavailableError ? 'unavailable' : 'internal',
    );

  return async ({ clientAddress, request }) => {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return rejected('invalid_input');
    }

    // 1. Turnstile, server-side, before any other work. A missing token is a
    // failed challenge; a rejected verdict fails closed. A provider timeout
    // does not reject a real person — it accepts under strict limits and flags
    // the row further down (ADR-006).
    const turnstileToken = formData.get('turnstile_token');
    if (typeof turnstileToken !== 'string' || turnstileToken === '') {
      return rejected('challenge_failed');
    }
    const challenge = await dependencies.verifyTurnstile(turnstileToken);
    if (challenge === 'rejected') {
      return rejected('challenge_failed');
    }
    const challengeTimedOut = challenge === 'unavailable';

    // The flag lookup is deliberately after Turnstile: it can touch the flag
    // store, so doing it first would violate the challenge boundary on this
    // public write route. A disabled route returns honest paused copy before
    // rate limiting or signup work.
    if (!(await dependencies.isSignupEnabled())) {
      return jsonResponse(200, {
        status: 'paused',
        message: signupCopy.paused,
      });
    }

    // 2. Rate-limit per hashed IP prefix — the strict window when the challenge
    // could not be confirmed.
    const prefixHash = hashIpPrefix(clientAddress, dependencies.ipPrefixPepper);
    if (prefixHash === null) return rejected('rate_limited');
    const now = clock();
    try {
      if (
        (await dependencies.consumeIpRateLimit(
          prefixHash.toString('hex'),
          now,
          challengeTimedOut,
        )) !== 'ok'
      ) {
        return rejected('rate_limited');
      }
    } catch (error) {
      return dependencyRejection(error);
    }

    // 3. Validate the body shape.
    const body = validateBody(formData);
    if (body === null) {
      return rejected('invalid_input');
    }
    // Bad attribution is deliberately equivalent to no attribution; it never
    // costs the underlying signup.
    const rawReferralCapture = formData.get('referral_capture');
    const referralCapture =
      dependencies.verifyReferralCapture?.(
        typeof rawReferralCapture === 'string' ? rawReferralCapture : null,
      ) ?? null;

    // Every syntactically valid request that can reveal subscriber membership
    // shares the same minimum response boundary. Unknown, pending, and verified
    // addresses therefore do not expose their different database/mail paths as
    // a useful timing signal.
    const membershipWorkStartedAt = monotonicClock();

    // 4. Normalise + blocklist/MX screen + upsert + referral attribution +
    // fraud signals + queue the verification mail (in the module).
    let outcome: SignupOutcome;
    try {
      outcome = await dependencies.signup({
        email: body.email,
        marketingOptInVersion: body.marketingOptInVersion,
        referralCode: referralCapture?.ref ?? null,
        signupIpPrefixHash: prefixHash,
        utm: referralCapture?.utm ?? null,
        verificationUrl: (token) => {
          const verificationUrl = new URL('/verify', request.url);
          verificationUrl.searchParams.set('token', token);
          return verificationUrl.toString();
        },
      });
    } catch (error) {
      return dependencyRejection(error);
    }

    if (outcome.kind === 'invalid_email') {
      return rejected('invalid_email');
    }
    if (outcome.kind === 'blocked_domain') {
      return rejected('blocked_domain');
    }

    // 5. Flag the row for review when the challenge timed out — the subscriber
    // now exists (created, or an existing pending row). Best-effort: the row is
    // already committed and safe, so a failed flag write never turns a real
    // signup into an error (fallbacks.md — "a signup that reached PostgreSQL is
    // safe").
    if (challengeTimedOut && outcome.kind !== 'already_verified') {
      try {
        await dependencies.flagChallengeTimeout(outcome.subscriber.id);
      } catch {
        // The review flag is metadata; losing it degrades the queue, it never
        // touches the committed subscriber row.
      }
    }

    const remaining =
      signupResponseTargetMs - (monotonicClock() - membershipWorkStartedAt);
    if (remaining > 0) {
      await sleep(remaining);
    }

    // Created, existing pending, and already verified all receive the same
    // accepted response. Whether an address is on the list is disclosed only
    // by email to that address, never through this public route.
    return jsonResponse(200, {
      status: 'pending',
      message: signupCopy.pending,
    });
  };
}

function defaultDependencies(): SignupRouteDependencies {
  const config = getConfig();
  const analytics = createAnalyticsService();
  return {
    onRejected: (reason) => {
      void analytics
        .track('signup_rejected', { reason_code: reason })
        .catch(() => {});
    },
    isSignupEnabled: () => getFlagService().isEnabled('signup.enabled'),
    // Server-side verification lives in the turnstile module, the only consumer
    // of the secret. The raw client address is not forwarded to the provider —
    // it stays in the truncate-then-hash rate-limit path (standing rule 9).
    verifyTurnstile: (token) => verifyTurnstileToken(token),
    async consumeIpRateLimit(prefixHash, now, strict) {
      const key = strict
        ? `signup:ip:strict:${prefixHash}`
        : `signup:ip:${prefixHash}`;
      const limit = strict
        ? strictIpRateLimitMaxAttempts
        : ipRateLimitMaxAttempts;
      const count = await consumeRateLimit(
        getDatabase(),
        key,
        ipRateLimitWindowMs,
        now,
      );
      return count > limit ? 'rate_limited' : 'ok';
    },
    ipPrefixPepper: config.ipPrefixPepper,
    verifyReferralCapture: (signed) =>
      createReferralCaptureService(config.referralSigningSecret).verifyRef(
        signed,
      ),
    async flagChallengeTimeout(subscriberId) {
      await createFraudFlagRepository(getDatabase()).insertChallengeTimeoutFlag(
        {
          id: randomUUID(),
          subscriberId,
        },
      );
    },
    signup: (input) =>
      createSignupService(getDatabase(), {
        attributeReferral: (referredId, code, allowAttribution) =>
          createReferralService(getDatabase()).attribute(
            referredId,
            code,
            allowAttribution,
          ),
        isReferralEnabled: () => getFlagService().isEnabled('referral.enabled'),
        flagDuplicateIdentity: (subscriberId) =>
          getFraudService().flagDuplicateIdentity(subscriberId),
        flagIpVelocity: (subscriberId, prefixHash) =>
          getFraudService().flagIpVelocity(
            subscriberId,
            prefixHash,
            config.ipVelocity,
          ),
        raiseFraudFlag: (subscriberId, kind, detail) =>
          getFraudService().raise(subscriberId, kind, detail),
        screenEmailDomain: (domain) => getFraudService().screen({ domain }),
        sendVerificationMail: async () => undefined,
        onCreated: ({ utm, hasValidRef, marketingOptIn }) => {
          void analytics
            .track('signup_submitted', {
              source_bucket: sourceBucket(utm, hasValidRef),
              had_ref: hasValidRef,
              marketing_opt_in: marketingOptIn,
            })
            .catch(() => {});
        },
      })(input),
  };
}

export const POST: APIRoute = (context) =>
  createSignupRoute(defaultDependencies())(context);
