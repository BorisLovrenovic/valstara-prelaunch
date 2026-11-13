import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runResendDispatch } from '../src/server/email/resend-dispatch.ts';
import {
  createMaintenanceHeartbeatRepository,
  type MaintenanceHeartbeatRepository,
} from '../src/server/db/maintenance-heartbeat.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createMaintenanceHeartbeat,
  createMaintenanceHeartbeatWatchdog,
  maintenanceLoopState,
} from '../src/server/subscriber/heartbeat.ts';
import {
  heartbeatFileIsFresh,
  maintenanceHeartbeatFileMaxAgeMs,
  maintenanceLoopIntervalMs,
} from '../src/server/subscriber/heartbeat-file.ts';
import { createVerificationMaintenanceScheduler } from '../src/server/subscriber/maintenance.ts';
import type { Alert } from '../src/server/verification-rate/p1-webhook.ts';

const executeFile = promisify(execFile);
const at = new Date('2026-11-14T09:00:00.000Z');
const minute = 60_000;
const hour = 60 * minute;

function after(milliseconds: number, from: Date = at): Date {
  return new Date(from.getTime() + milliseconds);
}

async function withDatabase(
  run: (app: DatabasePool, owner: DatabasePool) => Promise<void>,
): Promise<void> {
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const name = `valstara_heartbeat_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(databaseUrl.toString());
  let app: DatabasePool | undefined;
  try {
    await runMigrations(owner, {
      applicationRolePassword: appUrl.password,
      release: 'gate-7-heartbeat-test',
    });
    app = createPool(appUrl.toString());
    await run(app, owner);
  } finally {
    await app?.close();
    await owner.close();
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [name],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${name}"` });
    await admin.close();
  }
}

function recordingAlerts() {
  const sent: Alert[] = [];
  return {
    sent,
    transport: {
      async send(alert: Alert) {
        sent.push(alert);
      },
    },
  };
}

test('a loop is stale just over twice its interval and not just under', () => {
  for (const loopKey of ['scheduler_cycle', 'email_dispatch'] as const) {
    const twice = 2 * maintenanceLoopIntervalMs[loopKey];
    const justUnder = maintenanceLoopState(loopKey, at, after(twice - 1), at);
    const exactly = maintenanceLoopState(loopKey, at, after(twice), at);
    const justOver = maintenanceLoopState(loopKey, at, after(twice + 1), at);
    assert.equal(justUnder.stale, false, loopKey);
    assert.equal(exactly.stale, false, loopKey);
    assert.equal(justOver.stale, true, loopKey);
    assert.equal(justOver.ageSeconds, Math.floor((twice + 1) / 1_000));
  }
  assert.equal(maintenanceLoopIntervalMs.scheduler_cycle, hour);
  assert.equal(maintenanceLoopIntervalMs.email_dispatch, minute);
});

test('a never-beaten loop alerts only after the start-up grace', async () => {
  // Pure state: the grace is twice the interval from the watchdog's start.
  assert.equal(
    maintenanceLoopState('email_dispatch', null, after(2 * minute), at).stale,
    false,
  );
  assert.equal(
    maintenanceLoopState('email_dispatch', null, after(2 * minute + 1), at)
      .stale,
    true,
  );

  await withDatabase(async (app) => {
    const repository = createMaintenanceHeartbeatRepository(app);
    const alerts = recordingAlerts();
    let now = at;
    const watchdog = createMaintenanceHeartbeatWatchdog(
      repository,
      alerts.transport,
      { clock: () => now },
    );
    now = after(2 * minute);
    assert.deepEqual(await watchdog.run(), []);
    now = after(2 * minute + 1_000);
    assert.deepEqual(await watchdog.run(), ['email_dispatch']);
    assert.deepEqual(alerts.sent, [
      {
        detail: { loop_key: 'email_dispatch', age_seconds: 121 },
        event: 'maintenance_heartbeat_stale',
        occurredAt: now,
        severity: 'P1',
      },
    ]);
    // The scheduler's own grace is two hours.
    now = after(2 * hour + 1_000);
    assert.deepEqual(await watchdog.run(), ['scheduler_cycle']);
    assert.equal(alerts.sent.length, 2);
  });
});

