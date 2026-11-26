import type { APIRoute } from 'astro';

import { createAnalyticsService } from '../../../server/analytics/service.ts';
import { getConfig } from '../../../server/config.ts';
import { createPool, type DatabasePool } from '../../../server/db/pool.ts';
import { getFlagService } from '../../../server/flags/app-service.ts';
import { createGiveawayMemberEntryService } from '../../../server/giveaway/member-entry.ts';
import {
  createGiveawayEntryRoute,
  type GiveawayEntryRouteDependencies,
} from '../../../server/giveaway/member-entry-http.ts';
import { currentRules } from '../../../server/giveaway/rules-catalog.ts';
import { verifyTurnstileToken } from '../../../server/turnstile/verify.ts';

let database: DatabasePool | undefined;
function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

function defaultDependencies(): GiveawayEntryRouteDependencies {
  const config = getConfig();
  const analytics = createAnalyticsService();
  return {
    verifyTurnstile: (token) => verifyTurnstileToken(token),
    enter: (input) =>
      createGiveawayMemberEntryService(getDatabase(), {
        flags: getFlagService(),
        currentRules,
        onEntry: (method) => {
          void analytics.track('giveaway_entered', { method }).catch(() => {});
        },
      }).enter(input),
    ipPrefixPepper: config.ipPrefixPepper,
  };
}

export const POST: APIRoute = (context) =>
  createGiveawayEntryRoute(defaultDependencies())(context);
