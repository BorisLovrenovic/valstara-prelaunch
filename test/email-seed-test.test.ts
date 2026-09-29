import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type {
  SeedProvider,
  SeedRow,
  SeedTestRepository,
} from '../src/server/db/seed-test.ts';
import {
  createSeedTestService,
  createSeedTestAlert,
  seedMissingAfterMs,
  seedProviders,
  seedTestHealth,
  seedWeekStart,
} from '../src/server/email/seed-test.ts';
import {
  createMaintenanceFailureReporter,
  createVerificationMaintenanceScheduler,
} from '../src/server/subscriber/maintenance.ts';

function fakeRepository(): SeedTestRepository & { rows: Map<string, SeedRow> } {
  const rows = new Map<string, SeedRow>();
  const key = (week: Date, provider: SeedProvider) =>
    `${week.toISOString().slice(0, 10)}:${provider}`;
  return {
    rows,
    async ensure(week, provider, marker) {
      const id = key(week, provider);
      if (!rows.has(id))
        rows.set(id, {
          week_start: week.toISOString().slice(0, 10),
          provider,
          marker,
          placement: 'pending',
          sent_at: null,
          checked_at: null,
          alerted_at: null,
        });
      return rows.get(id)!;
    },
    async markSent(week, provider, at) {
      const id = key(week, provider);
      rows.set(id, { ...rows.get(id)!, sent_at: at });
    },
    async markPlacement(week, provider, placement, at) {
      const id = key(week, provider);
      const previous = rows.get(id)!;
      rows.set(id, {
        ...previous,
        placement,
        checked_at: at,
        alerted_at:
          previous.placement === placement ? previous.alerted_at : null,
      });
    },
    async markAlerted(week, provider, at) {
      const id = key(week, provider);
      rows.set(id, { ...rows.get(id)!, alerted_at: at });
    },
    async latest() {
      const latest = [...rows.values()]
        .map((row) => row.week_start)
        .sort()
        .at(-1);
      return [...rows.values()].filter((row) => row.week_start === latest);
    },
  };
}

test('seed harness records all four providers once per UTC week', async () => {
  let now = new Date('2026-09-29T09:00:00.000Z');
  const repository = fakeRepository();
  const sends: string[] = [];
  const harness = createSeedTestService(
    repository,
    {
      async send(input) {
        sends.push(input.businessKey);
      },
    },
    {
      async placement() {
        return 'inbox';
      },
    },
    {
      async send() {
        assert.fail('healthy seeds must not alert');
      },
    },
    () => now,
  );

  const first = await harness.run();
  assert.deepEqual(
    first.providers.map((row) => [row.provider, row.placement]),
    seedProviders.map((provider) => [provider, 'inbox']),
  );
  assert.equal(first.state, 'current');
  await harness.run();
  assert.equal(sends.length, 4);
  now = new Date('2026-10-05T00:00:00.000Z');
  await harness.run();
  assert.equal(sends.length, 8);
  assert.equal(repository.rows.size, 8);
  assert.equal(
    seedWeekStart(new Date('2026-10-04T23:59:59.000Z')).toISOString(),
    '2026-09-28T00:00:00.000Z',
  );
});

test('spam placement persists and raises a P1 once', async () => {
  const now = new Date('2026-09-29T09:00:00.000Z');
  const repository = fakeRepository();
  const alerts: unknown[] = [];
  let gmailPlacement: 'spam' | 'inbox' | null = null;
  const harness = createSeedTestService(
    repository,
    { async send() {} },
    {
      async placement(provider) {
        return provider === 'gmail' ? gmailPlacement : 'inbox';
      },
    },
    createSeedTestAlert({
      async send(result) {
        alerts.push(result);
      },
    }),
    () => now,
  );
  await harness.run();
  gmailPlacement = 'spam';
  await harness.run();
  await harness.run();
  assert.deepEqual(alerts, [
    {
      detail: {
        provider: 'gmail',
        placement: 'spam',
        week_start: '2026-09-28',
      },
      event: 'email_seed_placement_failed',
      occurredAt: now,
      severity: 'P1',
    },
  ]);
  assert.equal((await harness.health()).providers[0]?.placement, 'spam');
});

