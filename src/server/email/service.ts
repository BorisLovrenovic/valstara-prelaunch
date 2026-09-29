import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { createEmailRepository, type QueuedEmailRow } from '../db/email.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createVerificationService } from '../verification/service.ts';
import { deriveEmailToken } from '../verification/token-derivation.ts';

export interface Message {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailProvider {
  readonly id: string;
  readonly sendingDomain: string;
  readonly capabilities: {
    readonly broadcast: boolean;
    readonly contactSync: boolean;
    readonly dailyFreeCap: number;
  };
  send(input: {
    readonly message: Message;
    readonly idempotencyKey: string;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<{ readonly providerMessageId: string }>;
}

export interface TemplateRenderer {
  readonly kind: 'transactional' | 'broadcast';
  render(input: {
    readonly email: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly token: (id: string) => Promise<string>;
    readonly unsubscribePageUrl: string;
  }): Promise<Message>;
}

export interface QueueEmailInput {
  readonly template: string;
  readonly subscriberId: string;
  readonly businessKey: string;
  readonly provider: string;
  readonly payload: Readonly<Record<string, string | number>>;
}

export interface DispatchSummary {
  readonly scanned: number;
  readonly sent: number;
  readonly suppressed: number;
  readonly unregistered: number;
  readonly broadcastPaused: number;
  readonly retried: number;
  readonly failed: number;
}

export interface EmailServiceDependencies {
  readonly clock: () => Date;
  readonly tokenSecret: string;
  readonly baseUrl: string;
  readonly providers: ReadonlyMap<string, EmailProvider>;
  readonly renderers: ReadonlyMap<string, TemplateRenderer>;
  readonly isBroadcastEnabled: () => Promise<boolean>;
  readonly operatorTask: (input: {
    readonly emailSendId: string;
    readonly code: string;
  }) => Promise<void>;
}

export const maxDispatchBatch = 100;
export const maxSendAttempts = 5;
export const maxBackoffMs = 60 * 60 * 1000;
export const initialBackoffMs = 60 * 1000;

export function backoffMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('Attempt number must be positive.');
  }
  return Math.min(
    maxBackoffMs,
    initialBackoffMs * 2 ** Math.min(attempt - 1, 20),
  );
}

export function unsubscribeHeaders(
  baseUrl: string,
  token: string,
): Readonly<Record<string, string>> {
  const { headerUrl } = unsubscribeTargets(baseUrl, token);
  return unsubscribeHeadersForUrl(headerUrl);
}

function unsubscribeTargets(
  baseUrl: string,
  token: string,
): {
  headerUrl: string;
  pageUrl: string;
} {
  const header = new URL('/api/unsubscribe', baseUrl);
  header.searchParams.set('token', token);
  const page = new URL('/unsubscribe', baseUrl);
  page.searchParams.set('t', token);
  return { headerUrl: header.toString(), pageUrl: page.toString() };
}

function unsubscribeHeadersForUrl(
  headerUrl: string,
): Readonly<Record<string, string>> {
  return {
    'List-Unsubscribe': `<${headerUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

function tokenMatches(hash: Buffer, token: string): boolean {
  const calculated = createHash('sha256').update(token).digest();
  return hash.length === calculated.length && timingSafeEqual(hash, calculated);
}

export async function prepareDispatchMessage(input: {
  readonly row: QueuedEmailRow;
  readonly recipient: string;
  readonly renderer: TemplateRenderer;
  readonly baseUrl: string;
  readonly token: (id: string, purpose?: string) => Promise<string>;
}): Promise<{ message: Message; headers: Readonly<Record<string, string>> }> {
  const { row, recipient, renderer, baseUrl, token } = input;
  if (row.unsubscribe_token_id === null)
    throw new Error('unsubscribe_token_missing');
  const unsubscribe = await token(row.unsubscribe_token_id, 'unsubscribe');
  const targets = unsubscribeTargets(baseUrl, unsubscribe);
  const message = await renderer.render({
    email: recipient,
    payload: row.payload,
    token: (id) => token(id),
    unsubscribePageUrl: targets.pageUrl,
  });
  if (typeof message.text !== 'string' || message.text.trim() === '') {
    throw new Error('text_alternative_missing');
  }
  if (message.to !== recipient) throw new Error('recipient_mismatch');
  return { message, headers: unsubscribeHeadersForUrl(targets.headerUrl) };
}

export function createEmailService(
  database: DatabasePool,
  dependencies: EmailServiceDependencies,
) {
  const base = new URL(dependencies.baseUrl);
  if (
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new RangeError('Email base URL must be a bare origin.');
  }

  async function queueInTransaction(
    connection: DatabaseConnection,
    input: QueueEmailInput,
  ): Promise<boolean> {
    const repo = createEmailRepository(connection);
    if (
      input.businessKey === '' ||
      input.template === '' ||
      input.provider === ''
    ) {
      throw new RangeError('Email queue identifiers must be nonempty.');
    }
    await repo.lockBusinessKey(input.businessKey);
    if (await repo.findByBusinessKey(input.businessKey)) return false;
    const unsubscribe = await createVerificationService(connection, {
      clock: dependencies.clock,
      tokenSecret: dependencies.tokenSecret,
    }).issue(input.subscriberId, 'unsubscribe');
    await repo.insert({
      id: randomUUID(),
      subscriberId: input.subscriberId,
      template: input.template,
      provider: input.provider,
      businessKey: input.businessKey,
      payload: { ...input.payload },
      unsubscribeTokenId: unsubscribe.id,
      now: dependencies.clock(),
    });
    return true;
  }

  async function verifiedToken(
    connection: DatabaseConnection,
    id: string,
    subscriberId: string,
    purpose?: string,
  ): Promise<string> {
    const row = await createEmailRepository(connection).tokenById(id);
    if (
      row === null ||
      row.subscriber_id !== subscriberId ||
      (purpose !== undefined && row.purpose !== purpose)
    ) {
      throw new Error('email_token_missing');
    }
    if (row.expires_at <= dependencies.clock())
      throw new Error('email_token_expired');
    const token = deriveEmailToken(id, dependencies.tokenSecret);
    if (!tokenMatches(row.token_hash, token))
      throw new Error('token_secret_rotated');
    return token;
  }

  return {
    queue(
      input: QueueEmailInput,
      connection?: DatabaseConnection,
    ): Promise<boolean> {
      return connection
        ? queueInTransaction(connection, input)
        : withTransaction(database, (transaction) =>
            queueInTransaction(transaction, input),
          );
    },
    async health(): Promise<{ unregisteredQueued: number }> {
      return {
        unregisteredQueued: await createEmailRepository(
          database,
        ).countUnregistered(
          [...dependencies.providers.keys()],
          [...dependencies.renderers.keys()],
        ),
      };
    },
    async dispatch(limit: number): Promise<DispatchSummary> {
      if (!Number.isInteger(limit) || limit < 1 || limit > maxDispatchBatch) {
        throw new RangeError(
          `Email dispatch limit must be between 1 and ${maxDispatchBatch}.`,
        );
      }
      const now = dependencies.clock();
      const broadcastEnabled = await dependencies
        .isBroadcastEnabled()
        .catch(() => false);
      const providerIds = [...dependencies.providers.keys()];
      const activeTemplates = [...dependencies.renderers.entries()]
        .filter(
          ([, renderer]) =>
            renderer.kind === 'transactional' || broadcastEnabled,
        )
        .map(([template]) => template);
      return withTransaction(database, async (connection) => {
        const repo = createEmailRepository(connection);
        const ready = await repo.listDue(
          now,
          limit,
          providerIds,
          activeTemplates,
          true,
        );
        const blocked =
          ready.length < limit
            ? await repo.listDue(
                now,
                limit - ready.length,
                providerIds,
                activeTemplates,
                false,
              )
            : [];
        const due = [...ready, ...blocked];
        const summary = {
          scanned: due.length,
          sent: 0,
          suppressed: 0,
          unregistered: 0,
          broadcastPaused: 0,
          retried: 0,
          failed: 0,
        };
        for (const row of due) {
          const provider = dependencies.providers.get(row.provider);
          const renderer = dependencies.renderers.get(row.template);
          if (provider === undefined || renderer === undefined) {
            summary.unregistered += 1;
            continue;
          }
          if (renderer.kind === 'broadcast' && !broadcastEnabled) {
            summary.broadcastPaused += 1;
            continue;
          }
          const recipient = await repo.recipient(row.subscriber_id);
          if (
            recipient === null ||
            recipient.suppressed ||
            (renderer.kind === 'broadcast' &&
              (recipient.status !== 'verified' ||
                recipient.marketing_consent_at === null))
          ) {
            await repo.markFailed(row.id, now, 'recipient_ineligible');
            summary.suppressed += 1;
            continue;
          }
          let prepared: {
            message: Message;
            headers: Readonly<Record<string, string>>;
          };
          try {
            prepared = await prepareDispatchMessage({
              row,
              recipient: recipient.email,
              renderer,
              baseUrl: base.origin,
              token: (id, purpose) =>
                verifiedToken(connection, id, row.subscriber_id, purpose),
            });
          } catch (error) {
            const code =
              error instanceof Error &&
              [
                'email_token_missing',
                'email_token_expired',
                'token_secret_rotated',
                'unsubscribe_token_missing',
                'text_alternative_missing',
                'recipient_mismatch',
              ].includes(error.message)
                ? error.message
                : 'render_failed';
            await repo.markFailed(row.id, now, code);
            await dependencies.operatorTask({ emailSendId: row.id, code });
            summary.failed += 1;
            continue;
          }
          try {
            const sent = await provider.send({
              message: prepared.message,
              headers: prepared.headers,
              idempotencyKey: row.business_key,
            });
            await repo.markSent(row.id, sent.providerMessageId, now);
            summary.sent += 1;
          } catch {
            if (row.attempts + 1 >= maxSendAttempts) {
              await repo.markFailed(row.id, now, 'provider_unavailable');
              await dependencies.operatorTask({
                emailSendId: row.id,
                code: 'provider_unavailable',
              });
              summary.failed += 1;
            } else {
              await repo.markDeferred(
                row.id,
                now,
                new Date(now.getTime() + backoffMs(row.attempts + 1)),
                'provider_unavailable',
              );
              summary.retried += 1;
            }
          }
        }
        return summary;
      });
    },
  };
}
