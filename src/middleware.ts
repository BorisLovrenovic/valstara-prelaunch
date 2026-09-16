import { defineMiddleware } from 'astro:middleware';

import { createAdminAuthenticator } from './server/admin-auth/authenticate.ts';
import { createAdminAuthMiddleware } from './server/admin-auth/middleware.ts';
import { getConfig } from './server/config.ts';

let middleware: ReturnType<typeof createAdminAuthMiddleware> | undefined;

function configuredMiddleware(): ReturnType<typeof createAdminAuthMiddleware> {
  if (middleware === undefined) {
    const configuration = getConfig().adminAuth;
    middleware = createAdminAuthMiddleware(
      createAdminAuthenticator(configuration),
    );
  }
  return middleware;
}

export const onRequest = defineMiddleware(async (context, next) =>
  configuredMiddleware()(context, next),
);
