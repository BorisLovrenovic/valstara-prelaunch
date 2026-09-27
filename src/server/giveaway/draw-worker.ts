import { setTimeout as sleep } from 'node:timers/promises';

import type { AlertTransport } from '../verification-rate/p1-webhook.ts';
import type { DrawService } from './draw.ts';

const pollMilliseconds = 30_000;

export function createDrawWorker(
  draw: Pick<DrawService, 'advancePending'>,
  alerts: AlertTransport,
  clock: () => Date = () => new Date(),
  awards?: {
    initialize(): Promise<number>;
    expireDue(): Promise<{ responses: number; substitutions: number }>;
  },
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
      if (awards !== undefined) {
        try {
          await awards.initialize();
        } catch {
          await alerts.send({
            severity: 'P1',
            event: 'giveaway_award_initialization_failed',
            occurredAt: clock(),
            detail: { job: 'giveaway_award_initialization' },
          });
        }
        try {
          await awards.expireDue();
        } catch {
          await alerts.send({
            severity: 'P1',
            event: 'giveaway_award_expiry_failed',
            occurredAt: clock(),
            detail: { job: 'giveaway_award_expiry' },
          });
        }
      }
    },
    async run(signal?: AbortSignal): Promise<void> {
      while (!signal?.aborted) {
        await this.runCycle();
        if (signal?.aborted) break;
        try {
          await sleep(pollMilliseconds, undefined, { signal });
        } catch (error) {
          if (
            !signal?.aborted ||
            !(error instanceof Error) ||
            error.name !== 'AbortError'
          ) {
            throw error;
          }
        }
      }
    },
  };
}
