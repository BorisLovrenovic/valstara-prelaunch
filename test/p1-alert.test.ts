import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createAlertWebhookTransport } from '../src/server/verification-rate/p1-webhook.ts';
import { createVerificationRateMonitorWithRepository } from '../src/server/verification-rate/service.ts';
import { createMaintenanceFailureReporter } from '../src/server/subscriber/maintenance.ts';

test('a simulated verification-rate collapse reaches the authenticated P1 webhook', async () => {
  let body = '';
  let authorization: string | undefined;
  const server = createServer();
  server.once('request', (request, response) => {
    authorization = request.headers.authorization;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const transport = createAlertWebhookTransport({
    token: 'drill-token',
    url: `http://127.0.0.1:${address.port}/p1`,
  });

  try {
    const monitor = createVerificationRateMonitorWithRepository(
      {
        async counts(from) {
          return from.getUTCDate() === 15
            ? { signups: 50, verified: 10 }
            : { signups: 100, verified: 80 };
        },
        async providerCounts() {
          return [];
        },
      },
      {
        baselineDays: 7,
        cohortHours: 24,
        collapsePercent: 50,
        minimumSignups: 50,
      },
      {
        async alert(alert) {
          await transport.send({
            detail: {
              baseline_rate: alert.baselineRate,
              current_rate: alert.currentRate,
              relative_drop: alert.relativeDrop,
            },
            event: 'verification_rate_collapsed',
            occurredAt: alert.measuredAt,
            severity: alert.severity,
          });
        },
        clock: () => new Date('2026-09-16T12:00:00.000Z'),
      },
    );

    assert.equal((await monitor.run()).state, 'collapsed');
    assert.equal(authorization, 'Bearer drill-token');
    assert.deepEqual(JSON.parse(body), {
      detail: {
        baseline_rate: 0.8,
        current_rate: 0.2,
        relative_drop: 0.7500000000000001,
      },
      event: 'verification_rate_collapsed',
      occurred_at: '2026-09-16T12:00:00.000Z',
      severity: 'P1',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a rejected P1 notification rejects instead of becoming a log-only success', async () => {
  const transport = createAlertWebhookTransport(
    { token: 'test-token', url: 'https://alerts.example.test/p1' },
    { fetch: async () => new Response(null, { status: 503 }) },
  );

  await assert.rejects(
    transport.send({
      detail: { job: 'rate_limit_retention' },
      event: 'verification_maintenance_failed',
      occurredAt: new Date('2026-09-10T12:00:00.000Z'),
      severity: 'P1',
    }),
    /rejected the notification/u,
  );
});

test('the existing authenticated webhook preserves a P2 severity for its receiver', async () => {
  let requestBody = '';
  const transport = createAlertWebhookTransport(
    { token: 'test-token', url: 'https://alerts.example.test/alerts' },
    {
      async fetch(_input, init) {
        requestBody = String(init?.body);
        return new Response(null, { status: 204 });
      },
    },
  );

  await transport.send({
    detail: { corrected: 2 },
    event: 'referral_counters_corrected',
    occurredAt: new Date('2026-09-14T12:00:00.000Z'),
    severity: 'P2',
  });

  assert.deepEqual(JSON.parse(requestBody), {
    detail: { corrected: 2 },
    event: 'referral_counters_corrected',
    occurred_at: '2026-09-14T12:00:00.000Z',
    severity: 'P2',
  });
});

test('a failed rate-limit retention sweep reaches the authenticated P1 webhook', async () => {
  let body = '';
  let authorization: string | undefined;
  const server = createServer();
  server.once('request', (request, response) => {
    authorization = request.headers.authorization;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const transport = createAlertWebhookTransport({
    token: 'retention-drill-token',
    url: `http://127.0.0.1:${address.port}/p1`,
  });
  const reportFailure = createMaintenanceFailureReporter(transport, {
    clock: () => new Date('2026-09-16T13:00:00.000Z'),
  });

  try {
    await reportFailure('rate_limit_retention');
    assert.equal(authorization, 'Bearer retention-drill-token');
    assert.deepEqual(JSON.parse(body), {
      detail: { job: 'rate_limit_retention' },
      event: 'verification_maintenance_failed',
      occurred_at: '2026-09-16T13:00:00.000Z',
      severity: 'P1',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
