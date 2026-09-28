import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { AppConfig } from '../src/server/config.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import {
  checkDomainAuthenticationAtStartup,
  domainAuthenticationHealth,
} from '../src/server/email/domain-authentication.ts';
import { createResendProvider } from '../src/server/email/providers/resend.ts';
import { createTransactionalTemplateData } from '../src/server/email/transactional-template-data.ts';
import {
  createResendDispatcher,
  runResendDispatch,
} from '../src/server/email/resend-dispatch.ts';
import { createVerificationService } from '../src/server/verification/service.ts';

const clock = (): Date => new Date('2026-09-28T12:00:00.000Z');
const sendingDomain = 'send.valstara.com';
const spf = 'v=spf1 ip4:52.3.252.119 ~all';
const dkim = `p=${'A'.repeat(120)}`;
const dmarc = 'v=DMARC1; p=none';
const domainConfiguration = {
  sendingDomain,
  dkimExpectedValue: dkim,
  sendCnameExpectedTarget: 'send.forge.rmta.net',
  rsendCnameExpectedTarget: 'rsend-euw1.forge.rmta.net',
};

function dns(overrides: Record<string, string | null> = {}) {
  const txt = {
    'send.send.valstara.com': spf,
    'resend._domainkey.send.valstara.com': dkim,
    '_dmarc.send.valstara.com': dmarc,
  } as Record<string, string>;
  const cname = {
    'send.send.valstara.com': 'send.forge.rmta.net',
    'rsend.send.valstara.com': 'rsend-euw1.forge.rmta.net',
  } as Record<string, string>;
  const value = (name: string, defaults: Record<string, string>): string => {
    const configured = Object.hasOwn(overrides, name)
      ? overrides[name]
      : defaults[name];
    if (configured === undefined || configured === null) {
      throw new Error('ENODATA');
    }
    return configured;
  };
  return {
    clock,
    configuration: domainConfiguration,
    resolveTxt: async (name: string): Promise<string[][]> => [
      [value(name, txt)],
    ],
    resolveCname: async (name: string): Promise<string[]> => [
      value(name, cname),
    ],
  };
}

test('Resend provider declares transactional capabilities and sends only from its configured domain', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const provider = createResendProvider('secret-test-key', sendingDomain, {
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json({ id: 'provider-id' });
    },
  });
  assert.equal(provider.id, 'resend');
  assert.equal(provider.sendingDomain, sendingDomain);
  assert.deepEqual(provider.capabilities, {
    broadcast: false,
    contactSync: false,
    dailyFreeCap: 100,
  });
  const message = {
    from: 'Valstara <hello@send.valstara.com>',
    to: 'subscriber@example.test',
    subject: 'Verify',
    text: 'Verify your address',
    html: '<p>Verify your address</p>',
  };
  const headers = { 'List-Unsubscribe': '<https://valstara.com/unsubscribe>' };
  assert.deepEqual(
    await provider.send({ message, headers, idempotencyKey: 'verify:1' }),
    { providerMessageId: 'provider-id' },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://api.resend.com/emails');
  assert.equal(
    new Headers(requests[0]?.init.headers).get('Idempotency-Key'),
    'verify:1',
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    ...message,
    to: [message.to],
    headers,
  });
  for (const from of [
    'hello@mail.valstara.com',
    'hello@resend.dev',
    'hello@send.valstara.com.evil.test',
  ]) {
    await assert.rejects(
      provider.send({
        message: { ...message, from },
        headers,
        idempotencyKey: 'verify:2',
      }),
      /resend_sender_domain_invalid/u,
    );
  }
  assert.equal(requests.length, 1);
});

test('Resend provider sanitizes vendor failures without leaking the key or response body', async () => {
  const provider = createResendProvider('secret-test-key', sendingDomain, {
    fetch: async () =>
      Response.json(
        { message: 'secret-test-key private vendor detail' },
        { status: 403 },
      ),
  });
  await assert.rejects(
    provider.send({
      message: {
        from: 'hello@send.valstara.com',
        to: 'subscriber@example.test',
        subject: 'Verify',
        text: 'Verify',
      },
      idempotencyKey: 'verify:1',
      headers: {},
    }),
    (error) => {
      assert.equal((error as Error).message, 'resend_send_rejected');
      return true;
    },
  );
});

