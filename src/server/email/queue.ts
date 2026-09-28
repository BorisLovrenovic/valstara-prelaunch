import type { DatabasePool } from '../db/pool.ts';
import { emailTokenSecret } from '../verification/token-derivation.ts';

import { createEmailService } from './service.ts';

export function createEmailQueue(database: DatabasePool, clock: () => Date) {
  const baseUrl = process.env.EMAIL_BASE_URL;
  if (baseUrl === undefined) throw new Error('EMAIL_BASE_URL is required.');
  return createEmailService(database, {
    clock,
    tokenSecret: emailTokenSecret(),
    baseUrl,
    providers: new Map(),
    renderers: new Map(),
    isBroadcastEnabled: async () => false,
    operatorTask: async () => {
      throw new Error('Email dispatch is not registered.');
    },
  });
}
