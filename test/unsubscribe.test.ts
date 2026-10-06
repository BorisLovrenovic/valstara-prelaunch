import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createUnsubscribeRoute } from '../src/pages/api/unsubscribe.ts';
import { createLeaveRoute } from '../src/pages/api/me/leave.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createEmailService,
  type EmailProvider,
  type TemplateRenderer,
} from '../src/server/email/service.ts';
import { createUnsubscribeService } from '../src/server/email/unsubscribe.ts';
import { createGiveawayEligibilityService } from '../src/server/giveaway/eligibility.ts';
import {
  deriveEmailToken,
  hashEmailToken,
} from '../src/server/verification/token-derivation.ts';
import {
  createUnsubscribeOperatorTaskTransport,
  type UnsubscribeOperatorTask,
} from '../src/server/verification-rate/p1-webhook.ts';
import {
  applyUnsubscribeFromCli,
  parseApplyUnsubscribeArgs,
} from '../scripts/apply-unsubscribe.ts';

const adminDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const secret = 'unsubscribe-test-secret-32-characters';
const now = new Date('2026-09-28T10:00:00.000Z');

async function fixture(): Promise<{
  owner: DatabasePool;
  app: DatabasePool;
  close(): Promise<void>;
}> {
  const name = `valstara_e606_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(adminDatabaseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appPassword,
    release: 'e6-06-test',
  });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    async close() {
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

async function subscriber(db: DatabasePool, consent: boolean): Promise<string> {
  const id = randomUUID();
  await db.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
      verified_at, marketing_consent_at, marketing_consent_version, marketing_consent_source)
      VALUES ($1, $2, $2, 'example.test', 'verified', $3, $4, $5, $6)`,
    values: [
      id,
      `${id}@example.test`,
      now,
      consent ? now : null,
      consent ? 'v1' : null,
      consent ? 'signup' : null,
    ],
  });
  return id;
}

async function boundEmail(
  db: DatabasePool,
  subscriberId: string,
  provider: string,
  template: string,
) {
  const businessKey = randomUUID();
  const email = createEmailService(db, {
    clock: () => now,
    tokenSecret: secret,
    baseUrl: 'https://example.test',
    providers: new Map(),
    renderers: new Map(),
    isBroadcastEnabled: async () => false,
    operatorTask: async () => undefined,
  });
  await email.queue({
    template,
    provider,
    subscriberId,
    businessKey,
    payload: { tier: 1 },
  });
  const row = await db.readOne<{ id: string; unsubscribe_token_id: string }>({
    text: 'SELECT id, unsubscribe_token_id FROM email_send WHERE business_key = $1',
    values: [businessKey],
  });
  assert.ok(row);
  return { ...row, token: deriveEmailToken(row.unsubscribe_token_id, secret) };
}

function service(
  db: DatabasePool,
  tasks: Array<{
    unsubscribeTokenId: string | null;
    emailSendId: string | null;
    requestedAction: string;
    occurredAt: Date;
  }> = [],
) {
  return createUnsubscribeService(db, {
    clock: () => now,
    tokenSecret: secret,
    onFailure: async (input) => {
      tasks.push(input);
    },
  });
}

