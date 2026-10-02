import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { createEmailWebhookRepository } from '../src/server/db/email-webhook.ts';
import { createDsrRepository } from '../src/server/db/dsr.ts';
import { createGiveawayEntryRepository } from '../src/server/db/giveaway-entry.ts';
import { createGiveawayDrawRepository } from '../src/server/db/giveaway-draw.ts';
import { createRankingRepository } from '../src/server/db/ranking.ts';
import {
  createErasureService,
  erasureBackoff,
  runErasureJob,
} from '../src/server/dsr/service.ts';
import { createDsrHandler } from '../src/server/dsr/http.ts';
import {
  completeErasureCommand,
  reapplyErasureCommand,
  commandOptions,
} from '../src/server/dsr/commands.ts';
import { createEmailQueue } from '../src/server/email/queue.ts';
import { createEmailService } from '../src/server/email/service.ts';
import { createBrevoContactSyncJob } from '../src/server/email/brevo-sync.ts';
import { createBrevoProvider } from '../src/server/email/providers/brevo.ts';
import { createVerificationService } from '../src/server/verification/service.ts';
import { createStatusLinkService } from '../src/server/verification/status-link.ts';
import { dsrRenderers } from '../src/server/dsr/templates.ts';
import { exportSubject } from '../src/server/dsr/export.ts';
import { subjectExportTables } from '../src/server/db/dsr-export.ts';
import type { Alert } from '../src/server/verification-rate/p1-webhook.ts';

async function fixture() {
  const url = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const admin = createPool(url.toString());
  const name = `dsr_${randomUUID().replaceAll('-', '')}`;
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  url.pathname = `/${name}`;
  const owner = createPool(url.toString());
  const password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  await runMigrations(owner, {
    applicationRolePassword: password,
    release: 'E9-05-test',
  });
  url.username = 'valstara_app';
  url.password = password;
  const app = createPool(url.toString());
  return {
    owner,
    app,
    appUrl: url.toString(),
    async close() {
      await app.close();
      await owner.close();
      await admin.execute({ text: `DROP DATABASE "${name}" WITH (FORCE)` });
      await admin.close();
    },
  };
}
async function person(db: DatabasePool, label: string = randomUUID()) {
  const id = randomUUID(),
    email = `${label}@example.test`;
  await db.execute({
    text: `INSERT INTO subscriber(id,email,email_normalised,email_domain,status,verified_at,marketing_consent_at,marketing_consent_source,marketing_consent_version) VALUES($1,$2,$2,'example.test','verified',$3,$3,'signup','v1')`,
    values: [id, email, new Date('2026-10-01')],
  });
  return { id, email };
}
function environment(db: DatabasePool) {
  const time = { now: new Date('2026-10-02T12:00:00Z') };
  const alerts: Alert[] = [];
  const calls: string[] = [];
  const dependencies = {
    clock: () => time.now,
    alerts: {
      send: async (a: Alert) => {
        alerts.push(a);
      },
    },
    deleteContact: async (email: string) => {
      calls.push(email);
    },
  };
  return {
    time,
    alerts,
    calls,
    dependencies,
    service: createErasureService(db, dependencies),
  };
}
async function request(
  db: DatabasePool,
  service: ReturnType<typeof createErasureService>,
  id: string,
) {
  await withTransaction(db, (c) => service.request(c, id));
}

