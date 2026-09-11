import type { P1AlertConfiguration } from '../config.ts';

export interface P1Alert {
  readonly detail: Readonly<Record<string, number | string>>;
  readonly event: string;
  readonly occurredAt: Date;
  readonly severity: 'P1';
}

export interface P1AlertTransport {
  send(alert: P1Alert): Promise<void>;
}

export interface P1AlertTransportDependencies {
  readonly fetch?: typeof globalThis.fetch;
}

export function createP1AlertWebhookTransport(
  configuration: P1AlertConfiguration,
  dependencies: P1AlertTransportDependencies = {},
): P1AlertTransport {
  const request = dependencies.fetch ?? globalThis.fetch;

  return {
    async send(alert) {
      const response = await request(configuration.url, {
        body: JSON.stringify({
          detail: alert.detail,
          event: alert.event,
          occurred_at: alert.occurredAt.toISOString(),
          severity: alert.severity,
        }),
        headers: {
          Authorization: `Bearer ${configuration.token}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        throw new Error('The P1 alert webhook rejected the notification.');
      }
    },
  };
}