test('E6-06 one-click marketing POST withdraws consent, preserves entries and records bound source; replay changes nothing', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, true);
    await f.owner.execute({
      text: `INSERT INTO giveaway_entry (id, subscriber_id, method, entries, rules_version, rules_sha256)
        VALUES ($1, $2, 'base', 1, 'v1', decode(repeat('ab', 32), 'hex'))`,
      values: [randomUUID(), id],
    });
    const email = await boundEmail(f.app, id, 'brevo', 'weekly_update');
    const unsubscribe = service(f.app);
    const route = createUnsubscribeRoute({
      apply: unsubscribe.apply,
      ipPrefixPepper: 'test-pepper',
    });
    const form = new URLSearchParams({ 'List-Unsubscribe': 'One-Click' });
    const request = new Request(
      `https://example.test/api/unsubscribe?token=${email.token}`,
      { method: 'POST', body: form },
    );
    const response = await route({
      request,
      url: new URL(request.url),
      clientAddress: '192.0.2.1',
    } as never);
    assert.equal(response.status, 200);
    const multipart = new FormData();
    multipart.set('List-Unsubscribe', 'One-Click');
    const multipartRequest = new Request(
      `https://example.test/api/unsubscribe?token=${email.token}`,
      { method: 'POST', body: multipart },
    );
    const multipartReplay = await route({
      request: multipartRequest,
      url: new URL(multipartRequest.url),
      clientAddress: '192.0.2.1',
    } as never);
    assert.equal(multipartReplay.status, 200);
    const state = await f.owner.readOne<{
      marketing_consent_at: Date | null;
      status: string;
      entries: string;
      audit: string;
      source: string;
    }>({
      text: `SELECT s.marketing_consent_at, s.status,
        (SELECT COUNT(*)::text FROM giveaway_entry WHERE subscriber_id = s.id) AS entries,
        (SELECT COUNT(*)::text FROM audit_log WHERE subject_id = s.id::text AND action = 'consent.marketing_withdrawn') AS audit,
        (SELECT detail->>'source_template' FROM audit_log WHERE subject_id = s.id::text AND action = 'consent.marketing_withdrawn') AS source
        FROM subscriber s WHERE s.id = $1`,
      values: [id],
    });
    assert.equal(state?.marketing_consent_at, null);
    assert.equal(state?.status, 'verified');
    assert.equal(state?.entries, '1');
    assert.equal(state?.audit, '1');
    assert.equal(state?.source, 'weekly_update');
    assert.equal(
      await unsubscribe.apply({
        token: email.token,
        action: 'leave_waitlist',
        ipPrefixHash: 'ip',
      }),
      'already',
    );
    const suppression = await f.owner.readOne({
      text: 'SELECT 1 FROM suppression WHERE email_normalised = (SELECT email_normalised FROM subscriber WHERE id = $1)',
      values: [id],
    });
    assert.equal(suppression, null);
    const injected = new Request(
      `https://example.test/api/unsubscribe?token=${email.token}&template=other`,
      { method: 'POST', body: form },
    );
    const rejected = await route({
      request: injected,
      url: new URL(injected.url),
      clientAddress: '192.0.2.1',
    } as never);
    assert.equal(rejected.status, 400);
    const formInjected = new Request(
      `https://example.test/api/unsubscribe?token=${email.token}`,
      {
        method: 'POST',
        body: new URLSearchParams({
          'List-Unsubscribe': 'One-Click',
          template: 'other',
        }),
      },
    );
    const formRejected = await route({
      request: formInjected,
      url: new URL(formInjected.url),
      clientAddress: '192.0.2.1',
    } as never);
    assert.equal(formRejected.status, 400);
  } finally {
    await f.close();
  }
});

test('unsubscribe events require a person-initiated effective change', async () => {
  const f = await fixture();
  try {
    const events: string[] = [];
    const unsubscribe = createUnsubscribeService(f.app, {
      clock: () => now,
      tokenSecret: secret,
      onFailure: async () => undefined,
      onEffectiveChange: (template) => events.push(template),
    });
    const withdrawing = await subscriber(f.owner, true);
    const marketing = await boundEmail(
      f.app,
      withdrawing,
      'brevo',
      'weekly_campaign_update',
    );
    assert.equal(
      await unsubscribe.apply({
        token: marketing.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'withdraw',
      }),
      'accepted',
    );
    assert.deepEqual(events, ['weekly_campaign_update']);
    assert.equal(
      await unsubscribe.apply({
        token: marketing.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'replay',
      }),
      'already',
    );

    const noOp = await subscriber(f.owner, false);
    const noOpMail = await boundEmail(
      f.app,
      noOp,
      'brevo',
      'weekly_campaign_update',
    );
    assert.equal(
      await unsubscribe.apply({
        token: noOpMail.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'noop',
      }),
      'accepted',
    );
    assert.deepEqual(events, ['weekly_campaign_update']);

    const leaving = await subscriber(f.owner, true);
    const leaveMail = await boundEmail(
      f.app,
      leaving,
      'brevo',
      'weekly_campaign_update',
    );
    assert.equal(
      await unsubscribe.apply({
        token: leaveMail.token,
        action: 'leave_waitlist',
        ipPrefixHash: 'leave',
      }),
      'accepted',
    );
    assert.deepEqual(events, [
      'weekly_campaign_update',
      'weekly_campaign_update',
    ]);
    const left = await f.owner.readOne<{
      status: string;
      marketing_consent_at: Date | null;
    }>({
      text: 'SELECT status, marketing_consent_at FROM subscriber WHERE id = $1',
      values: [leaving],
    });
    assert.deepEqual(left, {
      status: 'unsubscribed',
      marketing_consent_at: null,
    });
    assert.equal(
      await unsubscribe.apply({
        token: leaveMail.token,
        action: 'leave_waitlist',
        ipPrefixHash: 'leave-replay',
      }),
      'already',
    );

    const transactionalOnly = await subscriber(f.owner, false);
    const transactionalMail = await boundEmail(
      f.app,
      transactionalOnly,
      'resend',
      'status_link',
    );
    assert.equal(
      await unsubscribe.apply({
        token: transactionalMail.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'transactional-only',
      }),
      'accepted',
    );
    assert.deepEqual(events, [
      'weekly_campaign_update',
      'weekly_campaign_update',
    ]);

    const bounced = await subscriber(f.owner, false);
    const bounceMail = await boundEmail(
      f.app,
      bounced,
      'resend',
      'status_link',
    );
    await f.owner.execute({
      text: `INSERT INTO suppression (email_normalised, reason, source)
             SELECT email_normalised, 'bounce_hard', 'provider' FROM subscriber WHERE id = $1`,
      values: [bounced],
    });
    assert.equal(
      await unsubscribe.apply({
        token: bounceMail.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'bounce',
      }),
      'accepted',
    );
    assert.deepEqual(events, [
      'weekly_campaign_update',
      'weekly_campaign_update',
    ]);
  } finally {
    await f.close();
  }
});

