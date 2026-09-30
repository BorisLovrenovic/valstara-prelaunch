import { createHash } from 'node:crypto';

import type { EmailProvider } from '../service.ts';

export interface BrevoContactProvider extends EmailProvider {
  upsertContact(emailNormalised: string, email: string): Promise<void>;
  removeContact(emailNormalised: string): Promise<void>;
  listReconciliationEvents(input: {
    event: 'hardBounces' | 'spam';
    startDate: string;
    endDate: string;
    offset: number;
    limit: number;
  }): Promise<{
    readonly scanned: number;
    readonly items: readonly {
      email: string;
      messageId: string;
      event: 'hard_bounce' | 'spam';
    }[];
  }>;
  listBlockedContacts(input: {
    startDate: string;
    endDate: string;
    offset: number;
    limit: number;
  }): Promise<{
    readonly scanned: number;
    readonly items: readonly {
      email: string;
      reason: 'bounce_hard' | 'complaint';
    }[];
  }>;
}

export interface BrevoProviderDependencies {
  readonly fetch?: typeof globalThis.fetch;
}

function sender(from: string): { name?: string; email: string } | null {
  if (/[\r\n]/u.test(from)) return null;
  const named = /^([^<>]+) <([^<>\s]+@[^<>\s]+)>$/u.exec(from);
  if (named) return { name: named[1]!.trim(), email: named[2]! };
  return /^[^<>\s]+@[^<>\s]+$/u.test(from) ? { email: from } : null;
}

