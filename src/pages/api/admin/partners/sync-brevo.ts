import type { APIRoute } from 'astro';

import { adminCopy } from '../../../../copy/admin.ts';
import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import type { PartnerSyncResult } from '../../../../server/partner/brevo-sync.ts';
import { getPartnerBrevoSync } from '../../../../server/partner/review-runtime.ts';

const headers = { 'Cache-Control': 'no-store' };

export function createPartnerBrevoSyncRoute(
  run: (actor: string) => Promise<PartnerSyncResult>,
): APIRoute {
  return async ({ locals }) => {
    const actor = requireAdminActor(locals);
    try {
      const sync = await run(actor);
      if (sync.state !== 'unavailable')
        return Response.json({ sync }, { headers });
      return Response.json(
        {
          error: {
            code: 'unavailable',
            message: adminCopy.partnerBrevoUnavailable,
          },
          sync,
        },
        { status: 503, headers },
      );
    } catch {
      return Response.json(
        {
          error: {
            code: 'unavailable',
            message: adminCopy.partnerBrevoUnavailable,
          },
        },
        { status: 503, headers },
      );
    }
  };
}

export const POST: APIRoute = createPartnerBrevoSyncRoute((actor) =>
  getPartnerBrevoSync().runOnDemand(actor),
);
