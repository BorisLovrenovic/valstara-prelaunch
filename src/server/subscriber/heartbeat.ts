import {
  maintenanceLoopKeys,
  type MaintenanceHeartbeatRepository,
  type MaintenanceHeartbeatRow,
  type MaintenanceLoopKey,
} from '../db/maintenance-heartbeat.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

import {
  maintenanceHeartbeatFile,
  maintenanceLoopIntervalMs,
  touchHeartbeatFile,
} from './heartbeat-file.ts';

/** The watchdog's own cadence, in the app process. */
export const maintenanceWatchdogIntervalMs = 30_000;

function writeStderr(line: string): void {
  process.stderr.write(line);
}

function logCode(
  writeLog: (line: string) => void,
  event: string,
  code: string,
): void {
  try {
    writeLog(`${JSON.stringify({ event, code })}\n`);
  } catch {
    // Logging must never fail the caller.
  }
}

export interface MaintenanceHeartbeat {
  /** Records a completed pass. Never throws. */
  beat(loopKey: MaintenanceLoopKey): Promise<void>;
}

/**
 * The worker's side (QA gate 7, G7-1-I2): after each completed pass it touches
 * the heartbeat file the health check reads and upserts its loop's database
 * row. A failed write is logged as a sanitized code and never fails the pass.
 */
export function createMaintenanceHeartbeat(
  repository: Pick<MaintenanceHeartbeatRepository, 'beat'>,
  dependencies: {
    readonly clock: () => Date;
    readonly file?: string;
    readonly writeLog?: (line: string) => void;
  },
): MaintenanceHeartbeat {
  const file = dependencies.file ?? maintenanceHeartbeatFile;
  const writeLog = dependencies.writeLog ?? writeStderr;
  return {
    async beat(loopKey) {
      let at: Date;
      try {
        at = dependencies.clock();
      } catch {
        logCode(writeLog, 'maintenance_heartbeat_failed', 'clock_unavailable');
        return;
      }
      try {
        await touchHeartbeatFile(file, at);
      } catch {
        logCode(writeLog, 'maintenance_heartbeat_failed', 'file_unavailable');
      }
      try {
        await repository.beat(loopKey, at);
      } catch {
        logCode(
          writeLog,
          'maintenance_heartbeat_failed',
          'heartbeat_unavailable',
        );
      }
    },
  };
}

export interface MaintenanceLoopState {
  readonly stale: boolean;
  /** Seconds since the last beat, or since the watchdog started if none. */
  readonly ageSeconds: number;
}

/**
 * A loop is stale when its last beat is older than twice its interval, or
 * when it has never beaten and twice that interval has passed since the
 * watchdog started (the start-up grace).
 */
export function maintenanceLoopState(
  loopKey: MaintenanceLoopKey,
  lastBeatAt: Date | null,
  now: Date,
  watchdogStartedAt: Date,
): MaintenanceLoopState {
  const since = lastBeatAt ?? watchdogStartedAt;
  const ageMs = now.getTime() - since.getTime();
  return {
    stale: ageMs > 2 * maintenanceLoopIntervalMs[loopKey],
    ageSeconds: Math.max(0, Math.floor(ageMs / 1_000)),
  };
}

export interface MaintenanceHeartbeatWatchdog {
  /** One watchdog pass. Never throws. Returns the loops it alerted for. */
  run(): Promise<readonly MaintenanceLoopKey[]>;
  start(): { stop(): void };
}

/**
 * The app's side: a dead or hung worker cannot report itself, so the app
 * reads the heartbeat rows on an interval. On the first stale reading of an
 * episode it stamps `stale_alerted_at` and sends one P1 carrying only the
 * loop key and age; the stamp is persisted, so neither repeated passes nor an
 * app restart send another until a fresh beat clears it.
 */
