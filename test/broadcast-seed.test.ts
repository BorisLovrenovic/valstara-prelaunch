import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import {
  createBroadcastSeedSender,
  createBroadcastSeedTest,
  inspectBroadcastSeed,
} from '../src/server/email/broadcast-seed.ts';
import type { EmailProvider } from '../src/server/email/service.ts';

const marker = 'b8ac7bb9-67b8-4b59-92dc-8d9220628d60';
const link = 'https://valstara.com/';

function delivered(html: string, plain?: string): Buffer {
  const parts =
    plain === undefined
      ? `Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`
      : `Content-Type: multipart/alternative; boundary="seed"\r\n\r\n` +
        `--seed\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n` +
        `--seed\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--seed--\r\n`;
  return Buffer.from(
    `From: hello@mail.valstara.com\r\nTo: seed@example.test\r\n` +
      `Subject: Valstara delivery seed ${marker}\r\nMIME-Version: 1.0\r\n${parts}`,
  );
}

test('delivered Brevo probe requires a MIME plain-text part and detects pixel and link rewriting', async () => {
  const html = `<p>Valstara broadcast seed ${marker}.</p><a href="${link}">Valstara</a>`;
  const plain = `Valstara broadcast seed ${marker}. Link: ${link}`;
  assert.equal(
    await inspectBroadcastSeed(delivered(html, plain), marker, link),
    'passed',
  );
  assert.equal(
    await inspectBroadcastSeed(delivered(html), marker, link),
    'missing_plain_part',
  );
  assert.equal(
    await inspectBroadcastSeed(
      delivered(
        `${html}<img width="1" height="1" src="https://tracking.brevo.example/pixel">`,
        plain,
      ),
      marker,
      link,
    ),
    'tracking_pixel',
  );
  assert.equal(
    await inspectBroadcastSeed(
      delivered(
        html.replace(link, 'https://tracking.brevo.example/click'),
        plain,
      ),
      marker,
      link,
    ),
    'rewritten_link',
  );
  assert.equal(
    await inspectBroadcastSeed(
      delivered(
        html,
        plain.replace(link, 'https://tracking.brevo.example/click'),
      ),
      marker,
      link,
    ),
    'rewritten_link',
  );
});

test('Brevo seed sender supplies both bodies and a first-party probe link', async () => {
  const sent: unknown[] = [];
  const provider: EmailProvider = {
    id: 'brevo',
    sendingDomain: 'mail.valstara.com',
    capabilities: { broadcast: true, contactSync: true, dailyFreeCap: 300 },
    async send(input) {
      sent.push(input);
      return { providerMessageId: 'seed-id' };
    },
  };
  const addresses = {
    gmail: 'seed@gmail.com',
    outlook: 'seed@outlook.com',
    gmx: 'seed@gmx.com',
    web_de: 'seed@web.de',
  };
  const sender = createBroadcastSeedSender(provider, addresses, link);
  await sender.send('gmail', marker, 'seed-week-gmail');
  const input = sent[0] as {
    message: { text: string; html: string; to: string };
  };
  assert.equal(input.message.to, addresses.gmail);
  assert.match(input.message.text, /https:\/\/valstara.com\//u);
  assert.match(input.message.html, /href="https:\/\/valstara.com\/"/u);
  assert.doesNotMatch(input.message.html, /<img\b/iu);
});

test('weekly broadcast seed check records findings and alerts once', async () => {
  const adminUrl =
    process.env.TEST_DATABASE_URL ??
    'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
  const name = `valstara_bseed_${randomUUID().replaceAll('-', '')}`;
  const root = createPool(adminUrl);
  await root.execute({ text: `CREATE DATABASE "${name}"` });
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${name}`;
  const owner = createPool(dbUrl.toString());
  const appUrl = new URL(dbUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  await runMigrations(owner, {
    applicationRolePassword: appUrl.password,
    release: 'e8-05-seed-test',
  });
  const app = createPool(appUrl.toString());
  try {
    let now = new Date('2026-09-29T12:00:00.000Z');
    let hasSource = false;
    const sent: string[] = [];
    const alerts: unknown[] = [];
    const sender: ReturnType<typeof createBroadcastSeedSender> = {
      expectedUrl: link,
      async send(provider: string) {
        sent.push(provider);
      },
    };
    const service = createBroadcastSeedTest(
      app,
      sender,
      {
        source: async (_provider, currentMarker) =>
          hasSource
            ? delivered(
                `<a href="${link}">Valstara</a>`,
                `Valstara broadcast seed ${currentMarker}. Link: ${link}`,
              )
            : null,
      },
      {
        send: async (alert) => {
          alerts.push(alert);
        },
      },
      () => now,
    );
    await service.run();
    assert.equal(sent.length, 4);
    now = new Date('2026-09-29T14:01:00.000Z');
    await service.run();
    assert.equal(alerts.length, 4);
    assert.ok(
      alerts.every(
        (alert) => (alert as { severity: string }).severity === 'P1',
      ),
    );
    hasSource = true;
    await service.run();
    assert.equal(sent.length, 4);
    const states = await app.list<{ state: string }>(
      {
        text: 'SELECT state FROM email_broadcast_seed_test ORDER BY provider',
      },
      4,
    );
    assert.deepEqual(
      states.map((row) => row.state),
      ['passed', 'passed', 'passed', 'passed'],
    );
  } finally {
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
  }
});