test('Resend rejects an invalid idempotency key before a network request', async () => {
  let called = false;
  const provider = createResendProvider('secret-test-key', sendingDomain, {
    fetch: async () => {
      called = true;
      return Response.json({ id: 'unexpected' });
    },
  });
  await assert.rejects(
    provider.send({
      message: {
        from: 'hello@send.valstara.com',
        to: 'subscriber@example.test',
        subject: 'Verify',
        text: 'Verify',
      },
      idempotencyKey: '',
      headers: {},
    }),
    /resend_idempotency_key_invalid/u,
  );
  assert.equal(called, false);
});

test('Resend treats network errors and malformed success responses as sanitized failures', async () => {
  const input = {
    message: {
      from: 'hello@send.valstara.com',
      to: 'subscriber@example.test',
      subject: 'Verify',
      text: 'Verify',
    },
    idempotencyKey: 'verify:network',
    headers: {},
  };
  const unavailable = createResendProvider('secret-test-key', sendingDomain, {
    fetch: async () => {
      throw new Error('private network detail');
    },
  });
  await assert.rejects(unavailable.send(input), /resend_send_unavailable/u);
  const malformed = createResendProvider('secret-test-key', sendingDomain, {
    fetch: async () => Response.json({ message: 'private success body' }),
  });
  await assert.rejects(malformed.send(input), /resend_response_invalid/u);
});

test('an exact configured DNS match passes and reports DMARC policy and check time', async () => {
  const [health] = await domainAuthenticationHealth(dns());
  assert.equal(health?.domain, sendingDomain);
  assert.deepEqual(health?.spf, { passed: true, reason: 'ok' });
  assert.deepEqual(health?.dkim, { passed: true, reason: 'ok' });
  assert.deepEqual(health?.dmarc, {
    passed: true,
    reason: 'ok',
    policy: 'none',
  });
  assert.deepEqual(health?.checkedAt, clock());
});

test('a changed DKIM key fails with its own sanitized code and raises P1 without blocking startup', async () => {
  const alerts: unknown[] = [];
  const logs: string[] = [];
  const health = await checkDomainAuthenticationAtStartup({
    ...dns({ 'resend._domainkey.send.valstara.com': 'p=changed' }),
    alerts: { send: async (alert) => void alerts.push(alert) },
    writeLog: (line) => void logs.push(line),
  });
  assert.deepEqual(health[0]?.dkim, {
    passed: false,
    reason: 'dkim_mismatch',
  });
  assert.equal(alerts.length, 1);
  assert.equal((alerts[0] as { severity: string }).severity, 'P1');
  assert.match(logs[0] ?? '', /dkim_mismatch/u);
  assert.doesNotMatch(JSON.stringify({ alerts, logs }), /p=changed/u);
});

test('a wrong return-path CNAME target fails with its own code', async () => {
  const [health] = await domainAuthenticationHealth(
    dns({ 'send.send.valstara.com': 'wrong.example.test' }),
  );
  assert.deepEqual(health?.spf, {
    passed: false,
    reason: 'send_cname_mismatch',
  });
});

test('a missing DMARC record fails with its own code and no policy', async () => {
  const [health] = await domainAuthenticationHealth(
    dns({ '_dmarc.send.valstara.com': null }),
  );
  assert.deepEqual(health?.dmarc, {
    passed: false,
    reason: 'dmarc_missing',
    policy: null,
  });
});

test('a missing SPF TXT record and wrong rsend CNAME are reported independently', async () => {
  const lookupWithoutSpf = dns();
  const [missingSpf] = await domainAuthenticationHealth({
    ...lookupWithoutSpf,
    resolveTxt: async (name) => {
      if (name === 'send.send.valstara.com') throw new Error('ENODATA');
      return lookupWithoutSpf.resolveTxt(name);
    },
  });
  assert.equal(missingSpf?.spf.reason, 'spf_txt_missing_or_invalid');

  const lookup = dns();
  const [wrongRsend] = await domainAuthenticationHealth({
    ...lookup,
    resolveCname: async (name) =>
      name === 'rsend.send.valstara.com'
        ? ['wrong.example.test']
        : lookup.resolveCname(name),
  });
  assert.equal(wrongRsend?.spf.reason, 'rsend_cname_mismatch');
});

