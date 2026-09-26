import type { APIRoute } from 'astro';

import { adminCopy } from '../../../copy/admin.ts';
import { requireAdminActor } from '../../../server/admin-auth/middleware.ts';
import { getConfig, getP1AlertConfiguration } from '../../../server/config.ts';
import { DatabaseUnavailableError } from '../../../server/db/errors.ts';
import { createPool, type DatabasePool } from '../../../server/db/pool.ts';
import { getFlagService } from '../../../server/flags/app-service.ts';
import { BeaconUnavailableError } from '../../../server/giveaway/beacon.ts';
import {
  createDrawService,
  DrawRefusedError,
  DrawUnavailableError,
  type DrawService,
} from '../../../server/giveaway/draw.ts';
import { createAlertWebhookTransport } from '../../../server/verification-rate/p1-webhook.ts';

let database: DatabasePool | undefined;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function createDrawRoute(
  service: Pick<DrawService, 'executeDraw'>,
): APIRoute {
  return async ({ locals }) => {
    const actor = requireAdminActor(locals);
    try {
      const draw = await service.executeDraw(actor);
      return response(202, {
        draw: {
          id: draw.id,
          state: 'pending',
          target_round: draw.targetRound,
          target_round_at: draw.targetRoundAt.toISOString(),
        },
      });
    } catch (error) {
      const code =
        error instanceof DrawUnavailableError ||
        error instanceof BeaconUnavailableError ||
        error instanceof DatabaseUnavailableError
          ? 'unavailable'
          : error instanceof DrawRefusedError
            ? 'invalid_input'
            : 'internal';
      const status =
        code === 'invalid_input' ? 400 : code === 'unavailable' ? 503 : 500;
      return response(status, {
        error: {
          code,
          message:
            code === 'invalid_input'
              ? adminCopy.invalidRequest
              : adminCopy.temporarilyUnavailable,
        },
      });
    }
  };
}

export const POST: APIRoute = (context) =>
  createDrawRoute(
    createDrawService(
      getDatabase(),
      getFlagService(),
      createAlertWebhookTransport(getP1AlertConfiguration()),
      { config: getConfig().drand },
    ),
  )(context);
