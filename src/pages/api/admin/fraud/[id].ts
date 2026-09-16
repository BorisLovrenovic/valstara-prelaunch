import type { APIRoute } from 'astro';

import { adminCopy } from '../../../../copy/admin.ts';
import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import { getConfig } from '../../../../server/config.ts';
import { DatabaseUnavailableError } from '../../../../server/db/errors.ts';
import { createPool, type DatabasePool } from '../../../../server/db/pool.ts';
import type { FraudReviewOutcome } from '../../../../server/db/fraud-review.ts';
import {
  createFraudReviewService,
  FraudFlagAlreadyReviewedError,
  FraudFlagNotFoundError,
  type FraudReviewService,
} from '../../../../server/fraud/review.ts';

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

function errorResponse(
  code: 'internal' | 'invalid_input' | 'unavailable',
): Response {
  const status =
    code === 'invalid_input' ? 400 : code === 'unavailable' ? 503 : 500;
  const message =
    code === 'invalid_input'
      ? adminCopy.invalidRequest
      : adminCopy.temporarilyUnavailable;
  return jsonResponse(status, { error: { code, message } });
}

function reviewOutcome(value: unknown): FraudReviewOutcome | null {
  return value === 'dismissed' || value === 'upheld' ? value : null;
}

export function createFraudReviewRoute(service: FraudReviewService): APIRoute {
  return async ({ locals, params, request }) => {
    const actor = requireAdminActor(locals);
    const flagId = params.id;
    if (flagId === undefined) return errorResponse('invalid_input');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse('invalid_input');
    }
    const outcome =
      typeof body === 'object' && body !== null && 'outcome' in body
        ? reviewOutcome(body.outcome)
        : null;
    if (outcome === null) return errorResponse('invalid_input');

    try {
      await service.review(flagId, outcome, actor);
      return jsonResponse(200, {
        flag: { id: flagId, outcome },
        status: 'reviewed',
      });
    } catch (error) {
      if (
        error instanceof RangeError ||
        error instanceof FraudFlagAlreadyReviewedError ||
        error instanceof FraudFlagNotFoundError
      ) {
        return errorResponse('invalid_input');
      }
      return errorResponse(
        error instanceof DatabaseUnavailableError ? 'unavailable' : 'internal',
      );
    }
  };
}

export const POST: APIRoute = (context) =>
  createFraudReviewRoute(createFraudReviewService(getDatabase()))(context);
