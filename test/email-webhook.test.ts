import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createEmailReconciliationJob } from '../src/server/email/reconcile.ts';
import {
  createEmailService,
  type EmailProvider,
  type TemplateRenderer,
} from '../src/server/email/service.ts';
import {
  createEmailWebhookIngestor,
  parseDeliveryEvent,
} from '../src/server/email/webhook-events.ts';
import { createEmailWebhookReceiver } from '../src/server/email/webhook-receiver.ts';
import type { Alert } from '../src/server/verification-rate/p1-webhook.ts';

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-30T12:00:00.000Z');
const resendSecret = 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=';
const brevoToken = 'local-only-brevo-webhook-token-32-chars';

async function fixture(): Promise<{
  owner: DatabasePool;
  app: DatabasePool;
  close(): Promise<void>;
}> {
  const name = `valstara_e806_${randomUUID().replaceAll('-', '')}`;
  const root = createPool(adminUrl);
  await root.execute({ text: `CREATE DATABASE "${name}"` });
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appPassword,
    release: 'e8-06-test',
  });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    async close() {
      await app.close();
      await owner.close();
      await root.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [name],
        },
        10,
      );
      await root.execute({ text: `DROP DATABASE "${name}"` });
      await root.close();
    },
  };
}

async function subscriber(
  database: DatabasePool,
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await database.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
      marketing_consent_at, marketing_consent_version, marketing_consent_source)
      VALUES ($1, $2, $2, 'example.test', 'verified', $3, 'v1', 'signup')`,
    values: [id, email, now],
  });
  return { id, email };
}

async function sent(
  database: DatabasePool,
  subscriberId: string,
  provider: string,
  messageId: string,
  state = 'sent',
): Promise<string> {
  const id = randomUUID();
  const then = new Date(now.getTime() - 3 * 60 * 60_000);
  await database.execute({
    text: `INSERT INTO email_send (id, subscriber_id, template, provider, business_key,
      provider_message_id, state, created_at, updated_at)
      VALUES ($1, $2, 'verification', $3, $4, $5, $6, $7, $7)`,
    values: [id, subscriberId, provider, `test:${id}`, messageId, state, then],
  });
  return id;
}

function signature(body: string, id: string): Headers {
  const seconds = String(Math.floor(now.getTime() / 1000));
  const key = Buffer.from(resendSecret.slice(6), 'base64url');
  const signed = createHmac('sha256', key)
    .update(`${id}.${seconds}.${body}`)
    .digest('base64');
  return new Headers({
    'svix-id': id,
    'svix-timestamp': seconds,
    'svix-signature': `v1,${signed}`,
  });
}

test('E8-06 authenticates Brevo before body read and Resend before JSON parse', async () => {
  let reads = 0;
  let ingests = 0;
  const alerts: Alert[] = [];
  const receiver = createEmailWebhookReceiver({
    resendSecret,
    brevoToken,
    ingest: async () => {
      ingests += 1;
      return true;
    },
    alerts: {
      send: async (alert) => {
        alerts.push(alert);
      },
    },
    clock: () => now,
    writeFailureLog: () => undefined,
  });
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode('{"event":"spam"}'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const brevoRequest = new Request('https://example.test/api/webhooks/brevo', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  assert.deepEqual(await receiver.handle('brevo', brevoRequest), {
    status: 401,
    code: 'unauthorized',
  });
  assert.equal(reads, 0);
  assert.equal(ingests, 0);

  const missingToken = new Request('https://example.test/api/webhooks/brevo', {
    method: 'POST',
    body: '{',
  });
  assert.deepEqual(await receiver.handle('brevo', missingToken), {
    status: 401,
    code: 'unauthorized',
  });

  const accepted = new Request('https://example.test/api/webhooks/brevo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${brevoToken}` },
    body: JSON.stringify({
      event: 'hard_bounce',
      email: 'recipient@example.test',
      'message-id': 'brevo-accepted',
    }),
  });
  assert.deepEqual(await receiver.handle('brevo', accepted), { status: 200 });
  assert.equal(ingests, 1);

  const invalid = new Request('https://example.test/api/webhooks/resend', {
    method: 'POST',
    headers: signature('{', 'msg_verified'),
    body: '{',
  });
  assert.deepEqual(await receiver.handle('resend', invalid), {
    status: 400,
    code: 'invalid_input',
  });
  assert.equal(ingests, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.severity, 'P1');
  assert.deepEqual(alerts[0]?.detail, { code: 'payload_invalid' });
});