test('pending erasure excludes queue, dispatch, sync, status links, ranking and the draw; no retry email copy', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  const tokens = createVerificationService(f.app, {
    clock: e.dependencies.clock,
  });
  const status = await tokens.issue(p.id, 'status');
  await createEmailQueue(f.app, e.dependencies.clock).queue({
    subscriberId: p.id,
    template: 'fixture',
    provider: 'resend',
    businessKey: 'before',
    payload: { token_id: status.id },
  });
  await f.owner.execute({
    text: `INSERT INTO giveaway_entry(id,subscriber_id,method,entries,rules_version,rules_sha256) VALUES($1,$2,'base',1,'VAL-GW-LAUNCH-20260925-r1',decode($3,'hex'))`,
    values: [randomUUID(), p.id, 'ab'.repeat(32)],
  });
  await f.owner.execute({
    text: 'INSERT INTO rate_limit_bucket(key,window_start,count) VALUES($1,$2,1)',
    values: [`legacy:address:${p.email}`, e.time.now],
  });
  await request(f.app, e.service, p.id);
  assert.equal(
    await f.owner.readOne({
      text: 'SELECT 1 FROM rate_limit_bucket WHERE position($1 in key)>0',
      values: [p.email],
    }),
    null,
  );
  await assert.rejects(
    f.app.execute({
      text: `INSERT INTO giveaway_entry(id,subscriber_id,method,entries,rules_version,rules_sha256)
      VALUES($1,$2,'base',1,'VAL-GW-LAUNCH-20260925-r1',decode($3,'hex'))`,
      values: [randomUUID(), p.id, 'ab'.repeat(32)],
    }),
    /cannot accrue entries/,
  );
  assert.equal(
    await createEmailQueue(f.app, e.dependencies.clock).queue({
      subscriberId: p.id,
      template: 'fixture',
      provider: 'resend',
      businessKey: 'after',
      payload: { token_id: status.id },
    }),
    false,
  );
  let sends = 0;
  const mail = createEmailService(f.app, {
    clock: e.dependencies.clock,
    baseUrl: 'http://localhost:4321',
    tokenSecret: process.env.EMAIL_TOKEN_SECRET!,
    providers: new Map([
      [
        'resend',
        {
          id: 'resend',
          sendingDomain: 'send.valstara.com',
          capabilities: {
            broadcast: false,
            contactSync: false,
            dailyFreeCap: 100,
          },
          send: async () => {
            sends++;
            return { providerMessageId: 'test' };
          },
        },
      ],
    ]),
    renderers: new Map([
      [
        'fixture',
        {
          kind: 'transactional',
          render: async (input) => ({
            from: 'hello@send.valstara.com',
            to: input.email,
            subject: 'fixture',
            text: 'fixture',
          }),
        },
      ],
    ]),
    isBroadcastEnabled: async () => true,
    operatorTask: async () => {
      throw new Error('unexpected task');
    },
  });
  assert.equal((await mail.dispatch(10)).suppressed, 1);
  assert.equal(sends, 0);
  const sync = createBrevoContactSyncJob(
    f.app,
    { isEnabled: async () => true },
    {
      upsertContact: async () => {
        throw new Error('upsert');
      },
      removeContact: async () => {
        throw new Error('unlink');
      },
    },
    e.dependencies.clock,
  );
  assert.equal((await sync.run(10)).synced, 0);
  assert.deepEqual(
    await createStatusLinkService(f.app, {
      clock: e.dependencies.clock,
      flags: { isEnabled: async () => true },
    }).authenticate(status.token),
    { kind: 'rejected' },
  );
  assert.deepEqual(
    await createRankingRepository(f.app).listLeaderboardCandidates(10),
    [],
  );
  assert.equal(
    await createGiveawayDrawRepository(f.app).eligiblePersonCount(),
    0,
  );
  assert.deepEqual(
    await createGiveawayDrawRepository(f.app).ledgerPage(null),
    [],
  );
  const pending = await createDsrRepository(f.app).pending(p.id);
  assert.equal(JSON.stringify(pending).includes(p.email), false);
  assert.equal(
    (
      await f.owner.readOne<{ n: string }>({
        text: 'SELECT count(*)::text n FROM dsr_erasure',
      })
    )?.n,
    '1',
  );
});

test('Brevo DELETE uses ext_id, accepts 204 and 404, sanitizes failures; retries resume from pending row', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  let attempt = 0;
  const provider = createBrevoProvider('test-key', 'mail.valstara.com', 1, {
    fetch: async (input, init) => {
      assert.equal(init?.method, 'DELETE');
      assert.ok(
        String(input).endsWith(
          `${encodeURIComponent(p.email)}?identifierType=ext_id`,
        ),
      );
      attempt++;
      return new Response(null, { status: attempt === 1 ? 503 : 404 });
    },
  });
  const dependencies = {
    ...e.dependencies,
    deleteContact: provider.deleteContact,
  };
  const job = createErasureService(f.app, dependencies);
  await request(f.app, job, p.id);
  assert.equal(await job.run(), 0);
  assert.equal((await createDsrRepository(f.app).pending(p.id))?.attempts, 1);
  e.time.now = new Date(e.time.now.getTime() + 60_000);
  assert.equal(await createErasureService(f.app, dependencies).run(), 1);
  assert.equal(attempt, 2);
  const success = createBrevoProvider('test-key', 'mail.valstara.com', 1, {
    fetch: async () => new Response(null, { status: 204 }),
  });
  await success.deleteContact(p.email);
  assert.equal(
    (await createDsrRepository(f.app).subject(p.id))?.email_normalised,
    null,
  );
  assert.equal(erasureBackoff(1), 60_000);
  assert.equal(erasureBackoff(100), 3_600_000);
});

