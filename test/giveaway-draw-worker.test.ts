import assert from 'node:assert/strict';
import test from 'node:test';

import { createDrawWorker } from '../src/server/giveaway/draw-worker.ts';
import type { Alert } from '../src/server/verification-rate/p1-webhook.ts';

test('the draw worker advances a pending draw without alerting on success', async () => {
  let calls = 0;
  const alerts: Alert[] = [];
  const worker = createDrawWorker(
    {
      advancePending: async () => {
        calls += 1;
        return true;
      },
    },
    {
      send: async (alert) => {
        alerts.push(alert);
      },
    },
  );
  await worker.runCycle();
  assert.equal(calls, 1);
  assert.deepEqual(alerts, []);
});

test('the draw worker raises a P1 alert when an unexpected failure blocks progress', async () => {
  const alerts: Alert[] = [];
  const now = new Date('2027-04-01T00:00:00.000Z');
  const worker = createDrawWorker(
    {
      advancePending: async () => {
        throw new Error('database unavailable');
      },
    },
    {
      send: async (alert) => {
        alerts.push(alert);
      },
    },
    () => now,
  );
  await worker.runCycle();
  assert.deepEqual(alerts, [
    {
      severity: 'P1',
      event: 'giveaway_draw_worker_failed',
      occurredAt: now,
      detail: { job: 'giveaway_draw' },
    },
  ]);
});

test('award deadlines still expire when catalog-backed initialization fails', async () => {
  const alerts: Alert[] = [];
  let expiryCalls = 0;
  const now = new Date('2027-04-01T00:00:00.000Z');
  const worker = createDrawWorker(
    { advancePending: async () => false },
    {
      send: async (alert) => {
        alerts.push(alert);
      },
    },
    () => now,
    {
      initialize: async () => {
        throw new Error('catalog unavailable');
      },
      expireDue: async () => {
        expiryCalls += 1;
        return { responses: 1, substitutions: 1 };
      },
    },
  );
  await worker.runCycle();
  assert.equal(expiryCalls, 1);
  assert.deepEqual(alerts, [
    {
      severity: 'P1',
      event: 'giveaway_award_initialization_failed',
      occurredAt: now,
      detail: { job: 'giveaway_award_initialization' },
    },
  ]);
});
