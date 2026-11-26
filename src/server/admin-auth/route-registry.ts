export type AdminHttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export type AdminRouteMethod =
  | { readonly method: 'GET'; readonly audit: 'read-only' | 'required' }
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
    source: 'src/pages/api/admin/export.csv.ts',
    pathname: '/api/admin/export.csv',
    methods: [{ method: 'GET', audit: 'required' }],
  },
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
    source: 'src/pages/api/admin/health.ts',
    pathname: '/api/admin/health',
    methods: [{ method: 'GET', audit: 'read-only' }],
  },
  {
    source: 'src/pages/api/admin/fraud/[id].ts',
    pathname: '/api/admin/fraud/:id',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/referrals/void.ts',
    pathname: '/api/admin/referrals/void',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/referrals/unvoid.ts',
    pathname: '/api/admin/referrals/unvoid',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  // E11.7-06: the partner review, contract and lifecycle commands. The two
  // reads are audited too (D-052 Q4d), so every method is `required`.
  {
    source: 'src/pages/api/admin/partners/index.ts',
    pathname: '/api/admin/partners',
    methods: [{ method: 'GET', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/export.csv.ts',
    pathname: '/api/admin/partners/export.csv',
    methods: [{ method: 'GET', audit: 'required' }],
  },
  // E11.7-16: partners announce.
  {
    source: 'src/pages/api/admin/partners/announce.ts',
    pathname: '/api/admin/partners/announce',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id].ts',
    pathname: '/api/admin/partners/:id',
    methods: [{ method: 'GET', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/approve.ts',
    pathname: '/api/admin/partners/:id/approve',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/reject.ts',
    pathname: '/api/admin/partners/:id/reject',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/contract-sent.ts',
    pathname: '/api/admin/partners/:id/contract-sent',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/contract-signed.ts',
    pathname: '/api/admin/partners/:id/contract-signed',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/pause.ts',
    pathname: '/api/admin/partners/:id/pause',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/terminate.ts',
    pathname: '/api/admin/partners/:id/terminate',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/reactivate.ts',
    pathname: '/api/admin/partners/:id/reactivate',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/type.ts',
    pathname: '/api/admin/partners/:id/type',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  {
    source: 'src/pages/api/admin/partners/[id]/note.ts',
    pathname: '/api/admin/partners/:id/note',
    methods: [{ method: 'POST', audit: 'required' }],
  },
  // E11.8-01: the Trust Ledger's waitlist figures; the read is audited.
  {
    source: 'src/pages/api/admin/trust-ledger/waitlist.ts',
    pathname: '/api/admin/trust-ledger/waitlist',
    methods: [{ method: 'GET', audit: 'required' }],
  },
  // E11.8-02: the per-platform signup report; every run is audited.
  {
    source: 'src/pages/api/admin/reports/sources.ts',
    pathname: '/api/admin/reports/sources',
    methods: [{ method: 'GET', audit: 'required' }],
  },
]);