test('E6-06 transactional unsubscribe and explicit leave both create one global suppression', async () => {
  const f = await fixture();
  try {
    const first = await subscriber(f.owner, false);
    const second = await subscriber(f.owner, true);
    const transactional = await boundEmail(
      f.app,
      first,
      'resend',
      'status_link',
    );
    const marketing = await boundEmail(f.app, second, 'brevo', 'weekly_update');
    const unsubscribe = service(f.app);
    assert.equal(
      await unsubscribe.apply({
        token: transactional.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'ip-1',
      }),
      'accepted',
    );
    assert.equal(
      await unsubscribe.apply({
        token: marketing.token,
        action: 'leave_waitlist',
        ipPrefixHash: 'ip-2',
      }),
      'accepted',
    );
    const rows = await f.owner.list<{ source: string }>(
      { text: 'SELECT source FROM suppression ORDER BY source' },
      10,
    );
    assert.deepEqual(
      rows.map((row) => row.source),
      ['status_link', 'weekly_update'],
    );
    const states = await f.owner.list<{
      id: string;
      status: string;
      unsubscribed_at: Date | null;
    }>(
      {
        text: 'SELECT id, status, unsubscribed_at FROM subscriber WHERE id = ANY($1::uuid[])',
        values: [[first, second]],
      },
      2,
    );
    assert.equal(states.find((row) => row.id === first)?.status, 'verified');
    assert.equal(
      states.find((row) => row.id === second)?.status,
      'unsubscribed',
    );
    assert.equal(
      states.find((row) => row.id === second)?.unsubscribed_at?.toISOString(),
      now.toISOString(),
    );
    const eligibility = createGiveawayEligibilityService(f.app, {
      isEnabled: async () => true,
    });
    assert.equal(await eligibility.isEligible(second), false);
    const audit = await f.owner.readOne<{ count: string }>({
      text: "SELECT COUNT(*)::text AS count FROM audit_log WHERE action = 'subscriber.unsubscribed'",
    });
    assert.equal(audit?.count, '2');
    await boundEmail(f.app, first, 'brevo', 'weekly_update');
    let sends = 0;
    const provider = (id: string): EmailProvider => ({
      id,
      sendingDomain: 'example.test',
      capabilities: {
        broadcast: id === 'brevo',
        contactSync: false,
        dailyFreeCap: 100,
      },
      async send() {
        sends += 1;
        return { providerMessageId: 'unexpected' };
      },
    });
    const renderer = (
      kind: 'transactional' | 'broadcast',
    ): TemplateRenderer => ({
      kind,
      async render({ email }) {
        return {
          from: 'sender@example.test',
          to: email,
          subject: 'Test',
          text: 'Body',
        };
      },
    });
    const dispatcher = createEmailService(f.app, {
      clock: () => now,
      tokenSecret: secret,
      baseUrl: 'https://example.test',
      providers: new Map([
        ['resend', provider('resend')],
        ['brevo', provider('brevo')],
      ]),
      renderers: new Map([
        ['status_link', renderer('transactional')],
        ['weekly_update', renderer('broadcast')],
      ]),
      isBroadcastEnabled: async () => true,
      operatorTask: async () => undefined,
    });
    const summary = await dispatcher.dispatch(10);
    assert.equal(summary.suppressed, 3);
    assert.equal(sends, 0);
  } finally {
    await f.close();
  }
});

