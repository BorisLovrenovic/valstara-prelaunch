import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrevoProvider } from '../src/server/email/providers/brevo.ts';

const message = {
  from: 'Valstara <hello@mail.valstara.com>',
  to: 'person@example.test',
  subject: 'Weekly update',
  text: 'Plain text update',
  html: '<p>HTML update</p>',
};
const headers = {
  'List-Unsubscribe': '<https://valstara.com/unsubscribe?t=bound>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};

test('Brevo declares broadcast capabilities and sends both bodies and bound headers', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = createBrevoProvider('test-secret', 'mail.valstara.com', 42, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ messageId: 'brevo-message-id' }, { status: 201 });
    },
  });
  assert.equal(provider.id, 'brevo');
  assert.equal(provider.sendingDomain, 'mail.valstara.com');
  assert.deepEqual(provider.capabilities, {
    broadcast: true,
    contactSync: true,
    dailyFreeCap: 300,
  });
  assert.deepEqual(
    await provider.send({ message, idempotencyKey: 'weekly:1', headers }),
    { providerMessageId: 'brevo-message-id' },
  );
  assert.equal(calls[0]?.url, 'https://api.brevo.com/v3/smtp/email');
  const payload = JSON.parse(String(calls[0]?.init.body));
  assert.equal(payload.htmlContent, message.html);
  assert.equal(payload.textContent, message.text);
  assert.equal(
    payload.headers['List-Unsubscribe'],
    headers['List-Unsubscribe'],
  );
  assert.equal(
    payload.headers['List-Unsubscribe-Post'],
    headers['List-Unsubscribe-Post'],
  );
  assert.match(
    payload.headers.idempotencyKey,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  assert.equal(
    new Headers(calls[0]?.init.headers).get('api-key'),
    'test-secret',
  );
  await provider.send({ message, idempotencyKey: 'weekly:1', headers });
  assert.equal(
    JSON.parse(String(calls[1]?.init.body)).headers.idempotencyKey,
    payload.headers.idempotencyKey,
  );
});

test('Brevo rejects a wrong sender or missing body before any request', async () => {
  let calls = 0;
  const provider = createBrevoProvider('test-secret', 'mail.valstara.com', 42, {
    fetch: async () => {
      calls += 1;
      return Response.json({ messageId: 'unexpected' });
    },
  });
  for (const from of [
    'hello@send.valstara.com',
    'hello@mail.valstara.com.evil.test',
  ]) {
    await assert.rejects(
      provider.send({
        message: { ...message, from },
        idempotencyKey: 'weekly:1',
        headers,
      }),
      /brevo_sender_domain_invalid/u,
    );
  }
  await assert.rejects(
    provider.send({
      message: { ...message, html: undefined },
      idempotencyKey: 'weekly:1',
      headers,
    }),
    /brevo_body_missing/u,
  );
  assert.equal(calls, 0);
});

test('Brevo contact operations use normalised external ID and configured list', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = createBrevoProvider('test-secret', 'mail.valstara.com', 42, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    },
  });
  await provider.upsertContact('username@gmail.com', 'User.Name+tag@gmail.com');
  await provider.removeContact('username@gmail.com');
  assert.equal(calls[0]?.url, 'https://api.brevo.com/v3/contacts');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    ext_id: 'username@gmail.com',
    email: 'User.Name+tag@gmail.com',
    listIds: [42],
    updateEnabled: true,
  });
  assert.equal(
    calls[1]?.url,
    'https://api.brevo.com/v3/contacts/username%40gmail.com?identifierType=ext_id',
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    unlinkListIds: [42],
  });
});

test('Brevo failures expose only fixed codes, never vendor bodies or the API key', async () => {
  const provider = createBrevoProvider('test-secret', 'mail.valstara.com', 42, {
    fetch: async () =>
      Response.json({ detail: 'test-secret private address' }, { status: 503 }),
  });
  await assert.rejects(
    provider.send({ message, idempotencyKey: 'weekly:1', headers }),
    (error) => {
      assert.equal((error as Error).message, 'brevo_send_rejected');
      return true;
    },
  );
  await assert.rejects(
    provider.upsertContact('person@example.test', 'person@example.test'),
    /brevo_contact_upsert_rejected/u,
  );
});

test('Brevo duplicate idempotency response counts as the earlier accepted send', async () => {
  const provider = createBrevoProvider('test-secret', 'mail.valstara.com', 42, {
    fetch: async () =>
      Response.json({ code: 'duplicate_parameter' }, { status: 400 }),
  });
  const result = await provider.send({
    message,
    idempotencyKey: 'weekly:1',
    headers,
  });
  assert.match(result.providerMessageId, /^brevo-duplicate:[a-f0-9-]+$/u);
});
