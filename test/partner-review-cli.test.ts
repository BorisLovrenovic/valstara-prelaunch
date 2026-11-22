// E11.7-06: the partner commands through the founder command line, run as its
// own process against a test server that serves the real admin middleware
// and the real partner routes over a real database. The Tests line:
// authentication refusal — every command refuses without the authenticator
// code, at the command line and at the API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { APIContext, APIRoute } from 'astro';

import { createApprovePartnerRoute } from '../src/pages/api/admin/partners/[id]/approve.ts';
import { createContractSentPartnerRoute } from '../src/pages/api/admin/partners/[id]/contract-sent.ts';
import { createContractSignedPartnerRoute } from '../src/pages/api/admin/partners/[id]/contract-signed.ts';
import { createNotePartnerRoute } from '../src/pages/api/admin/partners/[id]/note.ts';
import { createPausePartnerRoute } from '../src/pages/api/admin/partners/[id]/pause.ts';
import { createReactivatePartnerRoute } from '../src/pages/api/admin/partners/[id]/reactivate.ts';
import { createRejectPartnerRoute } from '../src/pages/api/admin/partners/[id]/reject.ts';
import { createTerminatePartnerRoute } from '../src/pages/api/admin/partners/[id]/terminate.ts';
import { createSetTypePartnerRoute } from '../src/pages/api/admin/partners/[id]/type.ts';
import { createShowPartnerRoute } from '../src/pages/api/admin/partners/[id].ts';
import { createPartnerExportRoute } from '../src/pages/api/admin/partners/export.csv.ts';
import { createListPartnersRoute } from '../src/pages/api/admin/partners/index.ts';
import { createAdminAuthenticator } from '../src/server/admin-auth/authenticate.ts';
import { createAdminAuthMiddleware } from '../src/server/admin-auth/middleware.ts';
import { adminRouteRegistry } from '../src/server/admin-auth/route-registry.ts';
import { generateTotp } from '../src/server/admin-auth/totp.ts';
import { adminCommands, runAdminCommand } from '../src/server/admin/cli.ts';
import { createAuditService } from '../src/server/audit/service.ts';
import { createPartnerExportService } from '../src/server/partner/export.ts';
import { createPartnerReviewService } from '../src/server/partner/review.ts';

