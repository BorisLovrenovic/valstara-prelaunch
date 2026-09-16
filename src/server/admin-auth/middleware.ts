import { adminCopy } from '../../copy/admin.ts';
import type { AdminAuthenticator } from './authenticate.ts';

export interface AdminAuthLocals {
  adminActor?: string;
}

export interface AdminAuthContext {
  readonly locals: AdminAuthLocals;
  readonly request: Request;
  readonly url: URL;
}

export type AdminAuthMiddleware = (
  context: AdminAuthContext,
  next: () => Promise<Response>,
) => Promise<Response>;

export function isAdminPath(pathname: string): boolean {
  return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'unauthorized',
        message: adminCopy.authenticationRequired,
      },
    }),
    {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Bearer realm="Valstara admin"',
      },
    },
  );
}

export function createAdminAuthMiddleware(
  authenticate: AdminAuthenticator,
): AdminAuthMiddleware {
  return async (context, next) => {
    if (!isAdminPath(context.url.pathname)) return next();

    let actor: string | null;
    try {
      actor = authenticate(context.request);
    } catch {
      // Authentication must fail closed without disclosing configuration or
      // verifier detail in the response.
      return unauthorizedResponse();
    }
    if (actor === null) return unauthorizedResponse();

    context.locals.adminActor = actor;
    return next();
  };
}

export function requireAdminActor(locals: AdminAuthLocals): string {
  if (locals.adminActor === undefined) {
    throw new Error('Authenticated admin actor is required.');
  }
  return locals.adminActor;
}
