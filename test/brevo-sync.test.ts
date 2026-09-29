import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createBrevoContactSyncJob, runBrevoContactSync } from '../src/server/email/brevo-sync.ts';
import { createEmailService } from '../src/server/email/service.ts';
import { createBrevoProvider } from '../src/server/email/providers/brevo.ts';
import { createResendProvider } from '../src/server/email/providers/resend.ts';
import { createVerificationService } from '../src/server/verification/service.ts';

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const now = new Date('2026-09-29T12:00:00.000Z');

async function fixture(): Promise<{
  owner: DatabasePool;
  app: DatabasePool;
  close(): Promise<void>;
}> {
  const name = `valstara_e805_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e8-05-test',
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

async function addSubscriber(
  db: DatabasePool,
  key: string,
  options: {
    status?: string;
    consent?: boolean;
    suppressed?: boolean;
    raw?: string;
  } = {},
) {
  await db.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
      marketing_consent_at, marketing_consent_version, marketing_consent_source)
      VALUES ($1, $2, $3, 'example.test', $4, $5, $6, $7)`,
    values: [
      randomUUID(),
      options.raw ?? key,
      key,
      options.status ?? 'verified',
      options.consent === false ? null : now,
      options.consent === false ? null : 'v1',
      options.consent === false ? null : 'signup',
    ],
  });
  if (options.suppressed)
    await db.execute({
      text: `INSERT INTO suppression (email_normalised, reason, source)
      VALUES ($1, 'manual', 'test')`,
      values: [key],
    });
}

test('Brevo sync is capped, idempotent, resumable and removes withdrawn contacts', async () => {
  const f = await fixture();
  try {
    await addSubscriber(f.owner, 'a@example.test');
    await addSubscriber(f.owner, 'b@example.test');
    await addSubscriber(f.owner, 'c@example.test');
    await addSubscriber(f.owner, 'pending@example.test', { status: 'pending' });
    await addSubscriber(f.owner, 'unticked@example.test', { consent: false });
    await addSubscriber(f.owner, 'suppressed@example.test', {
      suppressed: true,
    });
    const calls: string[] = [];
    let failOnB = true;
    let enabled = true;
    const job = createBrevoContactSyncJob(
      f.app,
      { isEnabled: async () => enabled },
      {
        async upsertContact(key) {
          calls.push(`add:${key}`);
          if (key === 'b@example.test' && failOnB) {
            failOnB = false;
            throw new Error('provider down');
          }
        },
        async removeContact(key) {
          calls.push(`remove:${key}`);
        },
      },
      () => now,
    );
    assert.deepEqual(await job.run(1), { synced: 1, paused: false });
    assert.deepEqual(calls, ['add:a@example.test']);
    await assert.rejects(job.run(2), /provider down/u);
    assert.deepEqual(calls, ['add:a@example.test', 'add:b@example.test']);
    assert.deepEqual(await job.run(2), { synced: 2, paused: false });
    assert.deepEqual(calls, [
      'add:a@example.test',
      'add:b@example.test',
      'add:b@example.test',
      'add:c@example.test',
    ]);
    assert.deepEqual(await job.run(100), { synced: 0, paused: false });

    await f.owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at = NULL,
      marketing_consent_version = NULL, marketing_consent_source = NULL
      WHERE email_normalised = 'a@example.test'`,
    });
    await f.owner.execute({
      text: `INSERT INTO suppression (email_normalised, reason, source)
      VALUES ('b@example.test', 'manual', 'test')`,
    });
    await f.owner.execute({
      text: `UPDATE subscriber SET status = 'unsubscribed'
      WHERE email_normalised = 'c@example.test'`,
    });
    assert.deepEqual(await job.run(100), { synced: 3, paused: false });
    assert.deepEqual(calls.slice(-3), [
      'remove:a@example.test',
      'remove:b@example.test',
      'remove:c@example.test',
    ]);
    assert.deepEqual(await job.run(100), { synced: 0, paused: false });
    const listed = await f.app.list<{
      email_normalised: string;
      listed: boolean;
    }>(
      {
        text: 'SELECT email_normalised, listed FROM brevo_contact_sync ORDER BY email_normalised',
      },
      10,
    );
    assert.deepEqual(
      listed.map((row) => [row.email_normalised, row.listed]),
      [
        ['a@example.test', false],
        ['b@example.test', false],
        ['c@example.test', false],
      ],
    );

    enabled = false;
    await f.owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at = $1,
      marketing_consent_version = 'v1', marketing_consent_source = 'member_status'
      WHERE email_normalised = 'a@example.test'`,
      values: [now],
    });
    assert.deepEqual(await job.run(100), { synced: 0, paused: true });
    assert.equal(calls.length, 7);
  } finally {
    await f.close();
  }
});

