import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adminActor,
  createAdminAuthenticator,
} from '../src/server/admin-auth/authenticate.ts';
import {
  createAdminAuthMiddleware,
  requireAdminActor,
} from '../src/server/admin-auth/middleware.ts';
import {
  adminRouteRegistry,
  defineAdminRouteRegistry,
} from '../src/server/admin-auth/route-registry.ts';
import { generateTotp } from '../src/server/admin-auth/totp.ts';

const credential = 'test-admin-credential-with-32-characters';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const instant = new Date('2026-09-16T12:00:00.000Z');

function authenticatedRequest(
  pathname = '/api/admin/__protected-probe',
  at = instant,
): Request {
  return new Request(`https://valstara.test${pathname}`, {
    headers: {
      Authorization: `Bearer ${credential}`,
      'X-Valstara-TOTP': generateTotp(totpSecret, at),
    },
  });
}

function context(request: Request) {
  return { locals: {}, request, url: new URL(request.url) };
}

test('E5-03a implements the RFC 6238 SHA-1 six-digit result', () => {
  // RFC 6238's SHA-1 vector at 59 seconds is 94287082 at eight digits;
  // truncating it to the configured six digits yields 287082.
  assert.equal(
    generateTotp(totpSecret, new Date('1970-01-01T00:00:59.000Z')),
    '287082',
  );
});

test('E5-03a requires both the operator credential and a current TOTP', () => {
  const authenticate = createAdminAuthenticator(
    { credential, totpSecret },
    () => instant,
  );

  assert.equal(authenticate(authenticatedRequest()), adminActor);
  assert.equal(
    authenticate(
      new Request('https://valstara.test/api/admin/__protected-probe', {
        headers: { Authorization: `Bearer ${credential}` },
      }),
    ),
    null,
  );
  assert.equal(
    authenticate(
      new Request('https://valstara.test/api/admin/__protected-probe', {
        headers: {
          Authorization: 'Bearer wrong-credential',
          'X-Valstara-TOTP': generateTotp(totpSecret, instant),
        },
      }),
    ),
    null,
  );
});

test('E5-03a accepts one TOTP skew step but rejects an expired code', () => {
  const authenticate = createAdminAuthenticator(
    { credential, totpSecret },
    () => instant,
  );

  assert.equal(
    authenticate(
      authenticatedRequest(undefined, new Date(instant.getTime() - 30_000)),
    ),
    adminActor,
  );
  assert.equal(
    authenticate(
      authenticatedRequest(undefined, new Date(instant.getTime() + 30_000)),
    ),
    adminActor,
  );
  assert.equal(
    authenticate(
      authenticatedRequest(undefined, new Date(instant.getTime() - 60_000)),
    ),
    null,
  );
});

test('E5-03a middleware fails closed and exposes no credential, TOTP, token, or raw IP', async () => {
  const authenticate = createAdminAuthenticator(
    { credential, totpSecret },
    () => instant,
  );
  const middleware = createAdminAuthMiddleware(authenticate);
  const rawIp = '203.0.113.47';
  const request = new Request(
    `https://valstara.test/api/admin/__protected-probe?source=${rawIp}`,
    {
      headers: {
        Authorization: `Bearer ${credential}`,
        'X-Valstara-TOTP': '000000',
      },
    },
  );
  const response = await middleware(context(request), async () => {
    assert.fail('unauthenticated admin request reached its route');
  });
  const body = await response.text();

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(body, new RegExp(credential, 'u'));
  assert.doesNotMatch(body, /000000|token|203\.0\.113\.47/iu);
  assert.deepEqual(JSON.parse(body), {
    error: { code: 'unauthorized', message: 'Authentication required.' },
  });
});

