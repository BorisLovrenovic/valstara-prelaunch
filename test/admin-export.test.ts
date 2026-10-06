import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { APIRoute } from 'astro';

import { createAdminAuthMiddleware } from '../src/server/admin-auth/middleware.ts';
import { createAdminAuthenticator } from '../src/server/admin-auth/authenticate.ts';
import { adminRouteRegistry } from '../src/server/admin-auth/route-registry.ts';
import { generateTotp } from '../src/server/admin-auth/totp.ts';
import { csvHeader, csvRow } from '../src/server/subscriber/export-csv.ts';
import {
  createAdminExportService,
  createAdminExportServiceWithSnapshot,
} from '../src/server/subscriber/export.ts';
import { createAuditService } from '../src/server/audit/service.ts';
import {
  openAdminExportSnapshot,
  adminExportBatchSize,
} from '../src/server/db/admin-export.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createAdminExportRoute } from '../src/pages/api/admin/export.csv.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const credential = 'test-admin-credential-with-32-characters';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const instant = new Date('2026-10-06T12:00:00.000Z');

interface Fixture {
  readonly owner: DatabasePool;
  readonly app: DatabasePool;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const name = `valstara_e1004_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword,
    release: 'e10-04-test',
  });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    async dispose() {
      await app.close();
      await owner.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
          values: [name],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${name}"` });
      await admin.close();
    },
  };
}

async function subscriber(
  owner: DatabasePool,
  email: string,
  status: string,
  options?: {
    readonly consent?: boolean;
    readonly source?: string;
    readonly category?: readonly string[];
  },
): Promise<string> {
  const id = randomUUID();
  await owner.execute({
    text: `INSERT INTO subscriber (
      id, email, email_normalised, email_domain, status,
      referral_tier, referral_code, confirmed_referrals,
      category_preference, source, marketing_consent_at,
      marketing_consent_version, marketing_consent_source,
      access_window, subslush_customer
    ) VALUES (
      $1,$2,$2,'example.test',$3,2,$4,4,$5,$6,$7,$8,$9,'wave-2',true
    )`,
    values: [
      id,
      email,
      status,
      status === 'verified' ? `REF${id.slice(0, 8)}` : null,
      options?.category ?? ['skin', 'hair'],
      options?.source ?? 'referral',
      options?.consent ? instant : null,
      options?.consent ? 'v1' : null,
      options?.consent ? 'signup' : null,
    ],
  });
  return id;
}

function authRequest(): Request {
  return new Request('http://localhost:4321/api/admin/export.csv', {
    headers: {
      Authorization: `Bearer ${credential}`,
      'X-Valstara-TOTP': generateTotp(totpSecret, instant),
    },
  });
}

async function throughAuthentication(
  route: APIRoute,
  request: Request,
): Promise<Response> {
  const middleware = createAdminAuthMiddleware(
    createAdminAuthenticator({ credential, totpSecret }, () => instant),
  );
  const context = { request, url: new URL(request.url), locals: {} };
  return middleware(context, async () =>
    route(context as Parameters<APIRoute>[0]),
  );
}

