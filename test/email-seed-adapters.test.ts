import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSeedTestConfiguration,
  type SeedTestConfiguration,
} from '../src/server/config.ts';
import {
  createImapSeedMailbox,
  createResendSeedSender,
} from '../src/server/email/seed-adapters.ts';
import type { EmailProvider } from '../src/server/email/service.ts';

const mailbox = (address: string, host: string) => ({
  address,
  host,
  inboxPath: 'INBOX',
  spamPath: 'Junk',
  username: address,
  password: 'test-only-secret',
});

const configuration: SeedTestConfiguration = {
  gmail: mailbox('seed@gmail.com', 'imap.gmail.com'),
  gmx: mailbox('seed@gmx.com', 'imap.gmx.net'),
  web_de: mailbox('seed@web.de', 'imap.web.de'),
  outlook: {
    address: 'seed@outlook.com',
    host: 'outlook.office365.com',
    inboxPath: 'INBOX',
    spamPath: 'Junk',
    username: 'seed@outlook.com',
    oauth: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'first-refresh-token',
      rotationUrl: 'https://secrets.example.test/rotate',
      rotationToken: 'test-rotation-token',
    },
  },
};

test('seed configuration is absent before P7, rejects local credentials and requires all four mailboxes', () => {
  assert.equal(getSeedTestConfiguration({ NODE_ENV: 'production' }), null);
  assert.throws(
    () =>
      getSeedTestConfiguration({
        NODE_ENV: 'development',
        SEED_TEST_CONFIG_PATH: '/run/seed-secrets/config.json',
      }),
    /requires production/u,
  );
  assert.throws(
    () =>
      getSeedTestConfiguration(
        {
          NODE_ENV: 'production',
          SEED_TEST_CONFIG_PATH: '/run/seed-secrets/config.json',
        },
        () => JSON.stringify({ gmail: configuration.gmail }),
      ),
    /four mailbox objects/u,
  );
  assert.deepEqual(
    getSeedTestConfiguration(
      {
        NODE_ENV: 'production',
        SEED_TEST_CONFIG_PATH: '/run/seed-secrets/config.json',
      },
      () => JSON.stringify(configuration),
    ),
    configuration,
  );
  assert.throws(
    () =>
      getSeedTestConfiguration(
        {
          NODE_ENV: 'production',
          SEED_TEST_CONFIG_PATH: '/run/seed-secrets/config.json',
        },
        () =>
          JSON.stringify({
            ...configuration,
            gmail: {
              ...configuration.gmail,
              address: 'seed@web.de',
              username: 'seed@web.de',
            },
          }),
      ),
    /mismatched provider mailbox/u,
  );
  assert.throws(
    () =>
      getSeedTestConfiguration(
        {
          NODE_ENV: 'production',
          SEED_TEST_CONFIG_PATH: '/run/seed-secrets/missing.json',
        },
        () => {
          throw new Error('missing');
        },
      ),
    /readable secret file/u,
  );
});

test('seed startup rejects malformed or misdirected mailbox secrets', () => {
  const environment = {
    NODE_ENV: 'production',
    SEED_TEST_CONFIG_PATH: '/run/seed-secrets/config.json',
  };
  const invalidCases: readonly [string, string, RegExp][] = [
    ['malformed JSON', '{', /valid JSON/u],
    ['array instead of object', '[]', /four mailbox objects/u],
    [
      'missing mailbox object',
      JSON.stringify({ ...configuration, gmx: null }),
      /invalid mailbox/u,
    ],
    [
      'empty mailbox field',
      JSON.stringify({
        ...configuration,
        gmail: { ...configuration.gmail, inboxPath: '' },
      }),
      /empty or invalid field/u,
    ],
    [
      'wrong username',
      JSON.stringify({
        ...configuration,
        gmail: { ...configuration.gmail, username: 'other@gmail.com' },
      }),
      /invalid mailbox address or path/u,
    ],
    [
      'wrong host',
      JSON.stringify({
        ...configuration,
        gmx: { ...configuration.gmx, host: 'imap.example.test' },
      }),
      /mismatched provider mailbox/u,
    ],
    [
      'same inbox and spam',
      JSON.stringify({
        ...configuration,
        web_de: { ...configuration.web_de, spamPath: 'INBOX' },
      }),
      /invalid mailbox address or path/u,
    ],
    [
      'missing OAuth',
      JSON.stringify({
        ...configuration,
        outlook: { ...configuration.outlook, oauth: null },
      }),
      /Outlook OAuth credentials/u,
    ],
    [
      'insecure rotation URL',
      JSON.stringify({
        ...configuration,
        outlook: {
          ...configuration.outlook,
          oauth: {
            ...configuration.outlook.oauth,
            rotationUrl: 'http://secrets.example.test/rotate',
          },
        },
      }),
      /HTTPS rotation URL/u,
    ],
    [
      'missing password',
      JSON.stringify({
        ...configuration,
        gmx: { ...configuration.gmx, password: '' },
      }),
      /empty or invalid field/u,
    ],
  ];
  for (const [name, raw, reason] of invalidCases) {
    assert.throws(
      () => getSeedTestConfiguration(environment, () => raw),
      reason,
      name,
    );
  }
  assert.throws(
    () =>
      getSeedTestConfiguration(
        {
          ...environment,
          SEED_TEST_CONFIG_PATH: 'relative.json',
        },
        () => JSON.stringify(configuration),
      ),
    /must be absolute/u,
  );
});

