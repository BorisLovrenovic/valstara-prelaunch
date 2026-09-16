import type { APIRoute } from 'astro';

import { adminCopy } from '../../../copy/admin.ts';
import { requireAdminActor } from '../../../server/admin-auth/middleware.ts';
import { getConfig } from '../../../server/config.ts';
import { DatabaseUnavailableError } from '../../../server/db/errors.ts';
import { createPool, type DatabasePool } from '../../../server/db/pool.ts';
import {
  createFraudReviewService,
  fraudReviewBatchMaximum,
  type FraudReviewService,
} from '../../../server/fraud/review.ts';

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

function requestedLimit(url: URL): number | null {
  const value = url.searchParams.get('limit');
  if (value === null) return fraudReviewBatchMaximum;
  if (!/^\d+$/u.test(value)) return null;
  const limit = Number(value);
  return Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= fraudReviewBatchMaximum
    ? limit
    : null;
}

export function createFraudQueueRoute(service: FraudReviewService): APIRoute {
  return async ({ locals, url }) => {
    requireAdminActor(locals);
    const limit = requestedLimit(url);
    if (limit === null) return errorResponse('invalid_input');

    try {
      const flags = await service.openFlags(limit);
      return jsonResponse(200, { flags, limit });
    } catch (error) {
      return errorResponse(
        error instanceof DatabaseUnavailableError ? 'unavailable' : 'internal',
      );
    }
  };
}

export const GET: APIRoute = (context) =>
  createFraudQueueRoute(createFraudReviewService(getDatabase()))(context);
