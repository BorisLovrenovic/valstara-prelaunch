import type { EmailProvider } from '../service.ts';

export interface ResendProviderDependencies {
  readonly fetch?: typeof globalThis.fetch;
}

function senderAddress(from: string): string | null {
  if (/[\r\n]/u.test(from)) return null;
  const match = /^(?:[^<>]*<)?([^<>\s]+@[^<>\s]+)(?:>)?$/u.exec(from);
  return match?.[1] ?? null;
}

export function createResendProvider(
  apiKey: string,
  sendingDomain: string,
  dependencies: ResendProviderDependencies = {},
): EmailProvider {
  if (!apiKey) throw new Error('resend_key_missing');
  const request = dependencies.fetch ?? globalThis.fetch;

  return {
    id: 'resend',
    sendingDomain,
    capabilities: {
      broadcast: false,
      contactSync: false,
      dailyFreeCap: 100,
    },
    async send({ message, idempotencyKey, headers }) {
      const from = senderAddress(message.from);
      if (
        from === null ||
        from.split('@')[1]?.toLowerCase() !== sendingDomain
      ) {
        throw new Error('resend_sender_domain_invalid');
      }
      if (idempotencyKey.length < 1 || idempotencyKey.length > 256) {
        throw new Error('resend_idempotency_key_invalid');
      }
      let response: Response;
      try {
        response = await request('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html === undefined ? {} : { html: message.html }),
            headers,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error('resend_send_unavailable');
      }
      if (!response.ok) throw new Error('resend_send_rejected');
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('resend_response_invalid');
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        !('id' in body) ||
        typeof body.id !== 'string' ||
        body.id === ''
      ) {
        throw new Error('resend_response_invalid');
      }
      return { providerMessageId: body.id };
    },
  };
}
