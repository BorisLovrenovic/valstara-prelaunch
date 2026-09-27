import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createEmailService,
  type EmailProvider,
  type Message,
  type TemplateRenderer,
  backoffMs,
  maxBackoffMs,
  prepareDispatchMessage,
} from '../src/server/email/service.ts';
import type { QueuedEmailRow } from '../src/server/db/email.ts';
import { createVerificationService } from '../src/server/verification/service.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';

const adminDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const secret = 'email-service-test-secret-32-characters';
const rotated = 'a-different-email-service-secret-32-characters';
const baseUrl = 'https://example.test';
const now = new Date('2026-09-27T12:00:00.000Z');

test('E8-01 refuses a missing text body or bound unsubscribe token before provider send', async () => {
  const row: QueuedEmailRow = {
    id: randomUUID(),
    subscriber_id: randomUUID(),
    template: 'verification',
    provider: 'fixture',
    business_key: 'fixture-key',
    payload: {},
    unsubscribe_token_id: randomUUID(),
    attempts: 0,
  };
  const badRenderer: TemplateRenderer = {
    kind: 'transactional',
    async render() {
      return {
        from: 'sender@example.test',
        to: 'recipient@example.test',
        subject: 'Fixture',
      } as unknown as Message;
    },
  };
  await assert.rejects(
    prepareDispatchMessage({
      row,
      recipient: 'recipient@example.test',
      renderer: badRenderer,
      baseUrl,
      token: async () => 'fixture-token',
    }),
    /text_alternative_missing/u,
  );
  await assert.rejects(
    prepareDispatchMessage({
      row: { ...row, unsubscribe_token_id: null },
      recipient: 'recipient@example.test',
      renderer: badRenderer,
      baseUrl,
      token: async () => 'fixture-token',
    }),
    /unsubscribe_token_missing/u,
  );
});

interface Fixture {
  readonly owner: DatabasePool;
  readonly app: DatabasePool;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const name = `valstara_e801_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(adminDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(databaseUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appPassword,
    release: 'e8-01-test',
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

async function subscriber(
  db: DatabasePool,
  consent = false,
  status: 'pending' | 'verified' = 'verified',
): Promise<string> {
  const id = randomUUID();
  const address = `${id}@example.test`;
  await db.execute({
    text: `INSERT INTO subscriber
    (id, email, email_normalised, email_domain, status,
     marketing_consent_at, marketing_consent_version, marketing_consent_source)
    VALUES ($1, $2, $2, 'example.test', $3, $4, $5, $6)`,
    values: [
      id,
      address,
      status,
      consent ? now : null,
      consent ? 'fixture-v1' : null,
      consent ? 'signup' : null,
    ],
  });
  return id;
}

function harness(
  db: DatabasePool,
  options: {
    secret?: string;
    broadcastEnabled?: boolean;
    providerFails?: boolean;
    registered?: boolean;
    text?: string;
  } = {},
) {
  const sent: {
    message: Message;
    headers: Readonly<Record<string, string>>;
    idempotencyKey: string;
  }[] = [];
  const attempted: typeof sent = [];
  const tasks: string[] = [];
  const provider: EmailProvider = {
    id: 'fixture',
    sendingDomain: 'example.test',
    capabilities: { broadcast: false, contactSync: false, dailyFreeCap: 100 },
    async send(input) {
      attempted.push(input);
      if (options.providerFails) throw new Error('secret vendor body');
      sent.push(input);
      return { providerMessageId: `fixture-${input.idempotencyKey}` };
    },
  };
  const renderer = (kind: 'transactional' | 'broadcast'): TemplateRenderer => ({
    kind,
    async render({ email, payload, token }) {
      const id = payload.token_id;
      assert.ok(typeof id === 'string');
      const url = new URL('/verify', baseUrl);
      url.searchParams.set('token', await token(id));
      return {
        from: 'sender@example.test',
        to: email,
        subject: 'Fixture',
        text: options.text ?? url.toString(),
      };
    },
  });
  const service = createEmailService(db, {
    clock: () => now,
    tokenSecret: options.secret ?? secret,
    baseUrl,
    providers:
      options.registered === false
        ? new Map()
        : new Map([['fixture', provider]]),
    renderers:
      options.registered === false
        ? new Map()
        : new Map([
            ['verification', renderer('transactional')],
            ['broadcast', renderer('broadcast')],
          ]),
    isBroadcastEnabled: async () => options.broadcastEnabled ?? true,
    operatorTask: async ({ code }) => {
      tasks.push(code);
    },
  });
  return { service, sent, attempted, tasks };
}

async function queueWithToken(
  db: DatabasePool,
  service: ReturnType<typeof createEmailService>,
  subscriberId: string,
  key: string,
  template = 'verification',
) {
  const issued = await createVerificationService(db, {
    clock: () => now,
    tokenSecret: secret,
  }).issue(subscriberId, 'verify');
  const queued = await service.queue({
    template,
    provider: 'fixture',
    subscriberId,
    businessKey: key,
    payload: { token_id: issued.id },
  });
  return { issued, queued };
}

test('E8-01 duplicate business keys queue one row under genuine database concurrency', async () => {
  const f = await fixture();
  try {
    const person = await subscriber(f.owner);
    const { service } = harness(f.app);
    const issued = await createVerificationService(f.app, {
      clock: () => now,
      tokenSecret: secret,
    }).issue(person, 'verify');
    const input = {
      template: 'verification',
      provider: 'fixture',
      subscriberId: person,
      businessKey: `verify:${person}`,
      payload: { token_id: issued.id },
    };
    const results = await Promise.all([
      service.queue(input),
      service.queue(input),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    const row = await f.owner.readOne<{ sends: string; tokens: string }>({
      text: `SELECT (SELECT COUNT(*)::text FROM email_send) AS sends,
        (SELECT COUNT(*)::text FROM verification_token WHERE purpose = 'unsubscribe') AS tokens`,
    });
    assert.equal(row?.sends, '1');
    assert.equal(row?.tokens, '1');
  } finally {
    await f.close();
  }
});

test('E8-01 dispatch rechecks suppression, verification and broadcast consent after queueing', async () => {
  const f = await fixture();
  try {
    const suppressed = await subscriber(f.owner, true);
    const withdrawn = await subscriber(f.owner, true);
    const pending = await subscriber(f.owner, true, 'pending');
    const h = harness(f.app);
    await queueWithToken(f.app, h.service, suppressed, 'suppressed');
    await queueWithToken(f.app, h.service, withdrawn, 'withdrawn', 'broadcast');
    await queueWithToken(f.app, h.service, withdrawn, 'transactional');
    await queueWithToken(
      f.app,
      h.service,
      pending,
      'pending-broadcast',
      'broadcast',
    );
    await f.owner.execute({
      text: `INSERT INTO suppression
      (email_normalised, reason, source) SELECT email_normalised, 'manual', 'test'
      FROM subscriber WHERE id = $1`,
      values: [suppressed],
    });
    await f.owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at = NULL,
      marketing_consent_version = NULL, marketing_consent_source = NULL WHERE id = $1`,
      values: [withdrawn],
    });
    const summary = await h.service.dispatch(10);
    assert.equal(summary.sent, 1);
    assert.equal(summary.suppressed, 3);
    assert.deepEqual(
      h.sent.map((item) => item.idempotencyKey),
      ['transactional'],
    );
  } finally {
    await f.close();
  }
});