test('one P1 per stale episode across repeated runs and restarts, and a later stall alerts again', async () => {
  await withDatabase(async (app) => {
    const repository = createMaintenanceHeartbeatRepository(app);
    const heartbeat = createMaintenanceHeartbeat(repository, {
      clock: () => at,
      file: join(tmpdir(), `valstara-heartbeat-${randomUUID()}`),
      writeLog: () => {},
    });
    await heartbeat.beat('email_dispatch');
    await heartbeat.beat('scheduler_cycle');
    const alerts = recordingAlerts();
    let now = after(2 * minute);
    const watchdog = createMaintenanceHeartbeatWatchdog(
      repository,
      alerts.transport,
      { clock: () => now },
    );
    assert.deepEqual(await watchdog.run(), []);

    now = after(2 * minute + 1);
    assert.deepEqual(await watchdog.run(), ['email_dispatch']);
    now = after(10 * minute);
    assert.deepEqual(await watchdog.run(), []);
    // A restarted app reads the persisted stamp and stays quiet.
    const restarted = createMaintenanceHeartbeatWatchdog(
      repository,
      alerts.transport,
      { clock: () => now },
    );
    assert.deepEqual(await restarted.run(), []);
    assert.equal(alerts.sent.length, 1);
    assert.deepEqual(alerts.sent[0]?.detail, {
      loop_key: 'email_dispatch',
      age_seconds: 120,
    });

    // A fresh beat clears the episode; a later stall is a new one.
    const fresh = after(11 * minute);
    await createMaintenanceHeartbeat(repository, {
      clock: () => fresh,
      file: join(tmpdir(), `valstara-heartbeat-${randomUUID()}`),
      writeLog: () => {},
    }).beat('email_dispatch');
    const cleared = (await repository.list()).find(
      (row) => row.loop_key === 'email_dispatch',
    );
    assert.equal(cleared?.stale_alerted_at, null);
    assert.equal(cleared?.last_beat_at?.getTime(), fresh.getTime());
    now = after(2 * minute, fresh);
    assert.deepEqual(await watchdog.run(), []);
    now = after(2 * minute + 1_000, fresh);
    assert.deepEqual(await watchdog.run(), ['email_dispatch']);
    assert.deepEqual(await restarted.run(), []);
    assert.equal(alerts.sent.length, 2);

    // An alert the webhook refuses is retried on the next run, then deduped.
    const flaky = createMaintenanceHeartbeatWatchdog(
      repository,
      {
        async send() {
          throw new Error('webhook down');
        },
      },
      { clock: () => now, writeLog: () => {} },
    );
    now = after(2 * hour + 1_000);
    assert.deepEqual(await flaky.run(), []);
    assert.equal(
      (await repository.list()).find(
        (row) => row.loop_key === 'scheduler_cycle',
      )?.stale_alerted_at,
      null,
    );
    assert.deepEqual(await watchdog.run(), ['scheduler_cycle']);
    assert.deepEqual(await watchdog.run(), []);
    assert.equal(alerts.sent.length, 3);
  });
});

