import { createHash } from 'node:crypto';

import { createPool } from '../../src/server/db/pool.ts';
import {
  createEmailService,
  maxDispatchBatch,
} from '../../src/server/email/service.ts';
import { createTransactionalTemplateData } from '../../src/server/email/transactional-template-data.ts';
import { createTransactionalRenderers } from '../../src/server/email/transactional-templates.ts';

const databaseUrl = process.env.DATABASE_URL;
const tokenSecret = process.env.EMAIL_TOKEN_SECRET;
const baseUrl = process.env.EMAIL_BASE_URL;
const sendingDomain = process.env.RESEND_SENDING_DOMAIN;
if (!databaseUrl || !tokenSecret || !baseUrl || !sendingDomain) {
  throw new Error(
    'Load sink requires the application database and email configuration.',
  );
}

const database = createPool(databaseUrl);
const renderer = createTransactionalRenderers({
  baseUrl,
  sendingDomain,
  data: createTransactionalTemplateData(database),
}).get('verification_test');
if (!renderer) throw new Error('Verification renderer is unavailable.');

const service = createEmailService(database, {
  clock: () => new Date(),
  tokenSecret,
  baseUrl,
  providers: new Map([
    [
      'resend',
      {
        id: 'resend',
        sendingDomain,
        capabilities: {
          broadcast: false,
          contactSync: false,
          dailyFreeCap: 100,
        },
        async send({ idempotencyKey }: { idempotencyKey: string }) {
          return {
            providerMessageId: `sink-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`,
          };
        },
      },
    ],
  ]),
  renderers: new Map([['verification_test', renderer]]),
  isBroadcastEnabled: async () => false,
  operatorTask: async () => {
    throw new Error('The load sink encountered a dispatch failure.');
  },
});

let sent = 0;
let batches = 0;
try {
  for (;;) {
    const result = await service.dispatch(maxDispatchBatch);
    if (
      result.failed ||
      result.retried ||
      result.unregistered ||
      result.suppressed
    ) {
      throw new Error(
        `Load sink dispatch did not complete cleanly: ${JSON.stringify(result)}`,
      );
    }
    sent += result.sent;
    if (result.scanned === 0) break;
    batches += 1;
  }
  process.stdout.write(`${JSON.stringify({ sent, batches })}\n`);
} finally {
  await database.close();
}
