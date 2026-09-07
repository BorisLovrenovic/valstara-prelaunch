import type { APIRoute } from 'astro';

import { signupCopy } from '../../copy/signup.ts';
import { getConfig } from '../../server/config.ts';
import { DatabaseUnavailableError } from '../../server/db/errors.ts';
import { createPool, type DatabasePool } from '../../server/db/pool.ts';
import { getFlagService } from '../../server/flags/app-service.ts';
import { consumeRateLimit } from '../../server/ratelimit/consume.ts';
import { hashedIpPrefix } from '../../server/ratelimit/ip-prefix.ts';
import {
  createSignupService,
  type SignupInput,
  type SignupOutcome,
} from '../../server/subscriber/signup.ts';
import { createResendTestMailSender } from '../../server/subscriber/verification-mail.ts';

const ipRateLimitWindowMs = 15 * 60 * 1_000;
const ipRateLimitMaxAttempts = 5;
const maxEmailLength = 254;
const maxRegionLength = 64;

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
  readonly verifyTurnstile: (token: string) => Promise<boolean>;
  readonly consumeIpRateLimit: (
    ipAddress: string,
    now: Date,
  ) => Promise<'ok' | 'rate_limited'>;
  readonly signup: (input: SignupInput) => Promise<SignupOutcome>;
  readonly clock?: () => Date;
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

  // The raw email keeps its exact form for normalisation (which rejects
  // surrounding whitespace as a malformed address → invalid_email).
  return { country, email: rawEmail, region };
}

export function createSignupRoute(
  dependencies: SignupRouteDependencies,
): APIRoute {
  const clock = dependencies.clock ?? (() => new Date());

  return async ({ clientAddress, request }) => {
    // The kill switch closes the route entirely: an honest paused response,
    // and no Turnstile call or database work while signups are off. When the
    // flag store is unreachable the service returns the registered default
    // (on), so a database blip never silently pauses signups.
    if (!(await dependencies.isSignupEnabled())) {
      return jsonResponse(200, {
        status: 'paused',
        message: signupCopy.paused,
      });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse('invalid_input');
    }

    // 1. Turnstile, server-side, before any other work.
    const turnstileToken = formData.get('turnstile_token');
    if (typeof turnstileToken !== 'string' || turnstileToken === '') {
      return errorResponse('challenge_failed');
    }
    if (!(await dependencies.verifyTurnstile(turnstileToken))) {
      return errorResponse('challenge_failed');
    }

    // 2. Rate-limit per hashed IP prefix.
    const now = clock();
    try {
      if (
        (await dependencies.consumeIpRateLimit(clientAddress, now)) !== 'ok'
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

    // 4. Normalise + upsert + queue the verification mail (in the module).
    let outcome: SignupOutcome;
    try {
      outcome = await dependencies.signup({
        country: body.country,
        email: body.email,
        region: body.region,
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
    if (outcome.kind === 'already_verified') {
      return jsonResponse(200, {
        status: 'already_verified',
        message: signupCopy.alreadyVerified,
      });
    }

    // created or existing pending → the same honest "check your inbox", with
    // no position, count or rank (a pending row has no honest position).
    return jsonResponse(200, {
      status: 'pending',
      message: signupCopy.pending,
    });
  };
}

async function verifyInlineTurnstile(token: string): Promise<boolean> {
  const secret = getConfig().turnstileSecretKey;

  try {
    const verification = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ response: token, secret }),
      },
    );
    if (!verification.ok) {
      return false;
    }

    const result: unknown = await verification.json();
    return (
      typeof result === 'object' &&
      result !== null &&
      'success' in result &&
      result.success === true
    );
  } catch {
    return false;
  }
}

function defaultDependencies(): SignupRouteDependencies {
  const config = getConfig();
  return {
    isSignupEnabled: () => getFlagService().isEnabled('signup.enabled'),
    verifyTurnstile: verifyInlineTurnstile,
    async consumeIpRateLimit(ipAddress, now) {
      const prefixHash = hashedIpPrefix(ipAddress, config.ipPrefixPepper);
      if (prefixHash === null) {
        return 'rate_limited';
      }
      const count = await consumeRateLimit(
        getDatabase(),
        `signup:ip:${prefixHash}`,
        ipRateLimitWindowMs,
        now,
      );
      return count > ipRateLimitMaxAttempts ? 'rate_limited' : 'ok';
    },
    signup: (input) =>
      createSignupService(getDatabase(), {
        sendVerificationMail: createResendTestMailSender(
          config.resendApiKey,
          config.resendTestRecipient,
        ),
      })(input),
  };
}

export const POST: APIRoute = (context) =>
  createSignupRoute(defaultDependencies())(context);
