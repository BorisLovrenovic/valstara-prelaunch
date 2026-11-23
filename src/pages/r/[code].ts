import type { APIContext, APIRoute } from 'astro';

import { getDatabaseUrl } from '../../server/config.ts';
import {
  createPool,
  type DatabaseConnection,
  type DatabasePool,
} from '../../server/db/pool.ts';
import { partnerShortLink } from '../../server/partner/short-link.ts';

export const prerender = false;
let database: DatabasePool | undefined;

export function createPartnerShortLinkRoute(
  connection: DatabaseConnection,
): (context: Pick<APIContext, 'params'>) => Promise<Response> {
  return ({ params }) => partnerShortLink(connection, params.code ?? '');
}

export const GET: APIRoute = (context) => {
  database ??= createPool(getDatabaseUrl());
  return createPartnerShortLinkRoute(database)(context);
};