import {
  createPartnerFixture,
  insertPartner,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const cliPath = fileURLToPath(
  new URL('../src/server/admin/cli.ts', import.meta.url),
);
const credential = 'test-admin-credential-with-32-characters';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const instant = new Date('2026-11-22T12:00:00.000Z');
const code = generateTotp(totpSecret, instant);

interface Harness {
  readonly fixture: PartnerFixture;
  readonly origin: string;
  readonly home: string;
  readonly requests: string[];
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const fixture = await createPartnerFixture('e11-7-06-cli-test');
  const service = createPartnerReviewService(fixture.app, () => instant);
  const exporter = createPartnerExportService(
    fixture.app,
    createAuditService(fixture.app),
  );
  const commandRoutes: Record<string, APIRoute> = {
    approve: createApprovePartnerRoute(service),
    reject: createRejectPartnerRoute(service),
    'contract-sent': createContractSentPartnerRoute(service),
    'contract-signed': createContractSignedPartnerRoute(service),
    pause: createPausePartnerRoute(service),
    terminate: createTerminatePartnerRoute(service),
    reactivate: createReactivatePartnerRoute(service),
    type: createSetTypePartnerRoute(service),
    note: createNotePartnerRoute(service),
  };
  const list = createListPartnersRoute(service);
  const show = createShowPartnerRoute(service);
  const exportRoute = createPartnerExportRoute(exporter);
  const middleware = createAdminAuthMiddleware(
    createAdminAuthenticator({ credential, totpSecret }, () => instant),
  );

  function resolve(
    method: string,
    pathname: string,
  ): { route: APIRoute; params: Record<string, string> } | null {
    if (method === 'GET' && pathname === '/api/admin/partners')
      return { route: list, params: {} };
    if (method === 'GET' && pathname === '/api/admin/partners/export.csv')
      return { route: exportRoute, params: {} };
    const match = /^\/api\/admin\/partners\/([^/]+)(?:\/([^/]+))?$/u.exec(
      pathname,
    );
    if (match === null) return null;
    const [, id = '', command] = match;
    if (method === 'GET' && command === undefined)
      return { route: show, params: { id: decodeURIComponent(id) } };
    const route = command === undefined ? undefined : commandRoutes[command];
    if (method === 'POST' && route !== undefined)
      return { route, params: { id: decodeURIComponent(id) } };
    return null;
  }

  const requests: string[] = [];
  const server: Server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    requests.push(`${incoming.method} ${url.pathname}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const request = new Request(url, {
      method: incoming.method,
      headers,
      body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
    });
    const locals = {};
    const response = await middleware({ locals, request, url }, async () => {
      const resolved = resolve(request.method, url.pathname);
      if (resolved === null) return new Response(null, { status: 404 });
      return resolved.route({
        locals,
        params: resolved.params,
        request,
        url,
      } as unknown as APIContext);
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  const home = await mkdtemp(join(tmpdir(), 'valstara-partner-cli-'));
  return {
    fixture,
    origin: `http://127.0.0.1:${port}`,
    home,
    requests,
    async close() {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(home, { recursive: true, force: true });
      await fixture.dispose();
    },
  };
}

function runCli(
  h: Harness,
  args: readonly string[],
  stdin: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: h.home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: h.home,
        ADMIN_API_ORIGIN: h.origin,
        ADMIN_CREDENTIAL: credential,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function partnerAudits(h: Harness): Promise<number> {
  const row = await h.fixture.owner.readOne<{ n: number }>({
    text: `SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'partner.%'`,
  });
  return row?.n ?? 0;
}

const partnerRoutes = adminRouteRegistry.filter((route) =>
  route.pathname.startsWith('/api/admin/partners'),
);

test('authentication refusal: every partner command refuses without the authenticator code, and sends nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const partner = await insertPartner(h.fixture, { status: 'applied' });
  const invocations: Record<string, readonly string[]> = {
    'partners list': ['--stale'],
    'partners show': [partner.id],
    'partners approve': [partner.id, '--code', 'MAYA'],
    'partners reject': [partner.id, '--template'],
    'partners contract-sent': [partner.id],
    'partners contract-signed': [
      partner.id,
      '--date',
      '2026-11-22',
      '--version',
      'v1',
    ],
    'partners pause': [partner.id],
    'partners terminate': [partner.id],
    'partners reactivate': [partner.id],
    'partners set-type': [partner.id, 'standard'],
    'partners note': [partner.id, '--text', 'A note'],
    'partners export': [],
  };
  // Every partner command the command line has is covered here.
  assert.deepEqual(
    Object.keys(adminCommands)
      .filter((name) => name.startsWith('partners '))
      .sort(),
    Object.keys(invocations).sort(),
  );
  for (const [name, args] of Object.entries(invocations)) {
    for (const typed of ['', '12345', 'abcdef']) {
      const run = await runCli(h, [...name.split(' '), ...args], `${typed}\n`);
      assert.equal(run.status, 1, `${name} with "${typed}"`);
      assert.match(
        run.stderr,
        /A six-digit authenticator code is required\. Nothing was sent\./u,
        name,
      );
      assert.equal(run.stdout, '', name);
    }
  }
  assert.deepEqual(h.requests, []);

  // At the API, a missing or wrong code is the same 401 on every partner
  // route, and nothing is read, written or audited.
  assert.equal(partnerRoutes.length, 12);
  for (const route of partnerRoutes) {
    const path = route.pathname.replace(':id', partner.id);
    for (const method of route.methods) {
      for (const totp of [null, '000000']) {
        const response = await fetch(new URL(path, h.origin), {
          method: method.method,
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
            ...(totp === null ? {} : { 'X-Valstara-TOTP': totp }),
          },
          ...(method.method === 'POST' ? { body: '{}' } : {}),
        });
        assert.equal(response.status, 401, `${method.method} ${path}`);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal((await response.json()).error.code, 'unauthorized');
      }
    }
  }
  assert.equal(await partnerAudits(h), 0);
  const row = await h.fixture.owner.readOne<{ status: string }>({
    text: 'SELECT status FROM partner WHERE id = $1',
    values: [partner.id],
  });
  assert.equal(row?.status, 'applied');
});

