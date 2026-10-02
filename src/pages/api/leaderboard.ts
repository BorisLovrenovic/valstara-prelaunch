import type { APIRoute } from 'astro';

import { leaderboardCopy } from '../../copy/leaderboard.ts';
import { getConfig } from '../../server/config.ts';
import { createPool, type DatabasePool } from '../../server/db/pool.ts';
import { createFlagService } from '../../server/flags/service.ts';
import type { FlagService } from '../../server/flags/types.ts';
import { getLeaderboardSnapshot } from '../../server/leaderboard/runtime.ts';
import type { LeaderboardSnapshotCache } from '../../server/leaderboard/snapshot.ts';

interface LeaderboardRouteDependencies {
  readonly flags: Pick<FlagService, 'isEnabled'>;
  readonly snapshot: Pick<LeaderboardSnapshotCache, 'read'>;
}

let database: DatabasePool | undefined;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function createLeaderboardRoute(
  dependencies: LeaderboardRouteDependencies,
): APIRoute {
  return async () => {
    if (!(await dependencies.flags.isEnabled('leaderboard.public'))) {
      return jsonResponse(503, {
        error: { code: 'unavailable', message: leaderboardCopy.paused },
      });
    }

    const snapshot = dependencies.snapshot.read();
    if (snapshot === null) {
      return jsonResponse(503, {
        error: { code: 'unavailable', message: leaderboardCopy.unavailable },
      });
    }

    return jsonResponse(200, {
      snapshot_id: 'id' in snapshot ? snapshot.id : undefined,
      as_of: snapshot.asOf,
      entries: snapshot.entries.map((entry) => ({
        confirmed_referrals: entry.confirmedReferrals,
        display_handle: entry.displayHandle,
        rank: entry.rank,
      })),
    });
  };
}

export function createDefaultLeaderboardRoute(
  database: DatabasePool,
  snapshot: Pick<LeaderboardSnapshotCache, 'read'> = getLeaderboardSnapshot(),
): APIRoute {
  return createLeaderboardRoute({
    flags: createFlagService(database),
    snapshot,
  });
}

export const GET: APIRoute = (context) =>
  createDefaultLeaderboardRoute(getDatabase())(context);