test('seed sender uses the transactional domain and a stable provider idempotency key', async () => {
  const sent: unknown[] = [];
  const provider: EmailProvider = {
    id: 'resend',
    sendingDomain: 'send.valstara.com',
    capabilities: { broadcast: false, contactSync: false, dailyFreeCap: 100 },
    async send(input) {
      sent.push(input);
      return { providerMessageId: 'test-message' };
    },
  };
  await createResendSeedSender(provider, configuration).send({
    provider: 'web_de',
    marker: 'test-marker',
    businessKey: 'seed:2026-09-28:web_de',
  });
  assert.deepEqual(sent, [
    {
      message: {
        from: 'Valstara <hello@send.valstara.com>',
        to: 'seed@web.de',
        subject: 'Valstara delivery seed test-marker',
        text: 'Valstara delivery seed test-marker. This mailbox is used for delivery monitoring.',
      },
      idempotencyKey: 'seed:2026-09-28:web_de',
      headers: {},
    },
  ]);
});

test('IMAP probe checks junk before inbox and closes the connection', async () => {
  const paths: string[] = [];
  let currentPath = '';
  let closed = false;
  const client = {
    async connect() {},
    async logout() {
      closed = true;
    },
    async getMailboxLock(path: string) {
      currentPath = path;
      paths.push(path);
      return { release() {} };
    },
    async search() {
      return currentPath === 'Junk' ? [1] : [];
    },
  };
  const placement = await createImapSeedMailbox(configuration, {
    imapClient: () => client as never,
  }).placement('gmx', 'test-marker');
  assert.equal(placement, 'spam');
  assert.deepEqual(paths, ['Junk']);
  assert.equal(closed, true);
});

test('Brevo seed inspection retrieves raw delivered MIME from the matching mailbox', async () => {
  let path = '';
  const paths: string[] = [];
  const source = Buffer.from('MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nseed');
  const client = {
    async connect() {},
    async logout() {},
    async getMailboxLock(selected: string) {
      path = selected;
      paths.push(selected);
      return { release() {} };
    },
    async search() { return path === 'INBOX' ? [17] : []; },
    async fetchOne(uid: number) {
      assert.equal(uid, 17);
      return { source };
    },
  };
  const mailbox = createImapSeedMailbox(configuration, {
    imapClient: () => client as never,
  });
  assert.deepEqual(await mailbox.source('gmx', 'seed-marker'), source);
  assert.deepEqual(paths, ['Junk', 'INBOX']);
});

test('Outlook access token refresh must rotate through the configured secret-manager hook', async () => {
  const calls: Array<{
    url: string;
    authorization: string | null;
    body: string;
  }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    calls.push({ url, authorization: headers.get('Authorization'), body });
    if (url.includes('microsoftonline.com')) {
      return Response.json({
        access_token: 'test-access-token',
        refresh_token: 'next-refresh-token',
      });
    }
    return new Response(null, { status: 204 });
  };
  let accessToken: string | undefined;
  const client = {
    async connect() {},
    async logout() {},
    async getMailboxLock() {
      return { release() {} };
    },
    async search() {
      return [1];
    },
  };
  const probe = createImapSeedMailbox(configuration, {
    fetch: request as typeof fetch,
    imapClient: (input) => {
      accessToken = input?.auth?.accessToken;
      return client as never;
    },
  });
  assert.equal(await probe.placement('outlook', 'test-marker'), 'spam');
  assert.equal(accessToken, 'test-access-token');
  assert.equal(calls[0]?.authorization, null);
  assert.ok(calls[0]?.body.includes('refresh_token=first-refresh-token'));
  assert.equal(calls[1]?.url, configuration.outlook.oauth.rotationUrl);
  assert.equal(calls[1]?.authorization, 'Bearer test-rotation-token');
  assert.deepEqual(JSON.parse(calls[1]!.body), {
    refresh_token: 'next-refresh-token',
  });
});