test('missing placement after two hours alerts and a delayed inbox arrival is recorded', async () => {
  let now = new Date('2026-09-29T09:00:00.000Z');
  const repository = fakeRepository();
  const alerts: string[] = [];
  let observed: 'inbox' | null = null;
  const harness = createSeedTestService(
    repository,
    { async send() {} },
    {
      async placement() {
        return observed;
      },
    },
    {
      async send(result) {
        alerts.push(result.placement);
      },
    },
    () => now,
  );
  await harness.run();
  assert.equal((await harness.health()).providers[0]?.placement, 'pending');
  now = new Date(now.getTime() + seedMissingAfterMs);
  await harness.run();
  assert.deepEqual(alerts, ['missing', 'missing', 'missing', 'missing']);
  observed = 'inbox';
  await harness.run();
  assert.ok(
    (await harness.health()).providers.every(
      (row) => row.placement === 'inbox',
    ),
  );
});

test('a failed alert is retried without a second seed send', async () => {
  const now = new Date('2026-09-29T09:00:00.000Z');
  const repository = fakeRepository();
  let sends = 0;
  let attempts = 0;
  const harness = createSeedTestService(
    repository,
    {
      async send() {
        sends += 1;
      },
    },
    {
      async placement(provider) {
        return provider === 'gmail' ? 'spam' : 'inbox';
      },
    },
    {
      async send() {
        attempts += 1;
        if (attempts === 1) throw new Error('alert down');
      },
    },
    () => now,
  );
  await assert.rejects(harness.run(), /seed_test_failed/u);
  await harness.run();
  assert.equal(sends, 4);
  assert.equal(attempts, 2);
  assert.equal(repository.rows.get('2026-09-28:gmail')?.placement, 'spam');
});

test('one provider failure does not prevent the other three placements and retries only that send', async () => {
  const now = new Date('2026-09-29T09:00:00.000Z');
  const repository = fakeRepository();
  const sends: SeedProvider[] = [];
  let firstOutlook = true;
  const harness = createSeedTestService(
    repository,
    {
      async send(input) {
        sends.push(input.provider);
        if (input.provider === 'outlook' && firstOutlook) {
          firstOutlook = false;
          throw new Error('sender down');
        }
      },
    },
    {
      async placement() {
        return 'inbox';
      },
    },
    {
      async send() {
        assert.fail('no placement alert expected');
      },
    },
    () => now,
  );
  await assert.rejects(harness.run(), /seed_test_failed/u);
  assert.deepEqual(
    (await harness.health()).providers.map((row) => row.placement),
    ['inbox', 'pending', 'inbox', 'inbox'],
  );
  await harness.run();
  assert.deepEqual(sends, ['gmail', 'outlook', 'gmx', 'web_de', 'outlook']);
});

test('health reports no run and stale prior week without needing sender or credentials', async () => {
  const repository = fakeRepository();
  const monday = new Date('2026-09-28T00:00:00.000Z');
  assert.equal(
    (await seedTestHealth(repository, () => monday)).state,
    'not_run',
  );
  for (const provider of seedProviders)
    await repository.ensure(monday, provider, randomUUID());
  assert.equal(
    (
      await seedTestHealth(
        repository,
        () => new Date('2026-10-05T00:00:00.000Z'),
      )
    ).state,
    'stale',
  );
});

test('maintenance schedules the harness and reports a failed run as P1', async () => {
  const occurredAt = new Date('2026-09-29T09:00:00.000Z');
  const alerts: unknown[] = [];
  const noOp = { async run() {} };
  let runs = 0;
  const reporter = createMaintenanceFailureReporter(
    {
      async send(alert) {
        alerts.push(alert);
      },
    },
    { clock: () => occurredAt },
  );
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: noOp,
      rateLimitRetention: noOp,
      referralCounterRepair: noOp,
      reminder: noOp,
      strandedReferral: noOp,
      verificationRate: noOp,
      verificationTokenRetention: noOp,
      seedTest: {
        async run() {
          runs += 1;
          throw new Error('mailbox unavailable');
        },
      },
    },
    { clock: () => occurredAt, reportFailure: reporter },
  );
  await scheduler.runCycle();
  assert.equal(runs, 1);
  assert.deepEqual(alerts, [
    {
      detail: { job: 'seed_test' },
      event: 'verification_maintenance_failed',
      occurredAt,
      severity: 'P1',
    },
  ]);
});
