import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrevoProvider } from '../src/server/email/providers/brevo.ts';

test('E8-06 Brevo reconciliation reads bounded transactional events and blocklist', async () => {
  const calls: URL[] = [];
  const provider = createBrevoProvider(
    'local-brevo-key',
    'mail.valstara.com',
    1,
    {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        assert.equal(init?.method, 'GET');
        assert.equal(
          new Headers(init?.headers).get('api-key'),
          'local-brevo-key',
        );
        if (url.pathname.endsWith('/blockedContacts')) {
          return Response.json({
            contacts: [
              {
                email: 'one@example.test',
                senderEmail: 'hello@mail.valstara.com',
                reason: { code: 'hardBounce' },
              },
              {
                email: 'two@example.test',
                senderEmail: 'hello@mail.valstara.com',
                reason: { code: 'contactFlaggedAsSpam' },
              },
              {
                email: 'three@example.test',
                senderEmail: 'hello@mail.valstara.com',
                reason: { code: 'unsubscribed' },
              },
            ],
          });
        }
        return Response.json({
          events: [
            {
              email: 'one@example.test',
              messageId: '<message-one>',
              event: 'hardBounces',
              from: 'Valstara <hello@mail.valstara.com>',
            },
            {
              email: 'other@example.test',
              messageId: '<other>',
              event: 'hardBounces',
              from: 'other@example.test',
            },
          ],
        });
      },
    },
  );
  const events = await provider.listReconciliationEvents({
    event: 'hardBounces',
    startDate: '2026-09-29',
    endDate: '2026-09-30',
    offset: 4,
    limit: 100,
  });
  assert.deepEqual(events, {
    scanned: 2,
    items: [
      {
        email: 'one@example.test',
        messageId: '<message-one>',
        event: 'hard_bounce',
      },
    ],
  });
  const blocked = await provider.listBlockedContacts({
    startDate: '2026-09-29',
    endDate: '2026-09-30',
    offset: 0,
    limit: 100,
  });
  assert.deepEqual(blocked, {
    scanned: 3,
    items: [
      { email: 'one@example.test', reason: 'bounce_hard' },
      { email: 'two@example.test', reason: 'complaint' },
    ],
  });
  assert.equal(calls[0]?.pathname, '/v3/smtp/statistics/events');
  assert.equal(calls[0]?.searchParams.get('event'), 'hardBounces');
  assert.equal(calls[0]?.searchParams.get('offset'), '4');
  assert.equal(calls[0]?.searchParams.get('limit'), '100');
  assert.equal(calls[1]?.pathname, '/v3/smtp/blockedContacts');
});
