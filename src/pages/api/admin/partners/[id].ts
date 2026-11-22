import type { APIRoute } from 'astro';

import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import { createPartnerShowHandler } from '../../../../server/partner/review-http.ts';
import { getPartnerReviewService } from '../../../../server/partner/review-runtime.ts';
import type { PartnerReviewService } from '../../../../server/partner/review.ts';

// E11.7-06: `partners show <id>`, one partner with its referral counts,
// flagged referrals and last activity. The read is audited as
// `partner.viewed` with the partner's id only.
export function createShowPartnerRoute(
  service: PartnerReviewService,
): APIRoute {
  const handle = createPartnerShowHandler(service);
  return ({ locals, params }) =>
    handle({ actor: requireAdminActor(locals), id: params.id });
}

export const GET: APIRoute = (context) =>
  createShowPartnerRoute(getPartnerReviewService())(context);
