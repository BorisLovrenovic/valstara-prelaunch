import type { P1AlertConfiguration } from '../config.ts';

export type AlertSeverity = 'P1' | 'P2';

export interface Alert {
  readonly detail: Readonly<Record<string, number | string>>;
  readonly event: string;
  readonly occurredAt: Date;
  readonly severity: AlertSeverity;
}

export interface AlertTransport {
  send(alert: Alert): Promise<void>;
}

export interface P1AlertTransportDependencies {
  readonly fetch?: typeof globalThis.fetch;
}

export interface UnsubscribeOperatorTask {
  readonly kind: 'operator_task';
  readonly task: 'unsubscribe_apply_failed';
  readonly unsubscribe_token_id: string | null;
  readonly email_send_id: string | null;
  readonly token_sha256: string;
  readonly requested_action: 'message_unsubscribe' | 'leave_waitlist';
  readonly occurred_at: string;
}

export function createUnsubscribeOperatorTaskTransport(
  configuration: P1AlertConfiguration,
  dependencies: P1AlertTransportDependencies = {},
): { send(task: UnsubscribeOperatorTask): Promise<void> } {
  const request = dependencies.fetch ?? globalThis.fetch;
  return {
    async send(task) {
      const response = await request(configuration.url, {
        body: JSON.stringify({ severity: 'P1', ...task }),
        headers: {
          Authorization: `Bearer ${configuration.token}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new Error('The P1 alert webhook rejected the operator task.');
    },
  };
}

export function createAlertWebhookTransport(
  configuration: P1AlertConfiguration,
  dependencies: P1AlertTransportDependencies = {},
): AlertTransport {
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