test('E6-06 concurrent one-click requests consume once and audit once against PostgreSQL', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, true);
    const email = await boundEmail(f.app, id, 'brevo', 'weekly_update');
    const unsubscribe = service(f.app);
    const outcomes = await Promise.all([
      unsubscribe.apply({
        token: email.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'ip-a',
      }),
      unsubscribe.apply({
        token: email.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'ip-b',
      }),
    ]);
    assert.deepEqual(outcomes.sort(), ['accepted', 'already']);
    const audit = await f.owner.readOne<{ count: string }>({
      text: "SELECT COUNT(*)::text AS count FROM audit_log WHERE subject_id = $1::text AND action = 'consent.marketing_withdrawn'",
      values: [id],
    });
    assert.equal(audit?.count, '1');
  } finally {
    await f.close();
  }
});

test('E6-06 signed-token writes are rate limited and a limited token stays usable', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, true);
    const tokens = [];
    for (let index = 0; index < 6; index += 1) {
      tokens.push(await boundEmail(f.app, id, 'brevo', 'weekly_update'));
    }
    let currentTime = now;
    const unsubscribe = createUnsubscribeService(f.app, {
      clock: () => currentTime,
      tokenSecret: secret,
      onFailure: async () => {
        assert.fail('Rate limiting must not emit an operator task.');
      },
    });
    for (const email of tokens.slice(0, 5)) {
      assert.equal(
        await unsubscribe.apply({
          token: email.token,
          action: 'message_unsubscribe',
          ipPrefixHash: 'same-ip-prefix',
        }),
        'accepted',
      );
    }
    const limited = tokens[5]!;
    assert.equal(
      await unsubscribe.apply({
        token: limited.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'same-ip-prefix',
      }),
      'rate_limited',
    );
    const unconsumed = await f.owner.readOne<{ consumed_at: Date | null }>({
      text: 'SELECT consumed_at FROM verification_token WHERE id = $1',
      values: [limited.unsubscribe_token_id],
    });
    assert.equal(unconsumed?.consumed_at, null);
    currentTime = new Date(now.getTime() + 16 * 60 * 1_000);
    assert.equal(
      await unsubscribe.apply({
        token: limited.token,
        action: 'message_unsubscribe',
        ipPrefixHash: 'same-ip-prefix',
      }),
      'accepted',
    );
  } finally {
    await f.close();
  }
});

