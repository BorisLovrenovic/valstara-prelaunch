import { setTimeout as wait } from 'node:timers/promises';

// Time is injected (epic rule 9). The fetcher reads the time and waits only
// through a Clock, so a test drives every delay and backoff with a fake one.

export interface Clock {
  now(): Date;
  /** Resolves after `milliseconds`, or rejects once `signal` aborts. */
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** The real clock, for the founder's run. Never used in a test path. */
export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (milliseconds, signal) => wait(milliseconds, undefined, { signal }),
};
