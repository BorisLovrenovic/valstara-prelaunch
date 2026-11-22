import type { APIRoute } from 'astro';

import { requireAdminActor } from '../../../../../server/admin-auth/middleware.ts';
import { createPartnerCommandHandler } from '../../../../../server/partner/review-http.ts';
import { getPartnerReviewService } from '../../../../../server/partner/review-runtime.ts';
import type { PartnerReviewService } from '../../../../../server/partner/review.ts';

// E11.7-06: reactivate <id>: paused to active. Audited with the authenticated actor and the before and
// after values (docs/api/README.md#admin-routes).
export function createReactivatePartnerRoute(
  service: PartnerReviewService,
): APIRoute {
  const handle = createPartnerCommandHandler(service, 'reactivate');
  return ({ locals, params, request }) =>
    handle({ actor: requireAdminActor(locals), id: params.id, request });
}

export const POST: APIRoute = (context) =>
  createReactivatePartnerRoute(getPartnerReviewService())(context);