test('E6-06 suppression failure rolls back token and audit, alerts P1, then retry succeeds', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, false);
    const email = await boundEmail(f.app, id, 'resend', 'status_link');
    await f.owner.execute({
      text: `CREATE FUNCTION reject_suppression() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected write failure'; END; $$`,
    });
    await f.owner.execute({
      text: 'CREATE TRIGGER reject_suppression BEFORE INSERT ON suppression FOR EACH ROW EXECUTE FUNCTION reject_suppression()',
    });
    let alertBody: Record<string, unknown> | null = null;
    const alerts = createUnsubscribeOperatorTaskTransport(
      { url: 'https://example.test/alert', token: 'credential' },
      {
        fetch: async (_url, init) => {
          alertBody = JSON.parse(String(init?.body));
          return new Response(null, { status: 200 });
        },
      },
    );
    const unsubscribe = createUnsubscribeService(f.app, {
      clock: () => now,
      tokenSecret: secret,
      onFailure: (input) =>
        alerts.send({
          kind: 'operator_task',
          task: 'unsubscribe_apply_failed',
          unsubscribe_token_id: input.unsubscribeTokenId,
          email_send_id: input.emailSendId,
          token_sha256: input.tokenSha256,
          requested_action: input.requestedAction,
          occurred_at: input.occurredAt.toISOString(),
        }),
    });
    const route = createUnsubscribeRoute({
      apply: unsubscribe.apply,
      ipPrefixPepper: 'test-pepper',
    });
    const makeRequest = () =>
      new Request(`https://example.test/api/unsubscribe?token=${email.token}`, {
        method: 'POST',
        body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
      });
    const request = makeRequest();
    const response = await route({
      request,
      url: new URL(request.url),
      clientAddress: '192.0.2.1',
    } as never);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'unavailable');
    assert.deepEqual(alertBody, {
      severity: 'P1',
      kind: 'operator_task',
      task: 'unsubscribe_apply_failed',
      unsubscribe_token_id: email.unsubscribe_token_id,
      email_send_id: email.id,
      token_sha256: hashEmailToken(email.token).toString('hex'),
      requested_action: 'message_unsubscribe',
      occurred_at: now.toISOString(),
    });
    assert.equal(JSON.stringify(alertBody).includes(email.token), false);
    assert.equal(JSON.stringify(alertBody).includes('@'), false);
    const state = await f.owner.readOne<{
      consumed_at: Date | null;
      audit: string;
    }>({
      text: `SELECT t.consumed_at, (SELECT COUNT(*)::text FROM audit_log WHERE subject_id = $1::text AND action = 'subscriber.unsubscribed') AS audit
        FROM verification_token t WHERE t.id = $2`,
      values: [id, email.unsubscribe_token_id],
    });
    assert.equal(state?.consumed_at, null);
    assert.equal(state?.audit, '0');
    await f.owner.execute({
      text: 'DROP TRIGGER reject_suppression ON suppression',
    });
    const retry = makeRequest();
    const success = await route({
      request: retry,
      url: new URL(retry.url),
      clientAddress: '192.0.2.1',
    } as never);
    assert.equal(success.status, 200);
    const suppressed = await f.owner.readOne({
      text: 'SELECT 1 FROM suppression WHERE email_normalised = (SELECT email_normalised FROM subscriber WHERE id = $1)',
      values: [id],
    });
    assert.ok(suppressed);
  } finally {
    await f.close();
  }
});

test('E6-06 leave status failure rolls back suppression, token and audit together', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, true);
    const email = await boundEmail(f.app, id, 'brevo', 'weekly_update');
    await f.owner.execute({
      text: "CREATE FUNCTION reject_leave_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected status failure'; END; $$",
    });
    await f.owner.execute({
      text: 'CREATE TRIGGER reject_leave_status BEFORE UPDATE OF status ON subscriber FOR EACH ROW EXECUTE FUNCTION reject_leave_status()',
    });
    const tasks: Array<{ requestedAction: string; tokenSha256: string }> = [];
    const unsubscribe = createUnsubscribeService(f.app, {
      clock: () => now,
      tokenSecret: secret,
      onFailure: async (input) => {
        tasks.push(input);
      },
    });
    await assert.rejects(
      unsubscribe.apply({
        token: email.token,
        action: 'leave_waitlist',
        ipPrefixHash: 'test-prefix',
      }),
      /injected status failure/u,
    );
    assert.deepEqual(tasks, [
      {
        unsubscribeTokenId: email.unsubscribe_token_id,
        emailSendId: email.id,
        tokenSha256: hashEmailToken(email.token).toString('hex'),
        requestedAction: 'leave_waitlist',
        occurredAt: now,
      },
    ]);
    const state = await f.owner.readOne<{
      consumed_at: Date | null;
      status: string;
      suppressed: boolean;
      audit: string;
    }>({
      text: `SELECT t.consumed_at, s.status,
        EXISTS (SELECT 1 FROM suppression x WHERE x.email_normalised = s.email_normalised) AS suppressed,
        (SELECT COUNT(*)::text FROM audit_log WHERE subject_id = s.id::text AND action = 'subscriber.unsubscribed') AS audit
        FROM verification_token t JOIN subscriber s ON s.id = t.subscriber_id WHERE t.id = $1`,
      values: [email.unsubscribe_token_id],
    });
    assert.deepEqual(state, {
      consumed_at: null,
      status: 'verified',
      suppressed: false,
      audit: '0',
    });
  } finally {
    await f.close();
  }
});