export function createMaintenanceHeartbeatWatchdog(
  repository: Pick<
    MaintenanceHeartbeatRepository,
    'claimStale' | 'list' | 'releaseClaim'
  >,
  alerts: AlertTransport,
  dependencies: {
    readonly clock: () => Date;
    readonly writeLog?: (line: string) => void;
    readonly schedule?: (
      callback: () => void,
      milliseconds: number,
    ) => { clear(): void; unref?(): void };
  },
): MaintenanceHeartbeatWatchdog {
  const clock = dependencies.clock;
  const writeLog = dependencies.writeLog ?? writeStderr;
  const schedule =
    dependencies.schedule ??
    ((callback: () => void, milliseconds: number) => {
      const timer = setInterval(callback, milliseconds);
      return {
        clear: () => clearInterval(timer),
        unref: () => timer.unref(),
      };
    });
  const startedAt = clock();
  let running = false;

  async function run(): Promise<readonly MaintenanceLoopKey[]> {
    if (running) return [];
    running = true;
    const alerted: MaintenanceLoopKey[] = [];
    try {
      let rows: readonly MaintenanceHeartbeatRow[];
      try {
        rows = await repository.list();
      } catch {
        logCode(
          writeLog,
          'maintenance_watchdog_failed',
          'heartbeat_unavailable',
        );
        return alerted;
      }
      const now = clock();
      for (const loopKey of maintenanceLoopKeys) {
        const row = rows.find((candidate) => candidate.loop_key === loopKey);
        if (row !== undefined && row.stale_alerted_at !== null) continue;
        const state = maintenanceLoopState(
          loopKey,
          row?.last_beat_at ?? null,
          now,
          startedAt,
        );
        if (!state.stale) continue;
        try {
          const staleBefore = new Date(
            now.getTime() - 2 * maintenanceLoopIntervalMs[loopKey],
          );
          if (!(await repository.claimStale(loopKey, staleBefore, now)))
            continue;
        } catch {
          logCode(
            writeLog,
            'maintenance_watchdog_failed',
            'heartbeat_unavailable',
          );
          continue;
        }
        try {
          await alerts.send({
            detail: { loop_key: loopKey, age_seconds: state.ageSeconds },
            event: 'maintenance_heartbeat_stale',
            occurredAt: now,
            severity: 'P1',
          });
          alerted.push(loopKey);
        } catch {
          logCode(writeLog, 'maintenance_watchdog_failed', 'alert_unavailable');
          // Undo the stamp so the next pass retries the alert.
          await repository.releaseClaim(loopKey, now).catch(() => {
            logCode(
              writeLog,
              'maintenance_watchdog_failed',
              'heartbeat_unavailable',
            );
          });
        }
      }
      return alerted;
    } finally {
      running = false;
    }
  }

  return {
    run,
    start() {
      const timer = schedule(() => {
        void run();
      }, maintenanceWatchdogIntervalMs);
      timer.unref?.();
      return { stop: () => timer.clear() };
    },
  };
}

export interface MaintenanceLoopHealth {
  readonly loopKey: MaintenanceLoopKey;
  readonly lastBeatAt: Date | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
}

/**
 * The E10-05 health view's projection. Like a never-run purge, a loop that
 * has never beaten shows as stale.
 */
export function maintenanceHeartbeatHealth(
  rows: readonly MaintenanceHeartbeatRow[],
  now: Date,
): readonly MaintenanceLoopHealth[] {
  return maintenanceLoopKeys.map((loopKey) => {
    const lastBeatAt =
      rows.find((row) => row.loop_key === loopKey)?.last_beat_at ?? null;
    if (lastBeatAt === null)
      return { loopKey, lastBeatAt, ageSeconds: null, stale: true };
    const state = maintenanceLoopState(loopKey, lastBeatAt, now, lastBeatAt);
    return {
      loopKey,
      lastBeatAt,
      ageSeconds: state.ageSeconds,
      stale: state.stale,
    };
  });
}
