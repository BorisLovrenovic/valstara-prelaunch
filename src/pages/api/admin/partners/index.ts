import type { APIRoute } from 'astro';

import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import { createPartnerListHandler } from '../../../../server/partner/review-http.ts';
import { getPartnerReviewService } from '../../../../server/partner/review-runtime.ts';
import type { PartnerReviewService } from '../../../../server/partner/review.ts';

// E11.7-06: `partners list [--status --type --since] [--stale]`, at most 100
// partners a page. The read is audited as `partner.listed` with the filters
// and the row count, and no personal data.
export function createListPartnersRoute(
  service: PartnerReviewService,
): APIRoute {
  const handle = createPartnerListHandler(service);
  return ({ locals, url }) => handle({ actor: requireAdminActor(locals), url });
}

export const GET: APIRoute = (context) =>
  createListPartnersRoute(getPartnerReviewService())(context);