test('E6-06 P1 operator task body contains only allowed fields', async () => {
  let body: Record<string, unknown> | null = null;
  const transport = createUnsubscribeOperatorTaskTransport(
    { url: 'https://example.test/alert', token: 'credential' },
    {
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(null, { status: 200 });
      },
    },
  );
  const task: UnsubscribeOperatorTask = {
    kind: 'operator_task',
    task: 'unsubscribe_apply_failed',
    unsubscribe_token_id: randomUUID(),
    email_send_id: randomUUID(),
    token_sha256: hashEmailToken(
      deriveEmailToken(randomUUID(), secret),
    ).toString('hex'),
    requested_action: 'message_unsubscribe',
    occurred_at: now.toISOString(),
  };
  await transport.send(task);
  assert.deepEqual(body, { severity: 'P1', ...task });
  assert.equal(
    JSON.stringify(body).includes(
      deriveEmailToken(task.unsubscribe_token_id!, secret),
    ),
    false,
  );
  assert.equal(JSON.stringify(body).includes('@'), false);
  assert.equal(JSON.stringify(body).includes('192.0.2.'), false);
});

test('E6-06 outage before lookup alerts with hash and request action but null IDs', async () => {
  const token = deriveEmailToken(randomUUID(), secret);
  const hash = hashEmailToken(token).toString('hex');
  let alert: Record<string, unknown> | null = null;
  const transport = createUnsubscribeOperatorTaskTransport(
    { url: 'https://example.test/alert', token: 'credential' },
    {
      fetch: async (_url, init) => {
        alert = JSON.parse(String(init?.body));
        return new Response(null, { status: 200 });
      },
    },
  );
  const unavailable = {
    connect: async () => {
      throw new Error('database unavailable');
    },
  } as unknown as DatabasePool;
  const unsubscribe = createUnsubscribeService(unavailable, {
    clock: () => now,
    tokenSecret: secret,
    onFailure: (input) =>
      transport.send({
        kind: 'operator_task',
        task: 'unsubscribe_apply_failed',
        unsubscribe_token_id: input.unsubscribeTokenId,
        email_send_id: input.emailSendId,
        token_sha256: input.tokenSha256,
        requested_action: input.requestedAction,
        occurred_at: input.occurredAt.toISOString(),
      }),
  });
  await assert.rejects(
    unsubscribe.apply({
      token,
      action: 'leave_waitlist',
      credential: 'status',
      ipPrefixHash: 'prefix',
    }),
    /database unavailable/u,
  );
  assert.deepEqual(alert, {
    severity: 'P1',
    kind: 'operator_task',
    task: 'unsubscribe_apply_failed',
    unsubscribe_token_id: null,
    email_send_id: null,
    token_sha256: hash,
    requested_action: 'leave_waitlist',
    occurred_at: now.toISOString(),
  });
  const wire = JSON.stringify(alert);
  assert.equal(wire.includes(token), false);
  assert.equal(wire.includes('@'), false);
  assert.equal(wire.includes('192.0.2.'), false);
});

test('E6-06 CLI applies both actions with audited actor and is a no-op after consumption', async () => {
  const f = await fixture();
  try {
    const marketingId = await subscriber(f.owner, true);
    const suppressionId = await subscriber(f.owner, false);
    const marketing = await boundEmail(
      f.app,
      marketingId,
      'brevo',
      'weekly_update',
    );
    const transactional = await boundEmail(
      f.app,
      suppressionId,
      'resend',
      'status_link',
    );
    const unsubscribe = service(f.app);
    assert.equal(
      await applyUnsubscribeFromCli(
        {
          tokenSha256: hashEmailToken(marketing.token).toString('hex'),
          actor: 'operator_1',
        },
        unsubscribe,
      ),
      'applied',
    );
    assert.equal(
      await applyUnsubscribeFromCli(
        {
          tokenId: transactional.unsubscribe_token_id,
          actor: 'operator_1',
        },
        unsubscribe,
      ),
      'applied',
    );
    assert.equal(
      await applyUnsubscribeFromCli(
        {
          tokenId: marketing.unsubscribe_token_id,
          actor: 'operator_1',
        },
        unsubscribe,
      ),
      'already',
    );
    const rows = await f.owner.list<{ action: string; actor: string }>(
      {
        text: "SELECT action, actor FROM audit_log WHERE action IN ('consent.marketing_withdrawn', 'subscriber.unsubscribed') ORDER BY action",
      },
      10,
    );
    assert.deepEqual(rows, [
      { action: 'consent.marketing_withdrawn', actor: 'operator_1' },
      { action: 'subscriber.unsubscribed', actor: 'operator_1' },
    ]);
  } finally {
    await f.close();
  }
});