test('E8-06 a signed but unstorable event raises sanitized P1; repeated auth failures raise P2', async () => {
  const alerts: Alert[] = [];
  const receiver = createEmailWebhookReceiver({
    resendSecret,
    brevoToken,
    ingest: async () => {
      throw new Error('private@example.test');
    },
    alerts: {
      send: async (alert) => {
        alerts.push(alert);
      },
    },
    clock: () => now,
    writeFailureLog: () => undefined,
  });
  const body = JSON.stringify({
    type: 'email.complained',
    data: { email_id: 'resend-message', to: ['private@example.test'] },
  });
  const request = new Request('https://example.test/api/webhooks/resend', {
    method: 'POST',
    headers: signature(body, 'msg_event'),
    body,
  });
  assert.deepEqual(await receiver.handle('resend', request), {
    status: 503,
    code: 'unavailable',
  });
  for (let index = 0; index < 3; index += 1) {
    const unauthorized = new Request(
      'https://example.test/api/webhooks/resend',
      { method: 'POST', body: '{}' },
    );
    assert.equal((await receiver.handle('resend', unauthorized)).status, 401);
  }
  assert.deepEqual(
    [...receiver.failureCounts()],
    [
      ['storage_unavailable', 1],
      ['auth_failed', 3],
    ],
  );
  assert.deepEqual(
    alerts.map((alert) => alert.severity),
    ['P1', 'P2'],
  );
  assert.doesNotMatch(JSON.stringify(alerts), /private@example\.test/u);
});

