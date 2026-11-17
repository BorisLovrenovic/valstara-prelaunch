import { defineMiddleware } from 'astro:middleware';

import { securityCopy } from './copy/security.ts';
import { createAdminAuthenticator } from './server/admin-auth/authenticate.ts';
import { createAdminAuthMiddleware } from './server/admin-auth/middleware.ts';
import { serveRender } from './server/cache/render-runtime.ts';
import { getConfig } from './server/config.ts';
import { ensureMaintenanceWatchdog } from './server/subscriber/heartbeat-runtime.ts';

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

// A form write is same-origin only when its Origin is exactly the request's
// scheme plus its own Host header. Since Astro 7.4, context.url keeps the Host
// only when it matches security.allowedDomains and otherwise reads
// localhost:<port>, so it cannot stand for the request's origin (D-010). A
// missing or unparseable Host or Origin is never same-origin.
function sameOrigin(
  origin: string | null,
  protocol: string,
  host: string | null,
): boolean {
  if (origin === null || host === null || host === '') return false;
  let expected: string;
  try {
    expected = new URL(`${protocol}//${host}`).origin;
  } catch {
    return false;
  }
  return origin === expected;
}

export const onRequest = defineMiddleware(async (context, next) => {
  if (!context.isPrerendered) ensureMaintenanceWatchdog();
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
      !sameOrigin(
        context.request.headers.get('origin'),
        context.url.protocol,
        context.request.headers.get('host'),
      )
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
      staticPath === '/terms' ||
      staticPath === '/privacy' ||
      staticPath === '/privacy/storage' ||
      staticPath === '/giveaway/rules' ||
      staticPath.startsWith('/giveaway/rules/') ||
      staticPath === '/404' ||
      staticPath === '/500')
  ) {
    return next();
  }
  return configuredMiddleware()(context, () =>
    serveRender(
      {
        method: context.request.method,
        url: context.url,
        locals: context.locals,
      },
      next,
    ),
  );
});
