import { getConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createAnalyticsService } from '../analytics/service.ts';

import { createFlagService } from './service.ts';
import type { FlagService } from './types.ts';

// A process-lifetime flag service so the in-process cache (a short TTL, see
// `service.ts`) actually spares the database on the landing page, which is the
// campaign's hottest route. The pool is created lazily on first use and lives
// for the life of the server process, exactly as the signup route's pool does.
let service: FlagService | undefined;

export function getFlagService(): FlagService {
  if (service === undefined) {
    const analytics = createAnalyticsService();
    service = createFlagService(createPool(getConfig().databaseUrl), {
      onGiveawayEntry: (method) => {
        void analytics.track('giveaway_entered', { method }).catch(() => {});
      },
    });
  }
  return service;
}