test('a failed P1 webhook does not block startup or leak the transport error', async () => {
  const logs: string[] = [];
  const result = await checkDomainAuthenticationAtStartup({
    ...dns({ '_dmarc.send.valstara.com': null }),
    alerts: {
      send: async () => {
        throw new Error('private alert endpoint detail');
      },
    },
    writeLog: (line) => void logs.push(line),
  });
  assert.equal(result[0]?.dmarc.passed, false);
  assert.match(logs.join(''), /domain_authentication_alert_failed/u);
  assert.doesNotMatch(logs.join(''), /private alert endpoint detail/u);
});

test('registered Resend dispatches once and retries a provider outage through the real database', async () => {
  const databaseName = `valstara_e802_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const owner = createPool(ownerUrl.toString());
  const app = createPool(appUrl.toString());
  const originalFetch = globalThis.fetch;
  const sends: unknown[] = [];
  let rejectSends = false;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), 'https://api.resend.com/emails');
    sends.push(JSON.parse(String(init?.body)));
    return rejectSends
      ? Response.json({ secret: 'private vendor failure' }, { status: 503 })
      : Response.json({ id: 'resend-fixture-id' });
  }) as typeof globalThis.fetch;
  try {
    await runMigrations(owner, {
      applicationRolePassword: appUrl.password,
      release: 'e8-02-test',
    });
    const subscriberId = randomUUID();
    const email = `${subscriberId}@example.test`;
    await app.execute({
      text: `INSERT INTO subscriber
        (id, email, email_normalised, email_domain, status)
        VALUES ($1, $2, $2, 'example.test', 'pending')`,
      values: [subscriberId, email],
    });
    const tokenSecret = 'resend-provider-test-secret-32-characters';
    const verifyToken = await createVerificationService(app, {
      clock,
      tokenSecret,
    }).issue(subscriberId, 'verify');
    const dispatcher = createResendDispatcher(
      app,
      {
        emailTokenSecret: tokenSecret,
        emailBaseUrl: 'https://valstara.test',
        resendApiKey: 'secret-fixture-key',
        resendSendingDomain: 'send.valstara.com',
      } as AppConfig,
      { send: async () => undefined },
      clock,
      new Map([
        [
          'verification_test',
          {
            kind: 'transactional',
            async render({ email: recipient, payload, token }) {
              assert.equal(typeof payload.token_id, 'string');
              const url = new URL('/verify', 'https://valstara.test');
              url.searchParams.set(
                'token',
                await token(String(payload.token_id)),
              );
              return {
                from: 'Valstara <hello@send.valstara.com>',
                to: recipient,
                subject: 'Verify',
                text: url.toString(),
              };
            },
          } as const,
        ],
      ]),
    );
    await dispatcher.queue({
      template: 'verification_test',
      subscriberId,
      provider: 'resend',
      businessKey: `verify:${subscriberId}:${verifyToken.id}`,
      payload: { token_id: verifyToken.id },
    });
    const result = await dispatcher.dispatch(1);
    assert.equal(result.sent, 1);
    assert.equal(sends.length, 1);
    assert.equal((sends[0] as { to: string[] }).to[0], email);
    const status = await owner.readOne<{
      state: string;
      provider_message_id: string;
    }>({
      text: 'SELECT state, provider_message_id FROM email_send WHERE subscriber_id = $1',
      values: [subscriberId],
    });
    assert.equal(status?.state, 'sent');
    assert.equal(status?.provider_message_id, 'resend-fixture-id');
    await dispatcher.dispatch(1);
    assert.equal(sends.length, 1);

    const retryToken = await createVerificationService(app, {
      clock,
      tokenSecret,
    }).issue(subscriberId, 'verify');
    await dispatcher.queue({
      template: 'verification_test',
      subscriberId,
      provider: 'resend',
      businessKey: `verify:${subscriberId}:${retryToken.id}`,
      payload: { token_id: retryToken.id },
    });
    rejectSends = true;
    const outage = await dispatcher.dispatch(1);
    assert.equal(outage.retried, 1);
    const queued = await owner.readOne<{ state: string; attempts: number }>({
      text: 'SELECT state, attempts FROM email_send WHERE business_key = $1',
      values: [`verify:${subscriberId}:${retryToken.id}`],
    });
    assert.deepEqual(queued, { state: 'queued', attempts: 1 });

    // E8-03: the production dispatcher registers the real renderer without
    // a fixture map, and sends its plain-text and HTML alternatives.
    rejectSends = false;
    const realRendererDispatcher = createResendDispatcher(
      app,
      {
        emailTokenSecret: tokenSecret,
        emailBaseUrl: 'https://valstara.test',
        resendApiKey: 'secret-fixture-key',
        resendSendingDomain: 'send.valstara.com',
      } as AppConfig,
      { send: async () => undefined },
      clock,
    );
    const realToken = await createVerificationService(app, {
      clock,
      tokenSecret,
    }).issue(subscriberId, 'verify');
    await realRendererDispatcher.queue({
      template: 'verification_test',
      subscriberId,
      provider: 'resend',
      businessKey: `verify:${subscriberId}:${realToken.id}`,
      payload: { token_id: realToken.id },
    });
    assert.equal((await realRendererDispatcher.dispatch(1)).sent, 1);
    const realSend = sends.at(-1) as {
      subject: string;
      text: string;
      html: string;
      headers: Record<string, string>;
    };
    assert.equal(realSend.subject, 'Verify your Valstara email address');
    assert.match(realSend.text, /\/verify\?token=/u);
    assert.match(realSend.text, /\/unsubscribe\?t=/u);
    assert.match(realSend.html, /\/unsubscribe\?t=/u);
    assert.match(
      realSend.headers['List-Unsubscribe'],
      /\/api\/unsubscribe\?token=/u,
    );
    await owner.execute({
      text: `UPDATE subscriber SET status = 'verified', verified_at = $2,
        referral_code = 'E803REFCODE1' WHERE id = $1`,
      values: [subscriberId, clock()],
    });
    const statusToken = await createVerificationService(app, {
      clock,
      tokenSecret,
    }).issue(subscriberId, 'status');
    const statusData = await createTransactionalTemplateData(
      app,
    ).referralStatus(statusToken.id);
    assert.equal(statusData.subscriberStatus, 'verified');
    assert.match(statusData.referralLink, /ref=E803REFCODE1/u);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    await owner.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [databaseName],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${databaseName}"` });
    await admin.close();
  }
});

test('dispatch-loop failure raises P1 without exposing a provider error', async () => {
  const controller = new AbortController();
  const alerts: unknown[] = [];
  const dispatcher = {
    async dispatch() {
      controller.abort();
      throw new Error('private provider failure with secret-test-key');
    },
  };
  await runResendDispatch(
    dispatcher,
    { send: async (alert) => void alerts.push(alert) },
    clock,
    controller.signal,
  );
  assert.equal(alerts.length, 1);
  assert.equal((alerts[0] as { severity: string }).severity, 'P1');
  assert.doesNotMatch(JSON.stringify(alerts), /private provider failure/u);
});

test('dispatch loop calls the bounded dispatcher and exits on shutdown', async () => {
  const controller = new AbortController();
  const limits: number[] = [];
  await runResendDispatch(
    {
      async dispatch(limit) {
        limits.push(limit);
        controller.abort();
        return {
          scanned: 0,
          sent: 0,
          suppressed: 0,
          unregistered: 0,
          broadcastPaused: 0,
          retried: 0,
          failed: 0,
        };
      },
    },
    { send: async () => assert.fail('no alert expected') },
    clock,
    controller.signal,
  );
  assert.deepEqual(limits, [100]);
});
