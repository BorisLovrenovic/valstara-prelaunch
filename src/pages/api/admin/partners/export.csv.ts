import type { APIRoute } from 'astro';

import { adminCopy } from '../../../../copy/admin.ts';
import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import { DatabaseUnavailableError } from '../../../../server/db/errors.ts';
import type { PartnerExportService } from '../../../../server/partner/export.ts';
import { getPartnerExportService } from '../../../../server/partner/review-runtime.ts';

// E11.7-06: `partners export`, the founder review CSV,
// streamed in pages of at most 500 rows and audited as `partner.exported`
// with its row count before the first byte.
export function createPartnerExportRoute(
  service: PartnerExportService,
): APIRoute {
  return async ({ locals }) => {
    const actor = requireAdminActor(locals);
    try {
      const body = await service.open(actor);
      return new Response(body, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment; filename="valstara-partners.csv"',
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
            message: adminCopy.partnerExportUnavailable,
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

export const GET: APIRoute = (context) =>
  createPartnerExportRoute(getPartnerExportService())(context);