test('E8-01 retry reproduces tokens and URLs; outage preserves queued row and bounds backoff', async () => {
  const f = await fixture();
  try {
    const person = await subscriber(f.owner);
    const failing = harness(f.app, { providerFails: true });
    const { issued } = await queueWithToken(
      f.app,
      failing.service,
      person,
      'retry',
    );
    assert.equal((await failing.service.dispatch(1)).retried, 1);
    const row = await f.owner.readOne<{
      state: string;
      attempts: number;
      next_attempt_at: Date;
      unsubscribe_token_id: string;
      payload: { token_id: string };
    }>({
      text: 'SELECT state, attempts, next_attempt_at, unsubscribe_token_id, payload FROM email_send WHERE business_key = $1',
      values: ['retry'],
    });
    assert.equal(row?.state, 'queued');
    assert.equal(row?.attempts, 1);
    assert.equal(
      row?.next_attempt_at.toISOString(),
      new Date(now.getTime() + backoffMs(1)).toISOString(),
    );
    assert.equal(row?.payload.token_id, issued.id);
    const recovered = harness(f.app);
    await f.owner.execute({
      text: 'UPDATE email_send SET next_attempt_at = $1 WHERE business_key = $2',
      values: [now, 'retry'],
    });
    assert.equal((await recovered.service.dispatch(1)).sent, 1);
    assert.deepEqual(recovered.attempted[0], failing.attempted[0]);
    const verificationUrl = new URL(recovered.sent[0]?.message.text);
    assert.equal(verificationUrl.searchParams.get('token'), issued.token);
    const unsubscribe = deriveEmailToken(row!.unsubscribe_token_id, secret);
    assert.equal(
      recovered.sent[0]?.headers['List-Unsubscribe'],
      `<${baseUrl}/api/unsubscribe?token=${encodeURIComponent(unsubscribe)}>`,
    );
    assert.equal(
      recovered.sent[0]?.headers['List-Unsubscribe-Post'],
      'List-Unsubscribe=One-Click',
    );
    assert.ok(backoffMs(30) <= maxBackoffMs);
  } finally {
    await f.close();
  }
});