test('fulfilment removes personal fields and suppression, preserves confirmed referral count, appends protected ledger', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner, 'private-person');
  const ref = await person(f.owner);
  const e = environment(f.app);
  await assert.rejects(
    f.app.execute({
      text: 'INSERT INTO dsr_erasure(subscriber_id,requested_at,next_attempt_at) VALUES($1,$2,$2)',
      values: [p.id, e.time.now],
    }),
    /erasure request and subscriber state disagree/,
  );
  await assert.rejects(
    f.app.execute({
      text: 'INSERT INTO erasure_ledger(subscriber_id,erased_at) VALUES($1,$2)',
      values: [p.id, e.time.now],
    }),
    /erasure ledger requires an erased subscriber/,
  );
  await f.owner.execute({
    text: `UPDATE subscriber SET category_preference=ARRAY['private-category'], source='private-source',
      utm='{"campaign":"private-campaign"}', referral_code='private-code', giveaway_rules_version='private-rules', referred_by_id=$2,
      access_window='wave-1', subslush_customer=true, signup_ip_prefix_hash=decode(repeat('ab',32),'hex') WHERE id=$1`,
    values: [p.id, ref.id],
  });

  await f.owner.execute({
    text: `INSERT INTO referral_edge(id,referrer_id,referred_id,state,reward_state,confirmed_at) VALUES($1,$2,$3,'confirmed','settled',$4)`,
    values: [randomUUID(), ref.id, p.id, e.time.now],
  });
  await f.owner.execute({
    text: `UPDATE subscriber SET confirmed_referrals=1 WHERE id=$1`,
    values: [ref.id],
  });
  await f.owner.execute({
    text: `INSERT INTO suppression(email_normalised,reason,source) VALUES($1,'manual','test')`,
    values: [p.email],
  });
  await f.owner.execute({
    text: `INSERT INTO survey_response(id,subscriber_id,version,answers) VALUES($1,$2,'v1',$3::jsonb)`,
    values: [randomUUID(), p.id, JSON.stringify({ personal: p.email })],
  });
  await request(f.app, e.service, p.id);
  assert.equal(await e.service.run(), 1);
  assert.deepEqual(e.calls, [p.email]);
  await withTransaction(f.app, (connection) =>
    createEmailWebhookRepository(connection).suppressAddress(
      p.email,
      'complaint',
      'brevo',
      e.time.now,
    ),
  );
  assert.equal(
    await f.owner.readOne({
      text: 'SELECT 1 FROM suppression WHERE email_normalised=$1',
      values: [p.email],
    }),
    null,
  );

  assert.equal(
    (
      await f.owner.readOne<{ n: string }>({
        text: `SELECT count(*)::text n FROM referral_edge WHERE referrer_id=$1 AND state='confirmed' AND referred_id IS NULL`,
        values: [ref.id],
      })
    )?.n,
    '1',
  );
  assert.equal(
    (
      await f.owner.readOne<{ confirmed_referrals: number }>({
        text: 'SELECT confirmed_referrals FROM subscriber WHERE id=$1',
        values: [ref.id],
      })
    )?.confirmed_referrals,
    1,
  );
  const tables = await f.owner.list<{ table_name: string }>(
    {
      text: "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    },
    100,
  );
  for (const { table_name: table } of tables) {
    const rows = await f.owner.list(
      { text: `SELECT to_jsonb(t) AS data FROM "${table}" t` },
      100,
    );
    assert.equal(JSON.stringify(rows).includes(p.email), false, table);
  }
  for (const table of ['erasure_ledger', 'giveaway_draw_void']) {
    await assert.rejects(f.app.execute({ text: `DELETE FROM ${table}` }));
    await assert.rejects(
      f.app.execute({
        text: `UPDATE ${table} SET subscriber_id=$1`,
        values: [randomUUID()],
      }),
    );
  }
  await assert.rejects(
    f.owner.execute({ text: 'DELETE FROM erasure_ledger' }),
    /append-only/,
  );
  const erased = await f.owner.readOne<Record<string, unknown>>({
    text: 'SELECT * FROM subscriber WHERE id=$1',
    values: [p.id],
  });
  const retained = {
    id: p.id,
    status: 'erased',
    confirmed_referrals: 0,
    referral_tier: 0,
    subslush_customer: false,
    marketing_opt_in_pending: false,
  };
  for (const [key, value] of Object.entries(erased!))
    assert.deepEqual(
      value,
      retained[key as keyof typeof retained] ?? null,
      key,
    );
  await assert.rejects(
    f.app.readOne({
      text: 'SELECT erase_subscriber_identity($1)',
      values: [ref.id],
    }),
    /pending request/,
  );
  assert.equal(await e.service.run(), 0);
  const referred = await person(f.owner);
  const sourceEdge = randomUUID();
  await f.owner.execute({
    text: `INSERT INTO referral_edge(id,referrer_id,referred_id,state,reward_state,confirmed_at) VALUES($1,$2,$3,'confirmed','settled',$4)`,
    values: [sourceEdge, ref.id, referred.id, e.time.now],
  });
  await request(f.app, e.service, ref.id);
  await e.service.run();
  const severed = await f.owner.readOne<{
    referrer_id: string | null;
    referred_id: string | null;
  }>({
    text: 'SELECT referrer_id,referred_id FROM referral_edge WHERE id=$1',
    values: [sourceEdge],
  });
  assert.deepEqual(severed, { referrer_id: null, referred_id: null });
  const fresh = await person(f.owner, 'private-person');
  assert.notEqual(fresh.id, p.id);
});