test('email.broadcast pauses Brevo sends while Resend transactional sends continue', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await f.owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
        status, marketing_consent_at, marketing_consent_version, marketing_consent_source)
        VALUES ($1, $2, $2, 'example.test', 'verified', $3, 'v1', 'signup')`,
      values: [id, email, now],
    });
    const sent: string[] = [];
    const resend = createResendProvider(
      'test-resend-key',
      'send.valstara.com',
      {
        fetch: async () => {
          sent.push('resend');
          return Response.json({ id: 'resend-id' });
        },
      },
    );
    const brevo = createBrevoProvider(
      'test-brevo-key',
      'mail.valstara.com',
      42,
      {
        fetch: async () => {
          sent.push('brevo');
          return Response.json({ messageId: 'brevo-id' });
        },
      },
    );
    let enabled = false;
    const secret = 'e8-05-fixture-token-secret-32-characters';
    const service = createEmailService(f.app, {
      clock: () => now,
      tokenSecret: secret,
      baseUrl: 'https://valstara.com',
      providers: new Map([
        ['resend', resend],
        ['brevo', brevo],
      ]),
      renderers: new Map([
        [
          'transactional',
          {
            kind: 'transactional' as const,
            async render({ email: recipient }: { email: string }) {
              return {
                from: 'hello@send.valstara.com',
                to: recipient,
                subject: 'Transactional',
                text: 'Transactional body',
                html: '<p>Transactional body</p>',
              };
            },
          },
        ],
        [
          'broadcast',
          {
            kind: 'broadcast' as const,
            async render({ email: recipient }: { email: string }) {
              return {
                from: 'hello@mail.valstara.com',
                to: recipient,
                subject: 'Broadcast',
                text: 'Broadcast body',
                html: '<p>Broadcast body</p>',
              };
            },
          },
        ],
      ]),
      isBroadcastEnabled: async () => enabled,
      operatorTask: async () => assert.fail('no task expected'),
    });
    const token = await createVerificationService(f.app, {
      clock: () => now,
      tokenSecret: secret,
    }).issue(id, 'status');
    for (const [template, provider] of [
      ['transactional', 'resend'],
      ['broadcast', 'brevo'],
    ] as const) {
      await service.queue({
        template,
        subscriberId: id,
        provider,
        businessKey: `e805:${template}:${id}`,
        payload: { token_id: token.id },
      });
    }
    const off = await service.dispatch(2);
    assert.equal(off.sent, 1);
    assert.equal(off.broadcastPaused, 1);
    assert.deepEqual(sent, ['resend']);
    enabled = true;
    const on = await service.dispatch(2);
    assert.equal(on.sent, 1);
    assert.deepEqual(sent, ['resend', 'brevo']);
  } finally {
    await f.close();
  }
});

test('a Brevo sync outage raises a sanitized P2 and does not stop the loop', async () => {
  const alerts: unknown[] = [];
  const controller = new AbortController();
  await runBrevoContactSync(
    { async run() { throw new Error('private provider body'); } },
    { send: async (alert) => { alerts.push(alert); } },
    () => now,
    controller.signal,
    async (delay) => {
      assert.equal(delay, 60_000);
      controller.abort();
    },
  );
  assert.deepEqual(alerts, [{
    event: 'brevo_contact_sync_failed',
    detail: { code: 'contact_sync_unavailable' },
    occurredAt: now,
    severity: 'P2',
  }]);
  assert.doesNotMatch(JSON.stringify(alerts), /private provider body/u);
});
