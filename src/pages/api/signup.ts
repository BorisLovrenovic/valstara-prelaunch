import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { setTimeout as systemSleep } from 'node:timers/promises';

import { CANADA_COUNTRY_CODE } from '../../copy/country.ts';
import { signupCopy } from '../../copy/signup.ts';
import { getConfig } from '../../server/config.ts';
import { DatabaseUnavailableError } from '../../server/db/errors.ts';
import { createFraudFlagRepository } from '../../server/db/fraud-flag.ts';
import { createPool, type DatabasePool } from '../../server/db/pool.ts';
import { getFlagService } from '../../server/flags/app-service.ts';
import {
  createReferralCaptureService,
  type ReferralCapture,
} from '../../server/referral/capture.ts';
import { createReferralService } from '../../server/referral/service.ts';
import { consumeRateLimit } from '../../server/ratelimit/consume.ts';
import { hashedIpPrefix } from '../../server/ratelimit/ip-prefix.ts';
import {
  createSignupService,
  type SignupInput,
  type SignupOutcome,
} from '../../server/subscriber/signup.ts';
import { createResendTestMailSender } from '../../server/subscriber/verification-mail.ts';
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
const maxRegionLength = 64;
export const signupResponseTargetMs = 500;

/**
 * The closed error-code set this route can return, each with its HTTP status.
 * Every entry is a code from `docs/api/README.md#closed-code-set`; a test
 * reconciles this catalogue against that table, so an unmapped code — one added
 * here but not documented, or a status that disagrees — fails CI.
 */
export const signupErrorCatalogue = {
  invalid_input: 400,
  invalid_email: 400,
  challenge_failed: 400,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
} as const;

export type SignupErrorCode = keyof typeof signupErrorCatalogue;

const errorMessages: Record<SignupErrorCode, string> = {
  invalid_input: signupCopy.invalidInput,
  invalid_email: signupCopy.invalidEmail,
  challenge_failed: signupCopy.challengeFailed,
  rate_limited: signupCopy.rateLimited,
  unavailable: signupCopy.unavailable,
  internal: signupCopy.internal,
};

export interface SignupRouteDependencies {
  readonly isSignupEnabled: () => Promise<boolean>;
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
  readonly consumeIpRateLimit: (
    ipAddress: string,
    now: Date,
    strict: boolean,
  ) => Promise<'ok' | 'rate_limited'>;
  readonly signup: (input: SignupInput) => Promise<SignupOutcome>;
  readonly verifyReferralCapture?: (
    signed: string | null,
  ) => ReferralCapture | null;
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

function errorResponse(code: SignupErrorCode): Response {
  return jsonResponse(signupErrorCatalogue[code], {
    error: { code, message: errorMessages[code] },
  });
}

function dependencyError(error: unknown): Response {
  return errorResponse(
    error instanceof DatabaseUnavailableError ? 'unavailable' : 'internal',
  );
}

interface ValidBody {
  readonly email: string;
  readonly country: string;
  readonly region: string | undefined;
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

  const rawCountry = formData.get('country');
  if (typeof rawCountry !== 'string') {
    return null;
  }
  const country = rawCountry.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(country)) {
    return null;
  }

  const rawRegion = formData.get('region');
  let region: string | undefined;
  if (rawRegion !== null) {
    if (typeof rawRegion !== 'string') {
      return null;
    }
    const trimmed = rawRegion.trim();
    if (trimmed.length > maxRegionLength) {
      return null;
    }
    region = trimmed === '' ? undefined : trimmed;
  }

  // The region is collected — and required — only for Canada, because Quebec
  // changes giveaway eligibility (ADR-018, E3-04). A Canadian signup with no
  // region is incomplete: the eligibility decision (E7-01) has nothing to read.
  // This is where "required there" is enforced: a CSS-hidden control cannot
  // carry HTML `required` without breaking a no-JS submit, so the server is the
  // only honest place to require it, and E3-05's inline validation must never
  // accept what the server would reject.
  if (country === CANADA_COUNTRY_CODE && region === undefined) {
    return null;
  }

  // The raw email keeps its exact form for normalisation (which rejects
  // surrounding whitespace as a malformed address → invalid_email).
  return { country, email: rawEmail, region };
}

export function createSignupRoute(
  dependencies: SignupRouteDependencies,
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
      return errorResponse('invalid_input');
    }

    // 1. Turnstile, server-side, before any other work. A missing token is a
    // failed challenge; a rejected verdict fails closed. A provider timeout
    // does not reject a real person — it accepts under strict limits and flags
    // the row further down (ADR-006).
    const turnstileToken = formData.get('turnstile_token');
    if (typeof turnstileToken !== 'string' || turnstileToken === '') {
      return errorResponse('challenge_failed');
    }
    const challenge = await dependencies.verifyTurnstile(turnstileToken);
    if (challenge === 'rejected') {
      return errorResponse('challenge_failed');
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
    const now = clock();
    try {
      if (
        (await dependencies.consumeIpRateLimit(
          clientAddress,
          now,
          challengeTimedOut,
        )) !== 'ok'
      ) {
        return errorResponse('rate_limited');
      }
    } catch (error) {
      return dependencyError(error);
    }

    // 3. Validate the body shape.
    const body = validateBody(formData);
    if (body === null) {
      return errorResponse('invalid_input');
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

    // 4. Normalise + upsert + queue the verification mail (in the module).
    let outcome: SignupOutcome;
    try {
      outcome = await dependencies.signup({
        country: body.country,
        email: body.email,
        referralCode: referralCapture?.ref ?? null,
        region: body.region,
        utm: referralCapture?.utm ?? null,
        verificationUrl: (token) => {
          const verificationUrl = new URL('/verify', request.url);
          verificationUrl.searchParams.set('token', token);
          return verificationUrl.toString();
        },
      });
    } catch (error) {
      return dependencyError(error);
    }

    if (outcome.kind === 'invalid_email') {
      return errorResponse('invalid_email');
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
  return {
    isSignupEnabled: () => getFlagService().isEnabled('signup.enabled'),
    // Server-side verification lives in the turnstile module, the only consumer
    // of the secret. The raw client address is not forwarded to the provider —
    // it stays in the truncate-then-hash rate-limit path (standing rule 9).
    verifyTurnstile: (token) => verifyTurnstileToken(token),
    async consumeIpRateLimit(ipAddress, now, strict) {
      const prefixHash = hashedIpPrefix(ipAddress, config.ipPrefixPepper);
      if (prefixHash === null) {
        return 'rate_limited';
      }
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
        isReferralEnabled: () =>
          getFlagService().isEnabled('referral.enabled'),
        sendVerificationMail: createResendTestMailSender(
          config.resendApiKey,
          config.resendTestRecipient,
        ),
      })(input),
  };
}

export const POST: APIRoute = (context) =>
  createSignupRoute(defaultDependencies())(context);
