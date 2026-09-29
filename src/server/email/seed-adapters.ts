import { ImapFlow } from 'imapflow';

import { emailCopy } from '../../copy/email.ts';
import type { SeedProvider } from '../db/seed-test.ts';
import type { SeedTestConfiguration } from '../config.ts';
import type { EmailProvider } from './service.ts';
import type { SeedMailbox, SeedSender } from './seed-test.ts';
import type { BroadcastSeedMailbox } from './broadcast-seed.ts';

type SeedImapClient = Pick<
  ImapFlow,
  'connect' | 'logout' | 'getMailboxLock' | 'search'
> &
  Partial<Pick<ImapFlow, 'fetchOne'>>;

export interface SeedAdapterDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly imapClient?: (
    input: ConstructorParameters<typeof ImapFlow>[0],
  ) => SeedImapClient;
}

export function createResendSeedSender(
  provider: EmailProvider,
  configuration: SeedTestConfiguration,
): SeedSender {
  return {
    async send({ provider: destination, marker, businessKey }) {
      const recipient = configuration[destination].address;
      await provider.send({
        message: {
          from: `${emailCopy.senderName} <hello@${provider.sendingDomain}>`,
          to: recipient,
          subject: emailCopy.seed.subject(marker),
          text: emailCopy.seed.text(marker),
        },
        idempotencyKey: businessKey,
        headers: {},
      });
    },
  };
}

export function createImapSeedMailbox(
  configuration: SeedTestConfiguration,
  dependencies: SeedAdapterDependencies = {},
): SeedMailbox & BroadcastSeedMailbox {
  const request = dependencies.fetch ?? globalThis.fetch;
  const makeClient =
    dependencies.imapClient ?? ((input) => new ImapFlow(input));
  let outlookRefreshToken = configuration.outlook.oauth.refreshToken;

  async function outlookAccessToken(): Promise<string> {
    const oauth = configuration.outlook.oauth;
    let response: Response;
    try {
      response = await request(
        'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: oauth.clientId,
            client_secret: oauth.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: outlookRefreshToken,
            scope:
              'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new Error('seed_oauth_unavailable');
    }
    if (!response.ok) throw new Error('seed_oauth_rejected');
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('seed_oauth_response_invalid');
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      !('access_token' in body) ||
      typeof body.access_token !== 'string' ||
      !('refresh_token' in body) ||
      typeof body.refresh_token !== 'string' ||
      body.access_token.length === 0 ||
      body.refresh_token.length === 0
    ) {
      throw new Error('seed_oauth_response_invalid');
    }
    if (body.refresh_token !== outlookRefreshToken) {
      let rotated: Response;
      try {
        rotated = await request(oauth.rotationUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${oauth.rotationToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refresh_token: body.refresh_token }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error('seed_oauth_rotation_unavailable');
      }
      if (!rotated.ok) throw new Error('seed_oauth_rotation_rejected');
      outlookRefreshToken = body.refresh_token;
    }
    return body.access_token;
  }

  async function contains(
    client: SeedImapClient,
    path: string,
    marker: string,
  ): Promise<boolean> {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const matches = await client.search({ subject: marker }, { uid: true });
      return Array.isArray(matches) && matches.length > 0;
    } finally {
      lock.release();
    }
  }

  async function source(
    client: SeedImapClient,
    path: string,
    marker: string,
  ): Promise<Buffer | null> {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const matches = await client.search({ subject: marker }, { uid: true });
      if (!Array.isArray(matches) || matches.length === 0) return null;
      if (client.fetchOne === undefined)
        throw new Error('seed_source_unavailable');
      const message = await client.fetchOne(
        matches[0]!,
        { source: true },
        { uid: true },
      );
      if (!message || !Buffer.isBuffer(message.source))
        throw new Error('seed_source_unavailable');
      if (message.source.length > 1024 * 1024)
        throw new Error('seed_source_too_large');
      return message.source;
    } finally {
      lock.release();
    }
  }

  async function clientFor(provider: SeedProvider): Promise<SeedImapClient> {
    const mailbox = configuration[provider];
    const auth =
      provider === 'outlook'
        ? { user: mailbox.username, accessToken: await outlookAccessToken() }
        : { user: mailbox.username, pass: configuration[provider].password };
    return makeClient({
      host: mailbox.host,
      port: 993,
      secure: true,
      auth,
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }

  return {
    async placement(provider: SeedProvider, marker: string) {
      const mailbox = configuration[provider];
      const client = await clientFor(provider);
      await client.connect();
      try {
        if (await contains(client, mailbox.spamPath, marker)) return 'spam';
        if (await contains(client, mailbox.inboxPath, marker)) return 'inbox';
        return null;
      } finally {
        await client.logout();
      }
    },
    async source(provider: SeedProvider, marker: string) {
      const mailbox = configuration[provider];
      const client = await clientFor(provider);
      await client.connect();
      try {
        return (
          (await source(client, mailbox.spamPath, marker)) ??
          (await source(client, mailbox.inboxPath, marker))
        );
      } finally {
        await client.logout();
      }
    },
  };
}
