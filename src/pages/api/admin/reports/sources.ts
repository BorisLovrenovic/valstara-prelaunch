import type { APIRoute } from 'astro';

import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import { createSourceReportHandler } from '../../../../server/source-report/http.ts';
import type { SourceReportService } from '../../../../server/source-report/report.ts';
import { getSourceReportService } from '../../../../server/source-report/runtime.ts';

// E11.8-02: `npm run report:sources`. GET ?from=YYYY-MM-DD&to=YYYY-MM-DD
// returns the per-platform signup report for those UTC days, labels and
// counts only, and is audited as `report.sources_counted` with the
// authenticated actor, the range and the row count
// (docs/api/README.md#admin-routes).
export function createSourceReportRoute(
  service: SourceReportService,
): APIRoute {
  const handle = createSourceReportHandler(service);
  return ({ locals, url }) => handle({ actor: requireAdminActor(locals), url });
}

export const GET: APIRoute = (context) =>
  createSourceReportRoute(getSourceReportService())(context);
