import { createAuditService } from '../src/server/audit/service.ts';
import { getDatabaseUrl } from '../src/server/config.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import {
  createFinalReminderJob,
  finalReminderBatchSize,
} from '../src/server/subscriber/final-reminder.ts';

const actor = process.argv
  .find((arg) => arg.startsWith('--actor='))
  ?.slice('--actor='.length);
if (!actor?.trim()) throw new Error('A non-empty --actor is required.');
const database = createPool(getDatabaseUrl());
try {
  if (await createFlagService(database).isEnabled('signup.enabled'))
    throw new Error('Close signups before sending the final reminder.');
  const job = createFinalReminderJob(database, () => new Date());
  let afterId: string | null = null;
  let scanned = 0;
  let queued = 0;
  for (;;) {
    const batch = await job.run(afterId);
    scanned += batch.scanned;
    queued += batch.queued;
    afterId = batch.afterId;
    if (batch.scanned < finalReminderBatchSize) break;
  }
  await createAuditService(database).record({
    action: 'handoff.final_reminders_queued',
    actor,
    subjectType: 'handoff',
    subjectId: null,
    detail: { scanned, queued },
  });
  process.stdout.write(`${JSON.stringify({ scanned, queued })}\n`);
} finally {
  await database.close();
}