test('E6-06 CLI resolves a hash and requires the explicit leave action for status tokens', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, true);
    const tokenId = randomUUID();
    const token = deriveEmailToken(tokenId, secret);
    await f.owner.execute({
      text: "INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, 'status', '2099-01-01T00:00:00.000Z')",
      values: [tokenId, id, hashEmailToken(token)],
    });
    await f.owner.execute({
      text: 'UPDATE verification_token SET consumed_at = $2 WHERE id = $1',
      values: [tokenId, now],
    });
    const tokenSha256 = hashEmailToken(token).toString('hex');
    const unsubscribe = service(f.app);
    await assert.rejects(
      applyUnsubscribeFromCli(
        { tokenSha256, actor: 'operator_1' },
        unsubscribe,
      ),
      /requires --action leave_waitlist/u,
    );
    assert.equal(
      await applyUnsubscribeFromCli(
        { tokenSha256, actor: 'operator_1', action: 'leave_waitlist' },
        unsubscribe,
      ),
      'applied',
    );
    assert.equal(
      await applyUnsubscribeFromCli(
        { tokenSha256, actor: 'operator_1', action: 'leave_waitlist' },
        unsubscribe,
      ),
      'already',
    );
    const row = await f.owner.readOne<{ actor: string }>({
      text: "SELECT actor FROM audit_log WHERE subject_id = $1::text AND action = 'subscriber.unsubscribed'",
      values: [id],
    });
    assert.equal(row?.actor, 'operator_1');
    const subject = await f.owner.readOne<{ status: string }>({
      text: 'SELECT status FROM subscriber WHERE id = $1',
      values: [id],
    });
    assert.equal(subject?.status, 'unsubscribed');
    assert.throws(
      () =>
        parseApplyUnsubscribeArgs([
          '--token-sha256',
          tokenSha256,
          '--actor',
          'operator_1',
          '--action',
          'withdraw_marketing',
        ]),
      /Usage/u,
    );
  } finally {
    await f.close();
  }
});

test('E6-06 member leave verifies Turnstile before work and suppresses with a status token', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, true);
    const tokenId = randomUUID();
    const token = deriveEmailToken(tokenId, secret);
    await f.owner.execute({
      text: "INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, 'status', '2099-01-01T00:00:00.000Z')",
      values: [tokenId, id, hashEmailToken(token)],
    });
    await f.owner.execute({
      text: 'UPDATE verification_token SET consumed_at = $2 WHERE id = $1',
      values: [tokenId, now],
    });
    let verified = 0;
    let worked = 0;
    const shared = service(f.app);
    const route = createLeaveRoute({
      verifyTurnstile: async () => {
        verified += 1;
        return 'unavailable';
      },
      isEnabled: async () => {
        worked += 1;
        return true;
      },
      apply: async (input) => {
        worked += 1;
        return shared.apply(input);
      },
      ipPrefixPepper: 'test-pepper',
    });
    const call = async (body: URLSearchParams) => {
      const request = new Request('https://example.test/api/me/leave', {
        method: 'POST',
        body,
      });
      return route({ request, clientAddress: '192.0.2.1' } as never);
    };
    const missing = await call(new URLSearchParams({ t: token }));
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, 'challenge_failed');
    assert.equal(verified, 0);
    assert.equal(worked, 0);
    const disabledRoute = createLeaveRoute({
      verifyTurnstile: async () => 'verified',
      isEnabled: async () => false,
      apply: async () => {
        assert.fail('Flag-off must not apply suppression.');
      },
      ipPrefixPepper: 'test-pepper',
    });
    const disabledRequest = new Request('https://example.test/api/me/leave', {
      method: 'POST',
      body: new URLSearchParams({ t: token, turnstile_token: 'challenge' }),
    });
    const disabled = await disabledRoute({
      request: disabledRequest,
      clientAddress: '192.0.2.1',
    } as never);
    assert.equal(disabled.status, 503);
    const success = await call(
      new URLSearchParams({ t: token, turnstile_token: 'challenge' }),
    );
    assert.equal(success.status, 200);
    assert.equal(verified, 1);
    assert.equal(worked, 2);
    const suppression = await f.owner.readOne({
      text: 'SELECT 1 FROM suppression WHERE email_normalised = (SELECT email_normalised FROM subscriber WHERE id = $1)',
      values: [id],
    });
    assert.ok(suppression);
    const flags = await f.owner.readOne<{ count: string }>({
      text: 'SELECT COUNT(*)::text AS count FROM fraud_flag WHERE subscriber_id = $1',
      values: [id],
    });
    assert.equal(flags?.count, '1');
    const replay = await call(
      new URLSearchParams({ t: token, turnstile_token: 'another-challenge' }),
    );
    assert.equal(replay.status, 200);
    const audit = await f.owner.readOne<{ count: string }>({
      text: "SELECT COUNT(*)::text AS count FROM audit_log WHERE subject_id = $1::text AND action = 'subscriber.unsubscribed'",
      values: [id],
    });
    assert.equal(audit?.count, '1');
    const subject = await f.owner.readOne<{ status: string }>({
      text: 'SELECT status FROM subscriber WHERE id = $1',
      values: [id],
    });
    assert.equal(subject?.status, 'unsubscribed');
  } finally {
    await f.close();
  }
});