test('E8-01 bound unsubscribe token resolves its template and stores only a hash', async () => {
  const f = await fixture();
  try {
    const person = await subscriber(f.owner);
    const h = harness(f.app);
    const { issued } = await queueWithToken(
      f.app,
      h.service,
      person,
      'binding',
    );
    const row = await f.owner.readOne<{
      template: string;
      payload: unknown;
      id: string;
      token_hash: Buffer;
      purpose: string;
    }>({
      text: `SELECT e.template, e.payload, t.id, t.token_hash, t.purpose
        FROM email_send e JOIN verification_token t
          ON t.id = e.unsubscribe_token_id WHERE e.business_key = 'binding'`,
    });
    assert.equal(row?.template, 'verification');
    assert.equal(row?.purpose, 'unsubscribe');
    const token = deriveEmailToken(row!.id, secret);
    assert.deepEqual(
      row?.token_hash,
      createHash('sha256').update(token).digest(),
    );
    assert.ok(!JSON.stringify(row?.payload).includes(token));
    assert.ok(!JSON.stringify(row).includes(token));
    await assert.rejects(
      f.owner.execute({
        text: `INSERT INTO email_send
          (id, subscriber_id, template, provider, business_key, payload,
           unsubscribe_token_id, state)
          VALUES ($1, $2, 'verification', 'fixture', 'wrong-purpose',
            $3::jsonb, $4, 'failed')`,
        values: [
          randomUUID(),
          person,
          JSON.stringify({ token_id: issued.id }),
          issued.id,
        ],
      }),
      /unsubscribe-purpose/u,
    );
    await assert.rejects(
      f.owner.execute({
        text: `INSERT INTO email_send
      (id, subscriber_id, template, provider, business_key, payload, state)
      VALUES ($1, $2, 'verification', 'fixture', 'bad-payload', $3::jsonb, 'failed')`,
        values: [
          randomUUID(),
          person,
          JSON.stringify({ email: 'private@example.test' }),
        ],
      }),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23514',
    );
  } finally {
    await f.close();
  }
});

test('E8-01 rotated secret rejects old tokens and does not send invalid links', async () => {
  const f = await fixture();
  try {
    const person = await subscriber(f.owner);
    const original = harness(f.app);
    const { issued } = await queueWithToken(
      f.app,
      original.service,
      person,
      'rotated',
    );
    const other = harness(f.app, { secret: rotated });
    const consumed = await createVerificationService(f.app, {
      clock: () => now,
      tokenSecret: rotated,
    }).consume(issued.token, 'verify');
    assert.equal(consumed, 'invalid');
    assert.equal((await other.service.dispatch(1)).failed, 1);
    assert.deepEqual(other.tasks, ['token_secret_rotated']);
    assert.equal(other.sent.length, 0);
  } finally {
    await f.close();
  }
});

test('E8-01 unregistered entries and disabled broadcast remain queued without attempts', async () => {
  const f = await fixture();
  try {
    const person = await subscriber(f.owner, true);
    const unregistered = harness(f.app, { registered: false });
    await queueWithToken(
      f.app,
      unregistered.service,
      person,
      'unregistered',
      'unknown_template',
    );
    const issued = await createVerificationService(f.app, {
      clock: () => now,
      tokenSecret: secret,
    }).issue(person, 'verify');
    await unregistered.service.queue({
      template: 'verification',
      provider: 'missing',
      subscriberId: person,
      businessKey: 'missing-provider',
      payload: { token_id: issued.id },
    });
    assert.equal((await unregistered.service.health()).unregisteredQueued, 2);
    assert.equal((await unregistered.service.dispatch(2)).unregistered, 2);
    const registered = harness(f.app, { broadcastEnabled: false });
    await queueWithToken(
      f.app,
      registered.service,
      person,
      'flag-off',
      'broadcast',
    );
    await queueWithToken(f.app, registered.service, person, 'ready');
    assert.equal(
      (await registered.service.dispatch(1)).sent,
      1,
      'ready mail must progress ahead of older unregistered and paused rows',
    );
    const blocked = await registered.service.dispatch(3);
    assert.equal(blocked.unregistered, 2);
    assert.equal(blocked.broadcastPaused, 1);
    const rows = await f.owner.list<{ attempts: number; state: string }>(
      {
        text: "SELECT attempts, state FROM email_send WHERE business_key <> 'ready' ORDER BY business_key",
      },
      3,
    );
    assert.ok(
      rows.every((row) => row.attempts === 0 && row.state === 'queued'),
    );
  } finally {
    await f.close();
  }
});

test('E8-01 dispatcher caps batches and raises an operator task on permanent failure', async () => {
  const f = await fixture();
  try {
    const person = await subscriber(f.owner);
    const h = harness(f.app, { providerFails: true });
    await queueWithToken(f.app, h.service, person, 'one');
    await queueWithToken(f.app, h.service, person, 'two');
    assert.equal((await h.service.dispatch(1)).scanned, 1);
    await f.owner.execute({
      text: `UPDATE email_send SET attempts = 4, next_attempt_at = NULL
      WHERE business_key = 'two'`,
    });
    assert.equal((await h.service.dispatch(2)).failed, 1);
    assert.deepEqual(h.tasks, ['provider_unavailable']);
    await assert.rejects(h.service.dispatch(101), RangeError);
  } finally {
    await f.close();
  }
});