test('E5-03a middleware leaves public routes alone and gives protected routes an audit actor', async () => {
  const authenticate = createAdminAuthenticator(
    { credential, totpSecret },
    () => instant,
  );
  const middleware = createAdminAuthMiddleware(authenticate);

  const publicResponse = await middleware(
    context(new Request('https://valstara.test/api/signup')),
    async () => new Response('public'),
  );
  assert.equal(await publicResponse.text(), 'public');

  const protectedContext = context(authenticatedRequest());
  const protectedResponse = await middleware(protectedContext, async () =>
    Response.json({ actor: requireAdminActor(protectedContext.locals) }),
  );
  assert.equal(protectedResponse.status, 200);
  assert.deepEqual(await protectedResponse.json(), { actor: adminActor });
});

test('the generated admin-route assertion is non-vacuous and checks both auth paths', async () => {
  const fixtureRegistry = defineAdminRouteRegistry([
    {
      source: 'test/fixtures/admin-auth/protected-probe.ts',
      pathname: '/api/admin/__protected-probe',
      methods: [{ method: 'POST', audit: 'required' }],
    },
  ]);
  const middleware = createAdminAuthMiddleware(
    createAdminAuthenticator({ credential, totpSecret }, () => instant),
  );
  let authenticatedRouteCalls = 0;

  const routesUnderTest = [...adminRouteRegistry, ...fixtureRegistry];
  for (const route of routesUnderTest) {
    const unauthenticated = await middleware(
      context(new Request(`https://valstara.test${route.pathname}`)),
      async () => {
        assert.fail('fixture route was reachable without authentication');
      },
    );
    assert.equal(unauthenticated.status, 401);

    const protectedContext = context(authenticatedRequest(route.pathname));
    const authenticated = await middleware(protectedContext, async () => {
      authenticatedRouteCalls += 1;
      return Response.json({
        actor: requireAdminActor(protectedContext.locals),
      });
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), { actor: adminActor });
  }
  assert.equal(authenticatedRouteCalls, routesUnderTest.length);
});

test('the admin registry exactly covers every real admin route source', async () => {
  const adminDirectory = new URL('../src/pages/api/admin/', import.meta.url);
  const entries = await readdir(adminDirectory, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  });
  const actualSources = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => {
      const relativePath = relative(
        fileURLToPath(adminDirectory),
        `${entry.parentPath}/${entry.name}`,
      ).replaceAll('\\', '/');
      return `src/pages/api/admin/${relativePath}`;
    })
    .sort();
  const registeredSources = adminRouteRegistry
    .map((route) => route.source)
    .sort();

  assert.deepEqual(registeredSources, actualSources);
  for (const route of adminRouteRegistry) {
    assert.ok(route.methods.length > 0, `${route.pathname} registers a method`);
    for (const registration of route.methods) {
      if (registration.method !== 'GET') {
        assert.equal(registration.audit, 'required');
      }
    }
  }
});

test('admin routes are excluded from robots and unlinked from rendered public surfaces', async () => {
  const robots = await readFile(
    new URL('../public/robots.txt', import.meta.url),
    'utf8',
  );
  assert.match(robots, /^Disallow: \/api\/admin\/$/mu);

  const publicSurfacePaths = [
    '../src/components',
    '../src/copy',
    '../src/islands',
    '../src/layouts',
    '../src/pages/index.astro',
    '../src/pages/verify.astro',
  ];
  for (const relativePath of publicSurfacePaths) {
    const url = new URL(relativePath, import.meta.url);
    const entries = await readdir(url, {
      recursive: true,
      withFileTypes: true,
    }).catch(async (error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOTDIR'
      ) {
        return [];
      }
      throw error;
    });
    if (entries.length === 0) {
      const source = await readFile(url, 'utf8');
      assert.doesNotMatch(source, /\/api\/admin/u, relativePath);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const source = await readFile(
        `${entry.parentPath}/${entry.name}`,
        'utf8',
      );
      assert.doesNotMatch(
        source,
        /\/api\/admin/u,
        `${entry.parentPath}/${entry.name}`,
      );
    }
  }
});
