import type { APIRoute } from 'astro';

import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import type { PartnerAnnouncementService } from '../../../../server/partner/announcement.ts';
import { createPartnerAnnouncementHandler } from '../../../../server/partner/announcement-http.ts';
import { getPartnerAnnouncementService } from '../../../../server/partner/review-runtime.ts';

// E11.7-16: `partners announce --id <id> [--dry-run]`. POST { id, dry_run? }
// queues the announcement to every eligible partner, or with dry_run counts
// them and queues nothing. Audited as `partner.announcement_run` with the
// authenticated actor (docs/api/README.md#admin-routes).
export function createPartnerAnnouncementRoute(
  service: PartnerAnnouncementService,
): APIRoute {
  const handle = createPartnerAnnouncementHandler(service);
  return ({ locals, request }) =>
    handle({ actor: requireAdminActor(locals), request });
}

export const POST: APIRoute = (context) =>
  createPartnerAnnouncementRoute(getPartnerAnnouncementService())(context);