test('provider success followed by local rollback resumes on 404 after restart', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  await request(f.app, e.service, p.id);
  await f.owner.execute({
    text: "ALTER TABLE audit_log ADD CONSTRAINT fail_fulfilment CHECK(action <> 'dsr.fulfilled')",
  });
  await assert.rejects(e.service.run());
  assert.equal(e.calls.length, 1);
  assert.equal(
    (await createDsrRepository(f.app).subject(p.id))?.email_normalised,
    p.email,
  );
  await f.owner.execute({
    text: 'ALTER TABLE audit_log DROP CONSTRAINT fail_fulfilment',
  });
  const provider = createBrevoProvider('test', 'mail.valstara.com', 1, {
    fetch: async () => new Response(null, { status: 404 }),
  });
  assert.equal(
    await createErasureService(f.app, {
      ...e.dependencies,
      deleteContact: provider.deleteContact,
    }).run(),
    1,
  );
});

test('seven-day expiry and pre-deadline P1 carry only opaque ID; manual CLI completes and audits actor', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  await request(f.app, e.service, p.id);
  e.time.now = new Date(e.time.now.getTime() + 7 * 86400000);
  await e.service.run();
  assert.equal(e.calls.length, 0);
  assert.equal(e.alerts[0]?.severity, 'P1');
  assert.deepEqual(e.alerts[0]?.detail, { subscriber_id: p.id });
  e.time.now = new Date(e.time.now.getTime() + 21 * 86400000);
  await e.service.run();
  assert.equal(e.alerts[1]?.event, 'dsr_deadline_operator_task');
  await completeErasureCommand(e.service, [
    '--subscriber-id',
    p.id,
    '--actor',
    'operator:test',
  ]);
  assert.equal(
    (await createDsrRepository(f.app).subject(p.id))?.status,
    'erased',
  );
  assert.equal(
    (
      await f.app.readOne({
        text: "SELECT actor FROM audit_log WHERE action='dsr.fulfilled' AND subject_id=$1",
        values: [p.id],
      })
    )?.actor,
    'operator:test',
  );
  await completeErasureCommand(e.service, [
    '--subscriber-id',
    p.id,
    '--actor',
    'operator:test',
  ]);
  assert.throws(() => commandOptions(['--unexpected', 'x'], ['--actor']));
  await assert.rejects(
    completeErasureCommand(e.service, [
      '--subscriber-id',
      'invalid',
      '--actor',
      'operator',
    ]),
  );
});

