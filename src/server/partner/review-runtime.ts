import { createAuditService } from '../audit/service.ts';
import { getConfig, getP1AlertConfiguration } from '../config.ts';
import { createPool, type DatabasePool } from '../db/pool.ts';
import { getFlagService } from '../flags/app-service.ts';
import { createAlertWebhookTransport } from '../verification-rate/p1-webhook.ts';

import { createPartnerBrevoSync, partnerBrevoTarget } from './brevo-sync.ts';
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

export function getPartnerExportService(): PartnerExportService {
  const pool = getDatabase();
  return createPartnerExportService(pool, createAuditService(pool));
}

export function getPartnerBrevoSync() {
  return createPartnerBrevoSync(
    getDatabase(),
    getFlagService(),
    partnerBrevoTarget(getConfig().brevo),
    createAlertWebhookTransport(getP1AlertConfiguration()),
    () => new Date(),
  );
}
