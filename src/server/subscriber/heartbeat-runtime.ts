import { getConfig, getP1AlertConfiguration } from '../config.ts';
import { createMaintenanceHeartbeatRepository } from '../db/maintenance-heartbeat.ts';
import { createPool } from '../db/pool.ts';
import { createAlertWebhookTransport } from '../verification-rate/p1-webhook.ts';

import { createMaintenanceHeartbeatWatchdog } from './heartbeat.ts';

let started = false;

/**
 * Starts the app process's maintenance-heartbeat watchdog once (QA gate 7,
 * G7-1-I2). The middleware calls this on every request, so the watchdog
 * starts with the first one; the image's own health check requests `/` every
 * five seconds. The watchdog's only output is the P1 webhook, so a process
 * without that configuration (a local test server) does not run it.
 */
export function ensureMaintenanceWatchdog(): void {
  if (started) return;
  started = true;
  let alerts;
  try {
    alerts = createAlertWebhookTransport(getP1AlertConfiguration());
  } catch {
    return;
  }
  createMaintenanceHeartbeatWatchdog(
    createMaintenanceHeartbeatRepository(createPool(getConfig().databaseUrl)),
    alerts,
    { clock: () => new Date() },
  ).start();
}