test('a failed heartbeat write does not fail the pass', async () => {
  const logged: string[] = [];
  const failing: Pick<MaintenanceHeartbeatRepository, 'beat'> = {
    async beat() {
      throw new Error('secret: postgresql://valstara_app:password@db');
    },
  };
  const heartbeat = createMaintenanceHeartbeat(failing, {
    clock: () => at,
    file: join(tmpdir(), randomUUID(), 'missing-directory', 'heartbeat'),
    writeLog: (line) => logged.push(line),
  });
  await heartbeat.beat('email_dispatch');
  assert.deepEqual(
    logged.map((line) => JSON.parse(line)),
    [
      { event: 'maintenance_heartbeat_failed', code: 'file_unavailable' },
      { event: 'maintenance_heartbeat_failed', code: 'heartbeat_unavailable' },
    ],
  );

  // The scheduler completes every cycle although its heartbeat rejects.
  let cycles = 0;
  const job = {
    async run() {
      return 0;
    },
  };
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: job,
      rateLimitRetention: job,
      referralCounterRepair: job,
      reminder: {
        async run() {
          cycles += 1;
          return 0;
        },
      },
      strandedReferral: job,
      verificationRate: job,
      verificationTokenRetention: job,
    },
    {
      clock: () => at,
      onCycleComplete: () => Promise.reject(new Error('heartbeat down')),
      sleep: async () => {},
    },
  );
  await scheduler.run(3);
  assert.equal(cycles, 3);

  // The dispatch loop finishes its pass and keeps its own outcome.
  const shutdown = new AbortController();
  let dispatched = 0;
  await runResendDispatch(
    {
      async dispatch() {
        dispatched += 1;
        return { attempted: 0, sent: 0 } as never;
      },
    },
    {
      async send() {
        assert.fail('a heartbeat failure must not raise a dispatch alert');
      },
    },
    () => at,
    shutdown.signal,
    async () => {
      shutdown.abort();
      await heartbeat.beat('email_dispatch');
      throw new Error('heartbeat down');
    },
  );
  assert.equal(dispatched, 1);
});

test('the application role cannot delete heartbeat rows and loop keys are finite', async () => {
  await withDatabase(async (app, owner) => {
    const repository = createMaintenanceHeartbeatRepository(app);
    await repository.beat('scheduler_cycle', at);
    // An older beat never overwrites a newer one.
    await repository.beat('scheduler_cycle', after(-minute));
    assert.equal(
      (await repository.list())[0]?.last_beat_at?.getTime(),
      at.getTime(),
    );
    await assert.rejects(
      app.execute({ text: 'DELETE FROM maintenance_heartbeat' }),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '42501',
    );
    await assert.rejects(
      owner.execute({
        text: `INSERT INTO maintenance_heartbeat (loop_key, last_beat_at)
          VALUES ('unregistered', $1)`,
        values: [at],
      }),
    );
    assert.equal((await repository.list()).length, 1);
  });
});

test('the health check fails on a stale or missing heartbeat file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'valstara-heartbeat-'));
  const file = join(directory, 'heartbeat');
  try {
    await writeFile(file, '');
    // A beat well before this run, whatever the wall clock reads.
    const touched = new Date('2026-01-01T00:00:00.000Z');
    await utimes(file, touched, touched);
    const { mtimeMs } = await stat(file);
    assert.equal(
      await heartbeatFileIsFresh(
        file,
        new Date(mtimeMs + maintenanceHeartbeatFileMaxAgeMs),
      ),
      true,
    );
    assert.equal(
      await heartbeatFileIsFresh(
        file,
        new Date(mtimeMs + maintenanceHeartbeatFileMaxAgeMs + 1),
      ),
      false,
    );
    assert.equal(
      await heartbeatFileIsFresh(join(directory, 'missing'), at),
      false,
    );
    assert.equal(
      maintenanceHeartbeatFileMaxAgeMs,
      2 * maintenanceLoopIntervalMs.email_dispatch,
    );

    // The command Compose runs: the stale file fails it, as does a missing
    // one; a file written just now (the filesystem stamps it) passes.
    const check = (path: string) =>
      executeFile(process.execPath, [
        'src/server/subscriber/heartbeat-check.ts',
        path,
      ]).then(
        () => 0,
        (error: { code?: number }) => error.code ?? -1,
      );
    assert.equal(await check(file), 1);
    assert.equal(await check(join(directory, 'missing')), 1);
    const freshFile = join(directory, 'fresh');
    await writeFile(freshFile, '');
    assert.equal(await check(freshFile), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