test('E8-06 replay, changed Brevo timestamp, bounce classification and global dispatch suppression', async () => {
  const db = await fixture();
  try {
    const person = await subscriber(db.owner);
    const spamRecipient = await subscriber(db.owner);
    const resendId = await sent(
      db.owner,
      person.id,
      'resend',
      'resend-message',
      'delivered',
    );
    const brevoId = await sent(db.owner, person.id, 'brevo', '<brevo-message>');
    const spamId = await sent(
      db.owner,
      spamRecipient.id,
      'brevo',
      '<brevo-spam>',
    );
    const ingest = createEmailWebhookIngestor(db.app, () => now);
    const soft = parseDeliveryEvent('brevo', {
      event: 'soft_bounce',
      email: person.email,
      'message-id': '<brevo-message>',
    });
    assert.equal(soft, null);
    assert.equal(
      parseDeliveryEvent(
        'resend',
        {
          type: 'email.bounced',
          data: {
            email_id: 'resend-message',
            to: [person.email],
            bounce: { type: 'Transient' },
          },
        },
        'msg_soft',
      ),
      null,
    );
    const hard = parseDeliveryEvent('brevo', {
      event: 'hard_bounce',
      email: person.email,
      'message-id': '<brevo-message>',
      ts_event: 1,
    });
    const replay = parseDeliveryEvent('brevo', {
      event: 'hard_bounce',
      email: person.email,
      'message-id': 'brevo-message',
      ts_event: 999,
    });
    assert.ok(hard && replay);
    assert.equal(hard.key, replay.key);
    assert.equal(await ingest.ingest(hard), true);
    assert.equal(await ingest.ingest(replay), false);
    const complaint = parseDeliveryEvent(
      'resend',
      {
        type: 'email.complained',
        data: { email_id: 'resend-message', to: [person.email] },
      },
      'msg_complaint',
    );
    assert.ok(complaint);
    assert.equal(await ingest.ingest(complaint), true);
    assert.equal(await ingest.ingest(complaint), false);
    const spam = parseDeliveryEvent('brevo', {
      event: 'spam',
      email: spamRecipient.email,
      'message-id': 'brevo-spam',
    });
    assert.ok(spam);
    assert.equal(await ingest.ingest(spam), true);
    const concurrent = parseDeliveryEvent('brevo', {
      event: 'spam',
      email: spamRecipient.email,
      'message-id': 'another-brevo-message',
    });
    assert.ok(concurrent);
    const results = await Promise.all([
      ingest.ingest(concurrent),
      ingest.ingest(concurrent),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    const suppression = await db.owner.readOne<{ reason: string }>({
      text: 'SELECT reason FROM suppression WHERE email_normalised = $1',
      values: [person.email],
    });
    assert.equal(suppression?.reason, 'bounce_hard');
    const rows = await db.owner.list<{ id: string; state: string }>(
      {
        text: 'SELECT id, state FROM email_send WHERE id = ANY($1::uuid[])',
        values: [[resendId, brevoId, spamId]],
      },
      3,
    );
    assert.deepEqual(rows.map((row) => row.state).sort(), [
      'bounced',
      'complained',
      'complained',
    ]);
    const count = await db.owner.readOne<{ count: string }>({
      text: 'SELECT COUNT(*)::text AS count FROM email_webhook_event',
    });
    assert.equal(count?.count, '4');
    const eventColumns = await db.owner.list<{ column_name: string }>(
      {
        text: `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'email_webhook_event' ORDER BY ordinal_position`,
      },
      2,
    );
    assert.deepEqual(
      eventColumns.map((column) => column.column_name),
      ['event_key'],
    );
    assert.equal(
      (
        await db.owner.readOne<{ reason: string }>({
          text: 'SELECT reason FROM suppression WHERE email_normalised = $1',
          values: [spamRecipient.email],
        })
      )?.reason,
      'complaint',
    );

    let sentCount = 0;
    const provider = (id: string): EmailProvider => ({
      id,
      sendingDomain:
        id === 'resend' ? 'send.valstara.com' : 'mail.valstara.com',
      capabilities: {
        broadcast: id === 'brevo',
        contactSync: false,
        dailyFreeCap: 100,
      },
      async send() {
        sentCount += 1;
        return { providerMessageId: randomUUID() };
      },
    });
    const renderer: TemplateRenderer = {
      kind: 'transactional',
      async render({ email }) {
        return {
          from: 'hello@send.valstara.com',
          to: email,
          subject: 'test',
          text: 'test',
        };
      },
    };
    const broadcastRenderer: TemplateRenderer = {
      ...renderer,
      kind: 'broadcast',
    };
    const service = createEmailService(db.app, {
      clock: () => now,
      tokenSecret: 'local-only-email-token-secret-32-chars',
      baseUrl: 'https://example.test',
      providers: new Map([
        ['resend', provider('resend')],
        ['brevo', provider('brevo')],
      ]),
      renderers: new Map([
        ['verification', renderer],
        ['broadcast', broadcastRenderer],
      ]),
      isBroadcastEnabled: async () => true,
      operatorTask: async () => undefined,
    });
    await service.queue({
      subscriberId: person.id,
      template: 'verification',
      provider: 'resend',
      businessKey: `queued:${randomUUID()}`,
      payload: { token_id: randomUUID() },
    });
    await service.queue({
      subscriberId: person.id,
      template: 'broadcast',
      provider: 'brevo',
      businessKey: `queued:${randomUUID()}`,
      payload: { token_id: randomUUID() },
    });
    const summary = await service.dispatch(2);
    assert.equal(summary.suppressed, 2);
    assert.equal(sentCount, 0);
  } finally {
    await db.close();
  }
});

test('E8-06 Brevo provider reconciliation restores a dropped bounce and Resend gap alerts once', async () => {
  const db = await fixture();
  try {
    const person = await subscriber(db.owner);
    const blockedPerson = await subscriber(db.owner);
    const resendId = await sent(db.owner, person.id, 'resend', 'resend-gap');
    const brevoId = await sent(db.owner, person.id, 'brevo', '<brevo-gap>');
    const deliveredId = await sent(
      db.owner,
      person.id,
      'resend',
      'resend-delivered',
      'delivered',
    );
    const alerts: Alert[] = [];
    const provider = {
      async listReconciliationEvents(input: {
        event: 'hardBounces' | 'spam';
        offset: number;
      }) {
        return input.event === 'hardBounces' && input.offset === 0
          ? {
              scanned: 1,
              items: [
                {
                  email: person.email,
                  messageId: '<brevo-gap>',
                  event: 'hard_bounce' as const,
                },
              ],
            }
          : { scanned: 0, items: [] };
      },
      async listBlockedContacts(input: { offset: number }) {
        return input.offset === 0
          ? {
              scanned: 1,
              items: [
                { email: blockedPerson.email, reason: 'complaint' as const },
              ],
            }
          : { scanned: 0, items: [] };
      },
    };
    const job = createEmailReconciliationJob(
      db.app,
      provider,
      {
        send: async (alert) => {
          alerts.push(alert);
        },
      },
      () => now,
      120,
    );
    assert.deepEqual(await job.run(100), {
      resendGaps: 1,
      brevoScanned: 2,
      brevoPaused: false,
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.severity, 'P2');
    assert.deepEqual(alerts[0]?.detail, {
      kind: 'operator_task',
      task: 'replay_resend_webhooks',
      count: 1,
      email_send_ids: resendId,
    });
    assert.equal(
      (
        await db.owner.readOne<{ state: string }>({
          text: 'SELECT state FROM email_send WHERE id = $1',
          values: [brevoId],
        })
      )?.state,
      'bounced',
    );
    assert.equal(
      (
        await db.owner.readOne<{ reason: string }>({
          text: 'SELECT reason FROM suppression WHERE email_normalised = $1',
          values: [person.email],
        })
      )?.reason,
      'bounce_hard',
    );
    assert.equal(
      (
        await db.owner.readOne<{ reason: string }>({
          text: 'SELECT reason FROM suppression WHERE email_normalised = $1',
          values: [blockedPerson.email],
        })
      )?.reason,
      'complaint',
    );
    assert.equal(
      (
        await db.owner.readOne<{ gap_alerted_at: Date | null }>({
          text: 'SELECT gap_alerted_at FROM email_send WHERE id = $1',
          values: [deliveredId],
        })
      )?.gap_alerted_at,
      null,
    );
    assert.equal((await job.run(100)).resendGaps, 0);
    assert.equal(alerts.length, 1);
  } finally {
    await db.close();
  }
});

test('E8-06 reconciliation pauses Brevo reads when unconfigured and does not flag delivered-then-lost-complaint', async () => {
  const db = await fixture();
  try {
    const person = await subscriber(db.owner);
    await sent(db.owner, person.id, 'resend', 'resend-delivered', 'delivered');
    const alerts: Alert[] = [];
    const job = createEmailReconciliationJob(
      db.app,
      null,
      {
        send: async (alert) => {
          alerts.push(alert);
        },
      },
      () => now,
      120,
    );
    assert.deepEqual(await job.run(100), {
      resendGaps: 0,
      brevoScanned: 0,
      brevoPaused: true,
    });
    assert.deepEqual(alerts, []);
  } finally {
    await db.close();
  }
});