function stableIdempotencyKey(businessKey: string): string {
  const hex = createHash('sha256').update(businessKey).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createBrevoProvider(
  apiKey: string,
  sendingDomain: string,
  listId: number,
  dependencies: BrevoProviderDependencies = {},
): BrevoContactProvider {
  if (!apiKey) throw new Error('brevo_key_missing');
  if (sendingDomain !== 'mail.valstara.com')
    throw new Error('brevo_domain_invalid');
  if (!Number.isSafeInteger(listId) || listId < 1)
    throw new Error('brevo_list_invalid');
  const request = dependencies.fetch ?? globalThis.fetch;

  async function call(
    path: string,
    method: string,
    body: unknown,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await request(`https://api.brevo.com/v3${path}`, {
        method,
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('brevo_unavailable');
    }
    return response;
  }

  async function readList(
    path: string,
    field: 'events' | 'contacts',
    limit: number,
  ): Promise<readonly unknown[]> {
    let response: Response;
    try {
      response = await request(`https://api.brevo.com/v3${path}`, {
        method: 'GET',
        headers: { 'api-key': apiKey },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('brevo_reconciliation_unavailable');
    }
    if (!response.ok) throw new Error('brevo_reconciliation_rejected');
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('brevo_reconciliation_response_invalid');
    }
    const list =
      typeof body === 'object' && body !== null && field in body
        ? (body as Record<string, unknown>)[field]
        : undefined;
    if (!Array.isArray(list) || list.length > limit)
      throw new Error('brevo_reconciliation_response_invalid');
    return list;
  }

  function fromOurDomain(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      sender(value)?.email.split('@')[1]?.toLowerCase() === sendingDomain
    );
  }

  return {
    id: 'brevo',
    sendingDomain,
    capabilities: { broadcast: true, contactSync: true, dailyFreeCap: 300 },
    async send({ message, idempotencyKey, headers }) {
      const from = sender(message.from);
      if (from?.email.split('@')[1]?.toLowerCase() !== sendingDomain)
        throw new Error('brevo_sender_domain_invalid');
      if (
        message.html === undefined ||
        message.html.trim() === '' ||
        message.text.trim() === ''
      )
        throw new Error('brevo_body_missing');
      if (idempotencyKey === '')
        throw new Error('brevo_idempotency_key_invalid');
      const providerKey = stableIdempotencyKey(idempotencyKey);
      const response = await call('/smtp/email', 'POST', {
        sender: from,
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
        headers: { ...headers, idempotencyKey: providerKey },
      });
      if (!response.ok) {
        // Brevo returns this code when it accepted the same key earlier.
        // The original provider message ID is not returned on that response.
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          /* fixed error below */
        }
        if (
          response.status === 400 &&
          typeof errorBody === 'object' &&
          errorBody !== null &&
          'code' in errorBody &&
          errorBody.code === 'duplicate_parameter'
        )
          return { providerMessageId: `brevo-duplicate:${providerKey}` };
        throw new Error('brevo_send_rejected');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('brevo_response_invalid');
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        !('messageId' in body) ||
        typeof body.messageId !== 'string' ||
        body.messageId === ''
      )
        throw new Error('brevo_response_invalid');
      return { providerMessageId: body.messageId };
    },
    async upsertContact(emailNormalised, email) {
      const response = await call('/contacts', 'POST', {
        ext_id: emailNormalised,
        email,
        listIds: [listId],
        updateEnabled: true,
      });
      if (!response.ok) throw new Error('brevo_contact_upsert_rejected');
    },
    async removeContact(emailNormalised) {
      const identifier = encodeURIComponent(emailNormalised);
      const response = await call(
        `/contacts/${identifier}?identifierType=ext_id`,
        'PUT',
        { unlinkListIds: [listId] },
      );
      if (!response.ok && response.status !== 404)
        throw new Error('brevo_contact_remove_rejected');
    },
    async listReconciliationEvents(input) {
      const params = new URLSearchParams({
        event: input.event,
        startDate: input.startDate,
        endDate: input.endDate,
        sort: 'asc',
        offset: String(input.offset),
        limit: String(input.limit),
      });
      const rows = await readList(
        `/smtp/statistics/events?${params}`,
        'events',
        input.limit,
      );
      const items = rows.flatMap((row) => {
        if (typeof row !== 'object' || row === null)
          throw new Error('brevo_reconciliation_response_invalid');
        const event = 'event' in row ? row.event : undefined;
        const email = 'email' in row ? row.email : undefined;
        const messageId = 'messageId' in row ? row.messageId : undefined;
        const from = 'from' in row ? row.from : undefined;
        if (!fromOurDomain(from)) return [];
        if (
          typeof email !== 'string' ||
          typeof messageId !== 'string' ||
          !messageId ||
          (event !== input.event &&
            event !== (input.event === 'hardBounces' ? 'hard_bounce' : 'spam'))
        )
          throw new Error('brevo_reconciliation_response_invalid');
        return [
          {
            email,
            messageId,
            event:
              input.event === 'hardBounces'
                ? ('hard_bounce' as const)
                : ('spam' as const),
          },
        ];
      });
      return { scanned: rows.length, items };
    },
    async listBlockedContacts(input) {
      const params = new URLSearchParams({
        startDate: input.startDate,
        endDate: input.endDate,
        sort: 'asc',
        offset: String(input.offset),
        limit: String(input.limit),
      });
      const rows = await readList(
        `/smtp/blockedContacts?${params}`,
        'contacts',
        input.limit,
      );
      const items: { email: string; reason: 'bounce_hard' | 'complaint' }[] =
        rows.flatMap(
          (row): { email: string; reason: 'bounce_hard' | 'complaint' }[] => {
            if (typeof row !== 'object' || row === null)
              throw new Error('brevo_reconciliation_response_invalid');
            const email = 'email' in row ? row.email : undefined;
            const reason = 'reason' in row ? row.reason : undefined;
            const senderEmail =
              'senderEmail' in row ? row.senderEmail : undefined;
            if (
              senderEmail !== null &&
              senderEmail !== undefined &&
              !fromOurDomain(senderEmail)
            )
              return [];
            const code =
              typeof reason === 'object' && reason !== null && 'code' in reason
                ? reason.code
                : undefined;
            if (typeof email !== 'string')
              throw new Error('brevo_reconciliation_response_invalid');
            if (code === 'hardBounce' || code === 'hard_bounce')
              return [{ email, reason: 'bounce_hard' as const }];
            if (code === 'contactFlaggedAsSpam')
              return [{ email, reason: 'complaint' as const }];
            return [];
          },
        );
      return { scanned: rows.length, items };
    },
  };
}