test('E6-06 member leave returns closed errors for rejected challenges, limits and write failures', async () => {
  const request = () =>
    new Request('https://example.test/api/me/leave', {
      method: 'POST',
      body: new URLSearchParams({
        t: 'status-token',
        turnstile_token: 'challenge',
      }),
    });
  const context = () =>
    ({ request: request(), clientAddress: '192.0.2.1' }) as never;
  const rejected = createLeaveRoute({
    verifyTurnstile: async () => 'rejected',
    isEnabled: async () => {
      assert.fail('Challenge rejection must stop work.');
    },
    apply: async () => {
      assert.fail('Challenge rejection must stop work.');
    },
    ipPrefixPepper: 'test-pepper',
  });
  const rejectedResponse = await rejected(context());
  assert.equal(rejectedResponse.status, 400);
  assert.equal((await rejectedResponse.json()).error.code, 'challenge_failed');

  let strict = false;
  const limited = createLeaveRoute({
    verifyTurnstile: async () => 'unavailable',
    isEnabled: async () => true,
    apply: async (input) => {
      strict = input.challengeTimedOut === true;
      return 'rate_limited';
    },
    ipPrefixPepper: 'test-pepper',
  });
  const limitedResponse = await limited(context());
  assert.equal(limitedResponse.status, 429);
  assert.equal((await limitedResponse.json()).error.code, 'rate_limited');
  assert.equal(strict, true);

  const failed = createLeaveRoute({
    verifyTurnstile: async () => 'verified',
    isEnabled: async () => true,
    apply: async () => {
      throw new Error('private database detail');
    },
    ipPrefixPepper: 'test-pepper',
  });
  const failedResponse = await failed(context());
  assert.equal(failedResponse.status, 503);
  const failedBody = await failedResponse.text();
  assert.match(failedBody, /"code":"unavailable"/u);
  assert.doesNotMatch(failedBody, /private database detail/u);
});

test('E6-06 dispatch fails closed if the suppression lookup errors', async () => {
  const f = await fixture();
  try {
    const id = await subscriber(f.owner, false);
    await boundEmail(f.app, id, 'resend', 'status_link');
    let sends = 0;
    const provider: EmailProvider = {
      id: 'resend',
      sendingDomain: 'example.test',
      capabilities: { broadcast: false, contactSync: false, dailyFreeCap: 100 },
      async send() {
        sends += 1;
        return { providerMessageId: 'sent' };
      },
    };
    const renderer: TemplateRenderer = {
      kind: 'transactional',
      async render({ email }) {
        return {
          from: 'sender@example.test',
          to: email,
          subject: 'Test',
          text: 'Body',
        };
      },
    };
    const dispatch = createEmailService(f.app, {
      clock: () => now,
      tokenSecret: secret,
      baseUrl: 'https://example.test',
      providers: new Map([['resend', provider]]),
      renderers: new Map([['status_link', renderer]]),
      isBroadcastEnabled: async () => false,
      operatorTask: async () => undefined,
    });
    await f.owner.execute({
      text: 'REVOKE SELECT (email_normalised, reason, source, created_at) ON suppression FROM valstara_app',
    });
    await assert.rejects(
      dispatch.dispatch(1),
      /permission denied for table suppression/u,
    );
    assert.equal(sends, 0);
  } finally {
    await f.close();
  }
});
