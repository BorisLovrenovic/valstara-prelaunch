import type { APIRoute } from 'astro';

import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import { createTrustLedgerFiguresHandler } from '../../../../server/trust-ledger/figures-http.ts';
import { getTrustLedgerFiguresService } from '../../../../server/trust-ledger/runtime.ts';
import type { TrustLedgerFiguresService } from '../../../../server/trust-ledger/waitlist-figures.ts';

// E11.8-01: `trust-ledger draft --month YYYY-MM`. GET ?month=YYYY-MM returns
// that month's waitlist figures, counts only, and is audited as
// `trust_ledger.waitlist_counted` with the authenticated actor
// (docs/api/README.md#admin-routes).
export function createTrustLedgerFiguresRoute(
  service: TrustLedgerFiguresService,
): APIRoute {
  const handle = createTrustLedgerFiguresHandler(service);
  return ({ locals, url }) => handle({ actor: requireAdminActor(locals), url });
}

export const GET: APIRoute = (context) =>
  createTrustLedgerFiguresRoute(getTrustLedgerFiguresService())(context);