test('the command line takes a partner from review to termination, and streams the export, audited as the operator', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const partner = await insertPartner(h.fixture, {
    status: 'applied',
    requestedCode: 'MAYA',
    fullName: 'Maya Example',
    email: 'maya.cli@example.test',
  });
  const run = async (...args: string[]) => {
    const result = await runCli(h, args, `${code}\n`);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stderr.includes(code), false);
    assert.equal(result.stderr.includes(credential), false);
    return result.stdout.trim().split('\n');
  };

  const listed = await run('partners', 'list', '--status', 'applied');
  assert.equal(listed.length, 2);
  assert.match(
    listed[0] ?? '',
    new RegExp(
      `^${partner.id}  applied  creator  MAYA  Maya Example  maya\\.cli@example\\.test  applied `,
      'u',
    ),
  );
  assert.equal(listed[1], '1 partners.');

  assert.deepEqual(
    await run('partners', 'approve', partner.id, '--code', 'maya2026'),
    [
      `Partner ${partner.id}: applied -> approved.`,
      'Code: MAYA2026 (not live).',
      'Email queued: yes.',
    ],
  );
  assert.deepEqual(await run('partners', 'contract-sent', partner.id), [
    `Partner ${partner.id}: approved -> contract_sent.`,
    'Code: MAYA2026 (not live).',
  ]);
  const address = '192.0.2.1';
  const ipRefusal = await runCli(
    h,
    [
      'partners',
      'contract-signed',
      partner.id,
      '--date',
      '2026-11-22',
      '--version',
      address,
    ],
    `${code}\n`,
  );
  assert.equal(ipRefusal.status, 1);
  assert.match(ipRefusal.stderr, /invalid_input/u);
  assert.equal(ipRefusal.stdout, '');
  assert.ok(!ipRefusal.stderr.includes(address));
  assert.deepEqual(
    await run(
      'partners',
      'contract-signed',
      partner.id,
      '--date',
      '2026-11-22',
      '--version',
      'v1',
      '--reference',
      'signfree-42',
    ),
    [
      `Partner ${partner.id}: contract_sent -> active.`,
      'Code: MAYA2026 (not live).',
    ],
  );
  await run('partners', 'pause', partner.id);
  await run('partners', 'reactivate', partner.id);
  assert.deepEqual(
    await run(
      'partners',
      'set-type',
      partner.id,
      'student_ambassador',
      '--university',
      'Lund University',
    ),
    [`Partner ${partner.id} is now student_ambassador.`],
  );
  assert.deepEqual(
    await run('partners', 'note', partner.id, '--text', 'Met at the fair.'),
    [`Notes replaced for partner ${partner.id}.`],
  );
  const shown = await run('partners', 'show', partner.id);
  assert.ok(shown.includes('status: active'));
  assert.ok(shown.includes('contract_reference: signfree-42'));
  assert.ok(shown.includes('notes: Met at the fair.'));
  assert.ok(
    shown.includes('referrals: 0 confirmed, 0 pending, 0 voided, 0 flagged'),
  );

  // A refused command reports the copy-layer message and changes nothing.
  const refused = await runCli(
    h,
    ['partners', 'reactivate', partner.id],
    `${code}\n`,
  );
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /invalid_input: That command does not apply to a partner whose status is active\./u,
  );

  const exported = await runCli(h, ['partners', 'export'], `${code}\n`);
  assert.equal(exported.status, 0, exported.stderr);
  const lines = exported.stdout.split('\r\n');
  assert.equal(
    lines[0],
    'EMAIL,EXT_ID,PARTNER_ID,FULL_NAME,STATUS,PARTNER_TYPE,CODE,CONTRACT_SIGNED_AT,CONTRACT_VERSION,CONFIRMED_REFERRALS,PENDING_REFERRALS,MARKETING_CONSENT',
  );
  assert.equal(
    lines[1],
    `maya.cli@example.test,maya.cli@example.test,${partner.id},Maya Example,active,student_ambassador,MAYA2026,2026-11-22,v1,0,0,false`,
  );
  assert.equal(lines[2], '');

  await run('partners', 'terminate', partner.id);
  const actions = await h.fixture.owner.list<{ action: string; actor: string }>(
    {
      text: `SELECT action, actor FROM audit_log WHERE action LIKE 'partner.%' ORDER BY at, id`,
    },
    50,
  );
  assert.deepEqual(
    actions.map((row) => row.action),
    [
      'partner.listed',
      'partner.approved',
      'partner.contract_sent',
      'partner.contract_signed',
      'partner.paused',
      'partner.reactivated',
      'partner.type_changed',
      'partner.note_replaced',
      'partner.viewed',
      'partner.exported',
      'partner.terminated',
    ],
  );
  assert.ok(actions.every((row) => row.actor === 'admin.operator'));
  // Nothing was written to disk by the command line.
  assert.deepEqual(await readdir(h.home), []);
});

test('the export command waits for stdout before reading another chunk', async () => {
  const firstWrite = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const output: string[] = [];
  const chunks = ['EMAIL\r\n', 'partner@example.test\r\n'];
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[reads++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
    },
    { highWaterMark: 0 },
  );
  const running = runAdminCommand(
    ['partners', 'export'],
    { ADMIN_CREDENTIAL: credential },
    {
      prompt: async () => code,
      write: assert.fail,
      async writeChunk(text) {
        output.push(text);
        if (output.length === 1) {
          firstWrite.resolve();
          await resume.promise;
        }
      },
    },
    async () => new Response(body),
  );
  try {
    await firstWrite.promise;
    await yieldTurn();
    assert.equal(reads, 1);
  } finally {
    resume.resolve();
    await running;
  }
  assert.equal(output.join(''), chunks.join(''));
});

test('the command line refuses an unknown, repeated or valueless option before asking for anything', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const id = randomUUID();
  for (const args of [
    ['partners', 'list', '--colour', 'red'],
    ['partners', 'list', '--status', 'applied', '--status', 'active'],
    ['partners', 'approve', id, '--code'],
    ['partners', 'contract-signed', id, '--date', '2026-11-22'],
    ['partners', 'note', id],
    ['partners', 'set-type', id],
    ['partners', 'show'],
    ['partners', 'export', 'extra'],
  ]) {
    const result = await runCli(h, args, `${code}\n`);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(
      result.stderr,
      /Usage: npm run admin -- <command>/u,
      args.join(' '),
    );
    assert.equal(
      result.stderr.includes('Authenticator code'),
      false,
      args.join(' '),
    );
  }
  assert.deepEqual(h.requests, []);
});
