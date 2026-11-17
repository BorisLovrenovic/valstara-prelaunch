import { stat, utimes, writeFile } from 'node:fs/promises';

/**
 * Each maintenance-worker loop's configured interval: the scheduler cycle
 * sleeps an hour between cycles, the email dispatch pass a minute. The loops
 * read their sleep from here and the watchdog its staleness threshold (twice
 * the interval), so the two cannot drift apart.
 */
export const maintenanceLoopIntervalMs = {
  scheduler_cycle: 60 * 60 * 1_000,
  email_dispatch: 60_000,
} as const;

/**
 * The file the maintenance worker touches after every completed pass, and
 * that the production health check reads (QA gate 7, G7-1-I2). It lives in
 * the container's own filesystem: it says only that this process is alive.
 */
export const maintenanceHeartbeatFile = '/tmp/valstara-maintenance.heartbeat';

/**
 * The health check fails once the file is older than twice the email dispatch
 * interval, the worker's shortest loop. Kept here, beside the file, so the
 * check loads nothing but `node:fs`.
 */
export const maintenanceHeartbeatFileMaxAgeMs =
  2 * maintenanceLoopIntervalMs.email_dispatch;

export async function touchHeartbeatFile(
  path: string,
  at: Date,
): Promise<void> {
  try {
    await utimes(path, at, at);
  } catch {
    await writeFile(path, '');
    await utimes(path, at, at);
  }
}

export async function heartbeatFileIsFresh(
  path: string,
  now: Date,
  maxAgeMs: number = maintenanceHeartbeatFileMaxAgeMs,
): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(path);
    return now.getTime() - mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}