test('newest ledger re-application erases restored live data and is idempotent', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  const directory = await mkdtemp(join(tmpdir(), 'dsr-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'ledger.jsonl');
  await writeFile(
    file,
    JSON.stringify({
      subscriber_id: p.id,
      erased_at: e.time.now.toISOString(),
    }) + '\n',
  );
  const args = ['--ledger-file', file, '--actor', 'operator:restore'];
  await reapplyErasureCommand(f.app, e.service, args);
  await reapplyErasureCommand(f.app, e.service, args);
  assert.equal(
    (await createDsrRepository(f.app).subject(p.id))?.email_normalised,
    null,
  );
  assert.deepEqual(e.calls, []);
  assert.equal(
    (
      await f.owner.readOne({
        text: "SELECT count(*)::int n FROM audit_log WHERE action='dsr.fulfilled' AND subject_id=$1",
        values: [p.id],
      })
    )?.n,
    1,
  );
});

test('signed-link request response equivalence, purpose isolation, bounded complete export and replay', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  const handler = createDsrHandler(f.app, {
    clock: e.dependencies.clock,
    challenge: async () => 'verified',
    erasure: e.service,
    alerts: e.dependencies.alerts,
  });
  const formRequest = (body: Record<string, string>) =>
    new Request('http://localhost:4321/api/dsr/export', {
      method: 'POST',
      body: new URLSearchParams(body),
    });
  const known = await handler(
    'export',
    formRequest({ email: p.email, turnstile_token: 'test' }),
    'known',
  );
  const unknown = await handler(
    'export',
    formRequest({ email: 'unknown@example.test', turnstile_token: 'test' }),
    'unknown',
  );
  assert.equal(known.status, unknown.status);
  assert.equal(await known.text(), await unknown.text());
  assert.equal(
    await f.owner.readOne({
      text: 'SELECT 1 FROM rate_limit_bucket WHERE position($1 in key)>0',
      values: [p.email],
    }),
    null,
  );

  const issued = await createVerificationService(f.app, {
    clock: e.dependencies.clock,
  }).issue(p.id, 'dsr_export');
  assert.equal(
    (await handler('delete', formRequest({ token: issued.token }), 'delete'))
      .status,
    200,
  );
  assert.equal(
    (await createDsrRepository(f.app).subject(p.id))?.status,
    'verified',
  );
  const exported = await handler(
    'export',
    formRequest({ token: issued.token }),
    'export',
  );
  assert.equal(exported.headers.get('content-type'), 'application/x-ndjson');
  const rows = (await exported.text())
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  const subject = rows.find((row) => row.table === 'subscriber').data;
  assert.equal(subject.email, p.email);
  const columns = await f.owner.list<{ column_name: string }>(
    {
      text: "SELECT column_name FROM information_schema.columns WHERE table_name='subscriber' ORDER BY column_name",
    },
    100,
  );
  assert.deepEqual(
    Object.keys(subject).sort(),
    columns.map((c) => c.column_name),
  );
  assert.ok(rows.some((row) => row.table === 'verification_token'));
  assert.equal(
    (
      await handler('export', formRequest({ token: issued.token }), 'export')
    ).headers.get('content-type'),
    'application/json; charset=utf-8',
  );
  const expired = await createVerificationService(f.app, {
    clock: e.dependencies.clock,
  }).issue(p.id, 'dsr_export');
  e.time.now = new Date(e.time.now.getTime() + 24 * 60 * 60_000 + 1);
  const wrongPurpose = await createVerificationService(f.app, {
    clock: e.dependencies.clock,
  }).issue(p.id, 'dsr_delete');
  for (const [ip, token, firstStatus] of [
    ['invalid-link', 'invalid', 400],
    ['wrong-purpose', wrongPurpose.token, 400],
    ['expired-link', expired.token, 400],
    ['replayed-link', issued.token, 200],
  ] as const) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const result = await handler('export', formRequest({ token }), ip);
      assert.equal(result.status, attempt === 6 ? 429 : firstStatus, ip);
    }
    assert.equal(
      (
        await f.owner.readOne<{ count: number }>({
          text: 'SELECT count FROM rate_limit_bucket WHERE key=$1',
          values: [`dsr:confirm:ip:${ip}`],
        })
      )?.count,
      6,
      ip,
    );
  }
  const deleteToken = await createVerificationService(f.app, {
    clock: e.dependencies.clock,
  }).issue(p.id, 'dsr_delete');
  assert.equal(
    (
      await handler(
        'delete',
        formRequest({ token: deleteToken.token }),
        'delete',
      )
    ).status,
    200,
  );
  assert.equal(
    (await createDsrRepository(f.app).subject(p.id))?.status,
    'erasure_pending',
  );
});

