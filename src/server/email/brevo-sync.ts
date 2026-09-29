import { setTimeout as systemSleep } from 'node:timers/promises';

import {
  createBrevoContactSyncRepository,
  maxBrevoSyncBatch,
} from '../db/brevo-contact-sync.ts';
import type { DatabasePool } from '../db/pool.ts';
import type { FlagService } from '../flags/types.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

import type { BrevoContactProvider } from './providers/brevo.ts';

export function createBrevoContactSyncJob(
  database: DatabasePool,
  flags: Pick<FlagService, 'isEnabled'>,
  provider: Pick<
    BrevoContactProvider,
    'upsertContact' | 'removeContact'
  > | null,
  clock: () => Date,
) {
  return {
    async run(limit: number): Promise<{ synced: number; paused: boolean }> {
      if (!Number.isInteger(limit) || limit < 1 || limit > maxBrevoSyncBatch)
        throw new RangeError('Brevo sync batch is out of range.');
      if (!(await flags.isEnabled('email.broadcast')))
        return { synced: 0, paused: true };
      if (provider === null) throw new Error('brevo_unconfigured');
      const repository = createBrevoContactSyncRepository(database);
      const candidates = await repository.candidates(limit);
      let synced = 0;
      for (const candidate of candidates) {
        if (candidate.eligible) {
          await provider.upsertContact(
            candidate.email_normalised,
            candidate.email,
          );
        } else {
          await provider.removeContact(candidate.email_normalised);
        }
        await repository.record(candidate, clock());
        synced += 1;
      }
      return { synced, paused: false };
    },
  };
}

export async function runBrevoContactSync(
  job: ReturnType<typeof createBrevoContactSyncJob>,
  alerts: AlertTransport,
  clock: () => Date,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, abort) =>
    systemSleep(ms, undefined, { signal: abort }),
): Promise<void> {
  while (!signal.aborted) {
    let delay = 10_000;
    try {
      await job.run(maxBrevoSyncBatch);
    } catch {
      delay = 60_000;
      try {
        await alerts.send({
          event: 'brevo_contact_sync_failed',
          detail: { code: 'contact_sync_unavailable' },
          occurredAt: clock(),
          severity: 'P2',
        });
      } catch {
        process.stderr.write(
          `${JSON.stringify({ event: 'brevo_sync_alert_failed', code: 'alert_unavailable' })}\n`,
        );
      }
    }
    try {
      await sleep(delay, signal);
    } catch {
      return;
    }
  }
}
