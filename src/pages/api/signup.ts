import type { APIRoute } from 'astro';

import { thinSliceCopy } from '../../copy/e1-11.ts';
import {
  createResendTestMailSender,
  createThinSignupService,
  type ThinSignupInput,
  type ThinSignupResult,
} from '../../server/e1-11/signup.ts';
import { createPool, type DatabasePool } from '../../server/db/pool.ts';

interface SignupRouteDependencies {
  readonly signup: (input: ThinSignupInput) => Promise<ThinSignupResult>;
  readonly verifyTurnstile: (token: string) => Promise<boolean>;
}

let database: DatabasePool | undefined;

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return response(status, { error: { code, message } });
}

function getDatabase(): DatabasePool {
  if (database !== undefined) {
    return database;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for the signup route.');
  }

  database = createPool(databaseUrl);
  return database;
}

async function verifyInlineTurnstile(token: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (secret === undefined || secret === '') {
    return false;
  }

  try {
    const requestBody = new URLSearchParams({ response: token, secret });
    const verification = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: requestBody,
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
  return {
    async signup(input) {
      const ipPrefixPepper = process.env.IP_PREFIX_PEPPER;
      if (ipPrefixPepper === undefined || ipPrefixPepper === '') {
        return { kind: 'unavailable' };
      }

      return createThinSignupService(getDatabase(), {
        ipPrefixPepper,
        sendVerificationTestMail: createResendTestMailSender(
          process.env.RESEND_API_KEY,
          process.env.RESEND_TEST_RECIPIENT,
        ),
      })(input);
    },
    verifyTurnstile: verifyInlineTurnstile,
  };
}

export function createThinSignupRoute(
  dependencies: SignupRouteDependencies,
): APIRoute {
  return async ({ clientAddress, request }) => {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse(400, 'invalid_input', thinSliceCopy.invalidInput);
    }

    const turnstileToken = formData.get('turnstile_token');
    if (typeof turnstileToken !== 'string' || turnstileToken === '') {
      return errorResponse(
        400,
        'challenge_failed',
        thinSliceCopy.challengeFailed,
      );
    }

    const turnstileVerified =
      await dependencies.verifyTurnstile(turnstileToken);
    if (!turnstileVerified) {
      return errorResponse(
        400,
        'challenge_failed',
        thinSliceCopy.challengeFailed,
      );
    }

    const email = formData.get('email');
    let result: ThinSignupResult;
    try {
      result = await dependencies.signup({
        email: typeof email === 'string' ? email : '',
        ipAddress: clientAddress,
        verificationUrl: (token) => {
          const verificationUrl = new URL('/verify', request.url);
          verificationUrl.searchParams.set('token', token);
          return verificationUrl.toString();
        },
      });
    } catch {
      return errorResponse(503, 'unavailable', thinSliceCopy.unavailable);
    }

    if (result.kind === 'invalid_email') {
      return errorResponse(400, 'invalid_input', thinSliceCopy.invalidInput);
    }
    if (result.kind === 'rate_limited') {
      return errorResponse(429, 'rate_limited', thinSliceCopy.rateLimited);
    }
    if (result.kind === 'unavailable') {
      return errorResponse(503, 'unavailable', thinSliceCopy.unavailable);
    }

    return response(200, {
      status: 'pending',
      message: thinSliceCopy.signupComplete,
    });
  };
}

export const POST: APIRoute = (context) =>
  createThinSignupRoute(defaultDependencies())(context);