test('export covers each modelled subject table and never includes the other referral subject', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner),
    other = await person(f.owner);
  const unrelated = await person(f.owner);
  await f.owner.execute({
    text: "INSERT INTO referral_edge(id,referrer_id,referred_id,state,reward_state) VALUES($1,$2,$3,'confirmed','settled')",
    values: [randomUUID(), other.id, p.id],
  });
  await f.owner.execute({
    text: `INSERT INTO survey_response(id,subscriber_id,version,answers)
      VALUES($1,$2,'subject-v1',$3::jsonb),($4,$5,'other-v1',$6::jsonb)`,
    values: [
      randomUUID(),
      p.id,
      JSON.stringify({ preference: 'subject-choice' }),
      randomUUID(),
      other.id,
      JSON.stringify({ preference: 'other-choice' }),
    ],
  });
  const ownHandle = createHash('sha256')
    .update(p.id)
    .digest('base64url')
    .slice(0, 12);
  const otherHandle = createHash('sha256')
    .update(other.id)
    .digest('base64url')
    .slice(0, 12);
  const snapshotId = randomUUID();
  await f.owner.execute({
    text: 'INSERT INTO leaderboard_snapshot(id,as_of,entries) VALUES($1,$2,$3::jsonb)',
    values: [
      snapshotId,
      new Date('2026-10-02'),
      JSON.stringify([
        { rank: 1, display_handle: ownHandle, confirmed_referrals: 1 },
        { rank: 2, display_handle: otherHandle, confirmed_referrals: 1 },
      ]),
    ],
  });
  await f.owner.execute({
    text: 'INSERT INTO leaderboard_served_snapshot(singleton,snapshot_id) VALUES(true,$1)',
    values: [snapshotId],
  });
  await f.owner.execute({
    text: "INSERT INTO weekly_campaign_run(iso_week,state,snapshot_id,recorded_at) VALUES('2026-W40','completed',$1,$2)",
    values: [snapshotId, new Date('2026-10-02')],
  });
  await f.owner.execute({
    text: `INSERT INTO fraud_flag(id,subscriber_id,kind,detail,state)
      VALUES($1,$2,'manual',$3::jsonb,'open')`,
    values: [
      randomUUID(),
      p.id,
      JSON.stringify({ reason: `Review mentioned ${other.email}` }),
    ],
  });
  const relatedFlagId = randomUUID();
  await f.owner.execute({
    text: `INSERT INTO fraud_flag(id,subscriber_id,kind,detail,state)
      VALUES($1,$2,'duplicate_identity',$3::jsonb,'open')`,
    values: [
      relatedFlagId,
      other.id,
      JSON.stringify({
        rule: 'same_local_part',
        version: 1,
        local_part: 'subject',
        match_count: 2,
        matched_subscriber_ids: [p.id, unrelated.id],
      }),
    ],
  });
  const parts: string[] = [];
  for await (const part of exportSubject(f.app, p.id)) parts.push(part);
  assert.equal(parts.join('').includes(other.id), false);
  assert.equal(parts.join('').includes(other.email), false);
  assert.equal(parts.join('').includes(otherHandle), false);
  const exportedRows = parts.map((part) => JSON.parse(part));
  assert.deepEqual(
    exportedRows
      .filter((row) => row.table === 'survey_response')
      .map((row) => ({ version: row.data.version, answers: row.data.answers })),
    [{ version: 'subject-v1', answers: { preference: 'subject-choice' } }],
  );
  const relatedFlag = exportedRows.find(
    (row) => row.table === 'fraud_flag' && row.data.id === relatedFlagId,
  );
  assert.ok(
    relatedFlag,
    'a match recorded on another subscriber belongs in the export',
  );
  assert.equal(relatedFlag.data.subscriber_id, null);
  assert.deepEqual(relatedFlag.data.detail.matched_subscriber_ids, [p.id]);
  const snapshot = exportedRows.find(
    (row) => row.table === 'leaderboard_snapshot',
  );
  assert.deepEqual(
    snapshot.data.entries.map(
      (entry: { display_handle: string }) => entry.display_handle,
    ),
    [ownHandle],
  );
  assert.ok(
    exportedRows.some((row) => row.table === 'leaderboard_served_snapshot'),
  );
  assert.ok(exportedRows.some((row) => row.table === 'weekly_campaign_run'));
  for (const row of exportedRows) {
    const columns = await f.owner.list<{ column_name: string }>(
      {
        text: `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name`,
        values: [row.table],
      },
      100,
    );
    assert.deepEqual(
      Object.keys(row.data).sort(),
      columns.map((c) => c.column_name),
      row.table,
    );
  }

  const model = await readFile('docs/data/model.md', 'utf8');
  for (const table of Object.keys(subjectExportTables))
    assert.ok(model.includes(table), table);
  const tables = await f.owner.list<{ table_name: string }>(
    {
      text: "SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('subscriber_id','referred_id','referrer_id') ORDER BY table_name",
    },
    100,
  );
  assert.deepEqual(
    tables.map((t) => t.table_name).filter((t) => !(t in subjectExportTables)),
    [],
  );
  // The renderers produce both alternatives and an inert first-party link.
  const renderer = dsrRenderers(
    'http://localhost:4321',
    'send.valstara.com',
  ).get('dsr_delete')!;
  const message = await renderer.render({
    email: p.email,
    payload: { token_id: randomUUID() },
    token: async () => 'signed-test-token',
    unsubscribePageUrl: 'http://localhost:4321/unsubscribe?t=test',
  });
  assert.ok(message.text.includes('/dsr?operation=delete'));
  assert.ok(message.html?.includes('/dsr?operation=delete'));
});

