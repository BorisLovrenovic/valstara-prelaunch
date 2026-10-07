import type { APIRoute } from 'astro';

import { adminCopy } from '../../../copy/admin.ts';
import { requireAdminActor } from '../../../server/admin-auth/middleware.ts';
import { createAdminHealthService } from '../../../server/admin/health.ts';
import { getConfig } from '../../../server/config.ts';
import { DatabaseUnavailableError } from '../../../server/db/errors.ts';
import { createPool, type DatabasePool } from '../../../server/db/pool.ts';

let database: DatabasePool | undefined;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function createHealthRoute(
  service: Pick<ReturnType<typeof createAdminHealthService>, 'health'>,
): APIRoute {
  return async ({ locals }) => {
    requireAdminActor(locals);
    try {
      return jsonResponse(200, await service.health());
    } catch (error) {
      return jsonResponse(
        error instanceof DatabaseUnavailableError ? 503 : 500,
        {
          error: {
            code:
              error instanceof DatabaseUnavailableError
                ? 'unavailable'
                : 'internal',
            message: adminCopy.healthUnavailable,
          },
        },
      );
    }
  };
}

export const GET: APIRoute = (context) =>
  createHealthRoute(createAdminHealthService(getDatabase(), getConfig()))(
    context,
  );
