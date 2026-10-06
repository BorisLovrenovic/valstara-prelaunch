import type { APIRoute } from 'astro';

import { adminCopy } from '../../../copy/admin.ts';
import { requireAdminActor } from '../../../server/admin-auth/middleware.ts';
import {
  createAdminExportService,
  type AdminExportService,
} from '../../../server/subscriber/export.ts';
import { createAuditService } from '../../../server/audit/service.ts';
import { getConfig } from '../../../server/config.ts';
import { DatabaseUnavailableError } from '../../../server/db/errors.ts';
import { createPool, type DatabasePool } from '../../../server/db/pool.ts';

let database: DatabasePool | undefined;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

export function createAdminExportRoute(service: AdminExportService): APIRoute {
  return async ({ locals }) => {
    const actor = requireAdminActor(locals);
    try {
      const body = await service.open(actor);
      return new Response(body, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment; filename="valstara-waitlist.csv"',
          'Content-Type': 'text/csv; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      const unavailable = error instanceof DatabaseUnavailableError;
      return Response.json(
        {
          error: {
            code: unavailable ? 'unavailable' : 'internal',
            message: adminCopy.exportUnavailable,
          },
        },
        {
          status: unavailable ? 503 : 500,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }
  };
}

export const GET: APIRoute = (context) => {
  const pool = getDatabase();
  return createAdminExportRoute(
    createAdminExportService(pool, createAuditService(pool)),
  )(context);
};