test('pending commit waits for an in-flight Brevo upsert and restart cannot upsert the subject', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const sync = createBrevoContactSyncJob(
    f.app,
    { isEnabled: async () => true },
    {
      upsertContact: async () => {
        started.resolve();
        await release.promise;
        order.push('upsert');
      },
      removeContact: async () => {
        throw new Error('unexpected unlink');
      },
    },
    e.dependencies.clock,
  );
  const running = sync.run(10);
  await started.promise;
  const confirmation = request(f.app, e.service, p.id).then(() => {
    order.push('pending');
  });
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await f.owner.readOne({
        text: `SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE 'SELECT id, email_normalised, status%'`,
      });
      if (waiting) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      blocked,
      true,
      'confirmation must wait on the provider-held subscriber lock',
    );
  } finally {
    release.resolve();
    await Promise.all([running, confirmation]);
  }
  assert.deepEqual(order, ['upsert', 'pending']);
  assert.equal((await sync.run(10)).synced, 0);
  assert.equal(
    await f.owner.readOne({
      text: 'SELECT 1 FROM brevo_contact_sync WHERE email_normalised=$1',
      values: [p.email],
    }),
    null,
  );
  assert.equal(await e.service.run(), 1);
});

test('concurrent pending confirmations and erasure workers fulfil exactly once', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  await Promise.all([
    request(f.app, e.service, p.id),
    request(f.app, e.service, p.id),
  ]);
  assert.equal(
    (await Promise.all([e.service.run(), e.service.run()])).reduce(
      (a, b) => a + b,
    ),
    1,
  );
  assert.deepEqual(e.calls, [p.email]);
  const audit = await f.owner.list<{ action: string }>(
    {
      text: "SELECT action FROM audit_log WHERE subject_id=$1 AND action IN ('dsr.requested','dsr.fulfilled') ORDER BY action",
      values: [p.id],
    },
    10,
  );
  assert.deepEqual(
    audit.map((r) => r.action),
    ['dsr.fulfilled', 'dsr.requested'],
  );
});

