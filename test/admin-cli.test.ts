import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { APIContext } from 'astro';

import { createUnvoidReferralRoute } from '../src/pages/api/admin/referrals/unvoid.ts';
import { createVoidReferralRoute } from '../src/pages/api/admin/referrals/void.ts';
import { createAdminAuthenticator } from '../src/server/admin-auth/authenticate.ts';
import { createAdminAuthMiddleware } from '../src/server/admin-auth/middleware.ts';
import { generateTotp } from '../src/server/admin-auth/totp.ts';
import {
  adminApiOrigin,
  AdminCommandError,
  runAdminCommand,
} from '../src/server/admin/cli.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createReferralVoidService } from '../src/server/referral/void.ts';

// E11.7-02: the founder command line, run as its own process against a test
// server that serves the real admin middleware and routes over a real
// database. The command line itself holds no database access.

const cliPath = fileURLToPath(
  new URL('../src/server/admin/cli.ts', import.meta.url),
);
const credential = 'test-admin-credential-with-32-characters';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const instant = new Date('2026-10-20T12:00:00.000Z');
const code = generateTotp(totpSecret, instant);

interface Harness {
  readonly owner: DatabasePool;
  readonly origin: string;
  readonly home: string;
  readonly requests: string[];
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const name = `valstara_e1172cli_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(databaseUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appUrl.password,
    release: 'e11-7-02-cli-test',
  });
  const app = createPool(appUrl.toString());

  const service = createReferralVoidService(app, () => instant);
  const routes: Record<string, ReturnType<typeof createVoidReferralRoute>> = {
    '/api/admin/referrals/void': createVoidReferralRoute(service),
    '/api/admin/referrals/unvoid': createUnvoidReferralRoute(service),
  };
  const middleware = createAdminAuthMiddleware(
    createAdminAuthenticator({ credential, totpSecret }, () => instant),
  );
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
      const route = routes[url.pathname];
      if (route === undefined || request.method !== 'POST')
        return new Response(null, { status: 404 });
      return route({
        locals,
        params: {},
        request,
        url,
      } as unknown as APIContext);
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const home = await mkdtemp(join(tmpdir(), 'valstara-admin-cli-'));

  return {
    owner,
    origin: `http://127.0.0.1:${port}`,
    home,
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
      await app.close();
      await owner.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [name],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${name}"` });
      await admin.close();
    },
  };
}

async function referral(owner: DatabasePool) {
  const referrerId = randomUUID();
  const referredId = randomUUID();
  const edgeId = randomUUID();
  for (const id of [referrerId, referredId])
    await owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status, verified_at)
             VALUES ($1, $2, $2, 'cli.test', 'verified', $3)`,
      values: [id, `${id}@cli.test`, instant],
    });
  await owner.execute({
    text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state, confirmed_at)
           VALUES ($1, $2, $3, 'confirmed', 'settled', $4)`,
    values: [edgeId, referrerId, referredId, instant],
  });
  await owner.execute({
    text: 'UPDATE subscriber SET confirmed_referrals = 1 WHERE id = $1',
    values: [referrerId],
  });
  return { referrerId, referredId, edgeId };
}

/** Run the shipped command line as a child process, with a bare environment. */
function runCli(
  h: Harness,
  args: readonly string[],
  stdin: string,
  environment: Record<string, string> = { ADMIN_CREDENTIAL: credential },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: h.home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: h.home,
        XDG_CONFIG_HOME: h.home,
        ADMIN_API_ORIGIN: h.origin,
        ...environment,
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

test('the command line voids and un-voids a referral through the admin API, audited as the operator', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const { referrerId, referredId, edgeId } = await referral(h.owner);

  const voided = await runCli(
    h,
    [
      'referrals',
      'void',
      referredId,
      '--reason',
      'Bulk signups from one household',
    ],
    `${code}\n`,
  );
  assert.equal(voided.status, 0, voided.stderr);
  assert.deepEqual(voided.stdout.trim().split('\n'), [
    `Referral of ${referredId} is now voided.`,
    `Referrer ${referrerId} has 0 confirmed referrals.`,
    'Giveaway entry: none.',
  ]);
  // Prompts go to stderr; neither the key nor the code is ever echoed.
  assert.equal(voided.stderr.includes(code), false);
  assert.equal(voided.stderr.includes(credential), false);
  const edge = await h.owner.readOne<{
    void_reason: string;
    voided_by: string;
  }>({
    text: 'SELECT void_reason, voided_by FROM referral_edge WHERE id = $1',
    values: [edgeId],
  });
  assert.deepEqual(edge, {
    void_reason: 'Bulk signups from one household',
    voided_by: 'admin.operator',
  });

  // The key may also be typed at the prompt instead of set in the environment.
  const unvoided = await runCli(
    h,
    ['referrals', 'unvoid', referredId, '--reason', 'Cleared on appeal'],
    `${credential}\n${code}\n`,
    {},
  );
  assert.equal(unvoided.status, 0, unvoided.stderr);
  assert.match(
    unvoided.stdout,
    /is now not voided\.\nReferrer .* has 1 confirmed referrals\./u,
  );

  const audits = await h.owner.list<{ action: string; actor: string }>(
    {
      text: `SELECT action, actor FROM audit_log WHERE subject_id = $1 ORDER BY at`,
      values: [edgeId],
    },
    10,
  );
  assert.deepEqual(audits, [
    { action: 'referral.voided', actor: 'admin.operator' },
    { action: 'referral.unvoided', actor: 'admin.operator' },
  ]);
  assert.deepEqual(h.requests, [
    'POST /api/admin/referrals/void',
    'POST /api/admin/referrals/unvoid',
  ]);
  // Nothing was written to the working directory or the home directory.
  assert.deepEqual(await readdir(h.home), []);
});

