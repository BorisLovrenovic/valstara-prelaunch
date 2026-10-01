import { defineMiddleware } from 'astro:middleware';

import { securityCopy } from './copy/security.ts';
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

export const onRequest = defineMiddleware(async (context, next) => {
  const method = context.request.method;
  const staticPath = context.url.pathname.replace(/\/$/u, '');
  if (
    !context.isPrerendered &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    method !== 'OPTIONS' &&
    !(context.url.pathname === '/api/unsubscribe' && method === 'POST') &&
    !(context.url.pathname.startsWith('/api/webhooks/') && method === 'POST')
  ) {
    const contentType = context.request.headers.get('content-type');
    const formLike =
      contentType !== null &&
      [
        'application/x-www-form-urlencoded',
        'multipart/form-data',
        'text/plain',
      ].some((type) => contentType.toLowerCase().includes(type));
    if (
      (formLike || contentType === null) &&
      context.request.headers.get('origin') !== context.url.origin
    ) {
      return new Response(securityCopy.crossSiteForm, {
        status: 403,
      });
    }
  }
  if (
    context.isPrerendered &&
    (staticPath === '/legit' ||
      staticPath === '/guarantee' ||
      staticPath === '/about' ||
      staticPath === '/giveaway/rules' ||
      staticPath.startsWith('/giveaway/rules/'))
  ) {
    return next();
  }
  return configuredMiddleware()(context, next);
});
