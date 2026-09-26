export type AdminHttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export type AdminRouteMethod =
  | { readonly method: 'GET'; readonly audit: 'read-only' }
  | {
      readonly method: Exclude<AdminHttpMethod, 'GET'>;
      readonly audit: 'required';
    };

export interface AdminRouteRegistration {
  readonly source: string;
  readonly pathname: string;
  readonly methods: readonly AdminRouteMethod[];
}

export function defineAdminRouteRegistry(
  routes: readonly AdminRouteRegistration[],
): readonly AdminRouteRegistration[] {
  const sources = new Set<string>();
  const methodPaths = new Set<string>();

  for (const route of routes) {
    if (!route.pathname.startsWith('/api/admin/')) {
      throw new Error(
        `Admin route is outside the protected prefix: ${route.pathname}`,
      );
    }
    if (sources.has(route.source)) {
      throw new Error(`Duplicate admin route source: ${route.source}`);
    }
    sources.add(route.source);

    for (const registration of route.methods) {
      const key = `${registration.method} ${route.pathname}`;
      if (methodPaths.has(key)) {
        throw new Error(`Duplicate admin route registration: ${key}`);
      }
      methodPaths.add(key);
    }
  }

  return Object.freeze([...routes]);
}

// Tickets that add an admin endpoint add its source, request path and methods
// here in the same change. The generated test reconciles this registry with
// src/pages/api/admin, then exercises every entry through the prefix middleware.
export const adminRouteRegistry = defineAdminRouteRegistry([
  {
    source: 'src/pages/api/admin/draw.ts',
    pathname: '/api/admin/draw',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/fraud.ts',
    pathname: '/api/admin/fraud',
    methods: [{ method: 'GET', audit: 'read-only' }],
  },
  {
    source: 'src/pages/api/admin/fraud/[id].ts',
    pathname: '/api/admin/fraud/:id',
    methods: [{ method: 'POST', audit: 'required' }],
  },
]);
