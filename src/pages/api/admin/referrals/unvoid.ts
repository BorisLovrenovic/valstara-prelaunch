import type { APIRoute } from 'astro';

import { requireAdminActor } from '../../../../server/admin-auth/middleware.ts';
import { getConfig } from '../../../../server/config.ts';
import { createPool, type DatabasePool } from '../../../../server/db/pool.ts';
import {
  createReferralVoidService,
  type ReferralVoidService,
} from '../../../../server/referral/void.ts';
import { createReferralVoidHandler } from '../../../../server/referral/void-http.ts';

let database: DatabasePool | undefined;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

// E11.7-02: POST { subscriber_id, reason } un-voids the referral of that referred
// subscriber, audited with the authenticated actor (docs/api/README.md).
export function createUnvoidReferralRoute(
  service: ReferralVoidService,
): APIRoute {
  const handle = createReferralVoidHandler(service, 'unvoid');
  return ({ locals, request }) =>
    handle({ actor: requireAdminActor(locals), request });
}

export const POST: APIRoute = (context) =>
  createUnvoidReferralRoute(createReferralVoidService(getDatabase()))(context);
