import { getConfig, getP1AlertConfiguration } from '../../src/server/config.ts';
import { createPool } from '../../src/server/db/pool.ts';
import { createResendDispatcher } from '../../src/server/email/resend-dispatch.ts';
import { createFlagService } from '../../src/server/flags/service.ts';
import { createReferralCounterRepairJob } from '../../src/server/referral/counter-repair.ts';
import { createAlertWebhookTransport } from '../../src/server/verification-rate/p1-webhook.ts';

const action = process.argv[2];
const clock = () => new Date(process.env.CHAOS_CLOCK);
if (Number.isNaN(clock().getTime())) throw new Error('Set CHAOS_CLOCK.');
const database = createPool(process.env.DATABASE_URL);
const alerts = createAlertWebhookTransport(getP1AlertConfiguration());

try {
  let result;
  switch (action) {
    case 'dispatch': {
      const config = getConfig();
      result = await createResendDispatcher(
        database,
        config,
        alerts,
        clock,
      ).dispatch(100);
      break;
    }
    case 'repair':
      result = await createReferralCounterRepairJob(database, {
        alert: (alert) => alerts.send(alert),
        clock,
      }).run(100);
      break;
    case 'flag':
      await createFlagService(database).set(
        'leaderboard.public',
        process.argv[3] === 'on',
        'chaos-drill-operator',
      );
      // Host and local Compose containers share the kernel's monotonic clock.
      result = {
        enabled: process.argv[3] === 'on',
        changedAtMs: Number(process.hrtime.bigint()) / 1_000_000,
      };
      break;
    default:
      throw new Error(`Unknown chaos one-shot action: ${action}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await database.close();
}