test('CSV columns match the documented handoff payload and encode nullable, array and quoted fields', async () => {
  assert.deepEqual(
    adminRouteRegistry.find(
      (route) => route.pathname === '/api/admin/export.csv',
    )?.methods,
    [{ method: 'GET', audit: 'required' }],
  );
  assert.equal(
    csvHeader(),
    'email,email_normalised,referral_tier,referral_code,confirmed_referrals,category_preference,source,marketing_consent_at,marketing_consent_version,marketing_consent_source,access_window,subslush_customer\r\n',
  );
  const model = await readFile(
    new URL('../docs/data/model.md', import.meta.url),
    'utf8',
  );
  const payloadTable = model
    .split('**Per-row payload:**')[1]
    ?.split('**E10-04 admin CSV encoding.**')[0];
  assert.ok(payloadTable);
  const fields = payloadTable
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) =>
      Array.from(line.split('|')[1]?.matchAll(/`([^`]+)`/gu) ?? []).map(
        (match) => match[1],
      ),
    );
  assert.deepEqual(csvHeader().trimEnd().split(','), fields);
  assert.equal(
    csvRow({
      id: randomUUID(),
      email: 'case@example.test',
      email_normalised: 'case@example.test',
      referral_tier: 2,
      referral_code: 'REFCODE',
      confirmed_referrals: 4,
      category_preference: ['skin', 'hair'],
      source: 'source,"quoted"',
      marketing_consent_at: instant,
      marketing_consent_version: 'v1',
      marketing_consent_source: 'signup',
      access_window: 'wave-2',
      subslush_customer: false,
    }),
    'case@example.test,case@example.test,2,REFCODE,4,"[""skin"",""hair""]","source,""quoted""",2026-10-06T12:00:00.000Z,v1,signup,wave-2,false\r\n',
  );
});

test('an audit failure prevents the export and closes its snapshot', async () => {
  let closed = false;
  const service = createAdminExportServiceWithSnapshot(
    async () => ({
      rowCount: 1,
      async page() {
        assert.fail('audit failure must stop all row reads');
      },
      async close() {
        closed = true;
      },
    }),
    {
      async record() {
        throw new Error('audit unavailable');
      },
    },
  );
  await assert.rejects(service.open('admin.operator'), /audit unavailable/u);
  assert.equal(closed, true);
});

test('a page failure errors the stream even when snapshot cleanup also fails', async () => {
  const service = createAdminExportServiceWithSnapshot(
    async () => ({
      rowCount: 1,
      async page() {
        throw new Error('row read failed');
      },
      async close() {
        throw new Error('cleanup failed');
      },
    }),
    { async record() {} },
  );
  const reader = (await service.open('admin.operator')).getReader();
  assert.equal((await reader.read()).done, false);
  await assert.rejects(reader.read(), /row read failed/u);
});

test('the authenticated export reconciles the handoff set and records actor and row count', async () => {
  const f = await fixture();
  try {
    await subscriber(f.owner, 'included@example.test', 'verified', {
      consent: true,
    });
    await subscriber(f.owner, 'no-consent@example.test', 'verified');
    await subscriber(f.owner, 'pending@example.test', 'pending');
    await subscriber(f.owner, 'expired@example.test', 'expired');
    await subscriber(f.owner, 'unsubscribed@example.test', 'unsubscribed');
    await subscriber(f.owner, 'disqualified@example.test', 'disqualified');
    await subscriber(f.owner, 'suppressed@example.test', 'verified');
    await f.owner.execute({
      text: `INSERT INTO suppression(email_normalised,reason,source)
        VALUES ('suppressed@example.test','manual','test')`,
    });
    const service = createAdminExportService(f.app, createAuditService(f.app));
    const route = createAdminExportRoute(service);

    const denied = await throughAuthentication(
      route,
      new Request('http://localhost:4321/api/admin/export.csv'),
    );
    assert.equal(denied.status, 401);
    const response = await throughAuthentication(route, authRequest());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type') ?? '', /^text\/csv/u);
    const csv = await response.text();
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], csvHeader().trimEnd());
    assert.match(csv, /included@example\.test/u);
    assert.match(csv, /no-consent@example\.test/u);
    for (const excluded of [
      'pending',
      'expired',
      'unsubscribed',
      'disqualified',
      'suppressed',
    ]) {
      assert.doesNotMatch(csv, new RegExp(`${excluded}@example\\.test`, 'u'));
    }
    assert.doesNotMatch(csvHeader(), /(?:^|,)(?:ip|token|country)(?:,|\r)/iu);
    assert.match(csv, /2026-10-06T12:00:00\.000Z,v1,signup,wave-2,true/u);
    assert.match(csv, /,,wave-2,true/u);

    const audits = await f.owner.list<{
      actor: string;
      detail: { row_count: number };
      subject_type: string;
      subject_id: string | null;
    }>(
      {
        text: "SELECT actor,detail,subject_type,subject_id FROM audit_log WHERE action='export.run'",
      },
      5,
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actor, 'admin.operator');
    assert.equal(audits[0]?.detail.row_count, 2);
    assert.equal(audits[0]?.subject_type, 'export');
    assert.equal(audits[0]?.subject_id, null);
  } finally {
    await f.dispose();
  }
});

test('the export remains on one snapshot while rows change during streaming', async () => {
  const f = await fixture();
  try {
    await subscriber(f.owner, 'before@example.test', 'verified');
    const stream = await createAdminExportService(
      f.app,
      createAuditService(f.app),
    ).open('admin.operator');
    const reader = stream.getReader();
    await reader.read();
    await f.owner.execute({
      text: "UPDATE subscriber SET status='unsubscribed' WHERE email_normalised='before@example.test'",
    });
    await subscriber(f.owner, 'after@example.test', 'verified');
    let csv = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      csv += new TextDecoder().decode(chunk.value);
    }
    assert.match(csv, /before@example\.test/u);
    assert.doesNotMatch(csv, /after@example\.test/u);
  } finally {
    await f.dispose();
  }
});

test('a large export streams in capped pages with bounded observed heap growth', async (t) => {
  const f = await fixture();
  try {
    const rowCount = 20_000;
    await f.owner.execute({
      text: `INSERT INTO subscriber(id,email,email_normalised,email_domain,status,source)
        SELECT md5(n::text)::uuid,
          'bulk-' || n || '@example.test',
          'bulk-' || n || '@example.test',
          'example.test', 'verified', repeat('x',4096)
        FROM generate_series(1,$1::int) n`,
      values: [rowCount],
    });
    const snapshot = await openAdminExportSnapshot(f.app);
    assert.equal(snapshot.rowCount, rowCount);
    await assert.rejects(
      snapshot.page(null, adminExportBatchSize + 1),
      RangeError,
    );
    await snapshot.close();

    const response = await throughAuthentication(
      createAdminExportRoute(
        createAdminExportService(f.app, createAuditService(f.app)),
      ),
      authRequest(),
    );
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const initialHeap = process.memoryUsage().heapUsed;
    let peakHeap = initialHeap;
    let bytes = 0;
    let lines = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      for (const byte of chunk.value) if (byte === 10) lines += 1;
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    assert.equal(lines, rowCount + 1);
    assert.ok(bytes > 75 * 1024 * 1024);
    assert.ok(
      peakHeap - initialHeap < 64 * 1024 * 1024,
      `observed heap grew ${peakHeap - initialHeap} bytes while streaming ${bytes} bytes`,
    );
    t.diagnostic(
      `streamed ${bytes} bytes; observed peak heap growth ${peakHeap - initialHeap} bytes`,
    );
  } finally {
    await f.dispose();
  }
});