test('pending confirmation redacts stored and stale leaderboard snapshots and removes entry entitlement', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  const entries = createGiveawayEntryRepository(f.app);
  const start = new Date('2026-09-01'),
    end = new Date('2026-11-01');
  assert.equal((await entries.missingEntitlements(start, end, 100)).length, 1);
  const handle = createHash('sha256')
    .update(p.id)
    .digest('base64url')
    .slice(0, 12);
  const payload = JSON.stringify([
    { rank: 1, display_handle: handle, confirmed_referrals: 0 },
  ]);
  const old = randomUUID(),
    stale = randomUUID();
  await f.app.execute({
    text: 'INSERT INTO leaderboard_snapshot(id,as_of,entries) VALUES($1,$2,$3::jsonb)',
    values: [old, e.time.now, payload],
  });
  await request(f.app, e.service, p.id);
  assert.deepEqual(await entries.missingEntitlements(start, end, 100), []);
  await f.app.execute({
    text: 'INSERT INTO leaderboard_snapshot(id,as_of,entries) VALUES($1,$2,$3::jsonb)',
    values: [stale, e.time.now, payload],
  });
  const rows = await f.app.list(
    { text: 'SELECT entries FROM leaderboard_snapshot ORDER BY id' },
    100,
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => JSON.stringify(r.entries) === '[]'));
  await assert.rejects(
    f.app.execute({
      text: "UPDATE subscriber SET status='verified' WHERE id=$1",
      values: [p.id],
    }),
    /cannot be resumed/,
  );
});

test('erasure maintenance continues to shutdown when alert delivery fails', async () => {
  const abort = new AbortController();
  let attempts = 0;
  await runErasureJob(
    {
      run: async () => {
        attempts++;
        throw new Error('db unavailable');
      },
    },
    {
      send: async () => {
        abort.abort();
        throw new Error('alerts unavailable');
      },
    },
    () => new Date('2026-10-02'),
    abort.signal,
  );
  assert.equal(attempts, 1);
});

test('the shipped operator CLI completes an audited pending erasure without provider credentials', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  await request(f.app, e.service, p.id);
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: f.appUrl };
  delete env.P1_ALERT_WEBHOOK_URL;
  delete env.P1_ALERT_WEBHOOK_TOKEN;
  delete env.BREVO_API_KEY;
  const result = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/complete-erasure.ts',
      '--subscriber-id',
      p.id,
      '--actor',
      'operator:cli-test',
    ],
    { env },
  );
  assert.match(result.stdout, /Erasure command completed/);
  assert.equal(
    (await createDsrRepository(f.app).subject(p.id))?.status,
    'erased',
  );
  assert.equal(
    (
      await f.app.readOne({
        text: "SELECT actor FROM audit_log WHERE action='dsr.fulfilled' AND subject_id=$1",
        values: [p.id],
      })
    )?.actor,
    'operator:cli-test',
  );
});

test('a failed rights-link request raises a sanitized P1 while preserving known-address acknowledgement', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await person(f.owner);
  const e = environment(f.app);
  await f.owner.execute({
    text: "ALTER TABLE audit_log ADD CONSTRAINT reject_dsr_request CHECK(action <> 'dsr.requested')",
  });
  const alerted = Promise.withResolvers<void>();
  const handler = createDsrHandler(f.app, {
    clock: e.dependencies.clock,
    challenge: async () => 'verified',
    erasure: e.service,
    alerts: {
      send: async (alert) => {
        e.alerts.push(alert);
        alerted.resolve();
      },
    },
  });
  const result = await handler(
    'export',
    new Request('http://localhost:4321/api/dsr/export', {
      method: 'POST',
      body: new URLSearchParams({ email: p.email, turnstile_token: 'test' }),
    }),
    'request-failure',
  );
  await alerted.promise;
  assert.equal(result.status, 200);
  assert.equal(e.alerts[0]?.severity, 'P1');
  assert.deepEqual(e.alerts[0]?.detail, { operation: 'export' });
  assert.equal(JSON.stringify(e.alerts).includes(p.email), false);
  assert.equal(
    (
      await f.owner.readOne<{ n: number }>({
        text: "SELECT count(*)::int n FROM verification_token WHERE subscriber_id=$1 AND purpose='dsr_export'",
        values: [p.id],
      })
    )?.n,
    0,
  );
});
