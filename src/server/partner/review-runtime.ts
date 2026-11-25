import { createAuditService } from '../audit/service.ts';
import { getConfig } from '../config.ts';
import { createPool, type DatabasePool } from '../db/pool.ts';

import {
  createPartnerAnnouncementService,
  type PartnerAnnouncementService,
} from './announcement.ts';
import {
  createPartnerExportService,
  type PartnerExportService,
} from './export.ts';
import {
  createPartnerReviewService,
  type PartnerReviewService,
} from './review.ts';

// E11.7-06: the admin partner routes' shared wiring, so each route file stays
// a thin call into the partner module.

let database: DatabasePool | undefined;
function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

export function getPartnerReviewService(): PartnerReviewService {
  return createPartnerReviewService(getDatabase());
}

// E11.7-16: partners announce. The real clock is read here, at the route's
// edge; the service and its tests inject one.
export function getPartnerAnnouncementService(): PartnerAnnouncementService {
  return createPartnerAnnouncementService(getDatabase(), {
    clock: () => new Date(),
  });
}

export function getPartnerExportService(): PartnerExportService {
  const pool = getDatabase();
  return createPartnerExportService(pool, createAuditService(pool));
}
