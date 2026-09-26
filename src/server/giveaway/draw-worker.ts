import { setTimeout as sleep } from 'node:timers/promises';

import type { AlertTransport } from '../verification-rate/p1-webhook.ts';
import type { DrawService } from './draw.ts';

const pollMilliseconds = 30_000;

export function createDrawWorker(
  draw: Pick<DrawService, 'advancePending'>,
  alerts: AlertTransport,
  clock: () => Date = () => new Date(),
) {
  return {
    async runCycle(): Promise<void> {
      try {
        await draw.advancePending();
      } catch {
        await alerts.send({
          severity: 'P1',
          event: 'giveaway_draw_worker_failed',
          occurredAt: clock(),
          detail: { job: 'giveaway_draw' },
        });
      }
    },
    async run(): Promise<void> {
      while (true) {
        await this.runCycle();
        await sleep(pollMilliseconds);
      }
    },
  };
}
