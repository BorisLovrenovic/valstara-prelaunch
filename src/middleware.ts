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
function requestOrigin(protocol: string, host: string | null): string | null {
  if (host === null || host === '' || /[/\\?#@\s]/u.test(host)) return null;
  try {
    const url = new URL(`${protocol}//${host}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
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
    if (formLike || contentType === null) {
      const headers = context.request.headers;
      const origin = headers.get('origin');
      const expected = requestOrigin(context.url.protocol, headers.get('host'));
      const exact = expected !== null && origin === expected;
      // D-064: a native submission under no-referrer sends a literal null
      // Origin. The dashboard still authenticates its single-use token.
      if (
        !exact &&
        !(
          expected !== null &&
          origin === 'null' &&
          method === 'POST' &&
          context.url.pathname === '/partners/dashboard' &&
          headers.get('sec-fetch-site') === 'same-origin'
        )
      ) {
        return new Response(securityCopy.crossSiteForm, { status: 403 });
      }
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
      // E11.7-05: the partner programme page is static content too.
      staticPath === '/partners' ||
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