test('the command line refuses to run without the authenticator code, and sends nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const { referredId, edgeId } = await referral(h.owner);
  const args = ['referrals', 'void', referredId, '--reason', 'Bulk signups'];

  for (const stdin of ['', '\n', '12345\n', 'abcdef\n', '1234567\n']) {
    const run = await runCli(h, args, stdin);
    assert.equal(run.status, 1, JSON.stringify(stdin));
    assert.match(
      run.stderr,
      /A six-digit authenticator code is required\. Nothing was sent\./u,
    );
  }
  // No key at all is refused too, before the code is even asked for.
  const noKey = await runCli(h, args, `\n${code}\n`, {});
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /The secret key is required\./u);
  assert.deepEqual(h.requests, []);

  // A wrong code reaches the boundary and is refused there, changing nothing.
  const wrong = await runCli(
    h,
    args,
    `${code === '000000' ? '111111' : '000000'}\n`,
  );
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /unauthorized: Authentication required\./u);
  assert.deepEqual(h.requests, ['POST /api/admin/referrals/void']);
  const edge = await h.owner.readOne<{ voided_at: Date | null }>({
    text: 'SELECT voided_at FROM referral_edge WHERE id = $1',
    values: [edgeId],
  });
  assert.equal(edge?.voided_at, null);

  // A refused void is reported with its message from the copy layer.
  const unknown = await runCli(
    h,
    ['referrals', 'void', randomUUID(), '--reason', 'Bulk signups'],
    `${code}\n`,
  );
  assert.equal(unknown.status, 1);
  assert.match(
    unknown.stderr,
    /invalid_input: No referral exists for that subscriber\./u,
  );
  assert.deepEqual(await readdir(h.home), []);
});

test('the command line refuses a missing reason, an unknown command and an insecure origin before asking for anything', async () => {
  const prompts: string[] = [];
  const io = {
    prompt: async (question: string) => {
      prompts.push(question);
      return code;
    },
    write: () => undefined,
    writeChunk: () => undefined,
  };
  const requests: string[] = [];
  const request = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({});
  }) as typeof fetch;
  const id = randomUUID();
  for (const [args, environment, message] of [
    [['referrals', 'void', id], {}, /A reason is required/u],
    [['referrals', 'void', id, '--reason'], {}, /A reason is required/u],
    [['referrals', 'void', id, '--reason', '  '], {}, /A reason is required/u],
    [
      ['referrals', 'void', '--reason', 'x'],
      {},
      /Name the referred subscriber/u,
    ],
    [
      ['referrals', 'void', id, id, '--reason', 'x'],
      {},
      /Name the referred subscriber/u,
    ],
    [['referrals', 'delete', id], {}, /Unknown command/u],
    [[], {}, /Unknown command/u],
    [
      ['referrals', 'void', id, '--reason', 'x'],
      { ADMIN_API_ORIGIN: 'http://valstara.com' },
      /bare HTTPS origin/u,
    ],
    [
      ['referrals', 'void', id, '--reason', 'x'],
      { ADMIN_API_ORIGIN: 'https://valstara.com/api' },
      /bare HTTPS origin/u,
    ],
    [
      ['referrals', 'void', id, '--reason', 'x'],
      { ADMIN_API_ORIGIN: 'https://user:pw@valstara.com' },
      /bare HTTPS origin/u,
    ],
    [
      ['referrals', 'void', id, '--reason', 'x'],
      { ADMIN_API_ORIGIN: 'not a url' },
      /not a valid URL/u,
    ],
  ] as const) {
    await assert.rejects(
      runAdminCommand(args, environment, io, request),
      (error: unknown) =>
        error instanceof AdminCommandError && message.test(error.message),
      JSON.stringify(args),
    );
  }
  assert.deepEqual(prompts, []);
  assert.deepEqual(requests, []);
  assert.equal(adminApiOrigin({}).origin, 'https://valstara.com');
  assert.equal(
    adminApiOrigin({ ADMIN_API_ORIGIN: 'http://localhost:4321' }).origin,
    'http://localhost:4321',
  );
});

test('the command line never connects to the database and holds no credential on disk', async () => {
  const source = await readFile(cliPath, 'utf8');
  const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gmu)].map(
    (match) => match[1],
  );
  // Only Node built-ins: no database layer, no driver, no file system.
  assert.deepEqual(imports, ['node:readline', 'node:url']);
  assert.equal(/\bprocess\.env\.\w+\s*=/u.test(source), false);
  assert.equal(/writeFile|appendFile|createWriteStream/u.test(source), false);
});
