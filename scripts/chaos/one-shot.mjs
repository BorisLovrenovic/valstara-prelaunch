import { createPool } from '../../src/server/db/pool.ts';
import { createFlagService } from '../../src/server/flags/service.ts';

// Drills 2, 4 and 5 run through the maintenance container (QA gate 7,
// G7-1-I3); the one remaining one-shot action flips the leaderboard flag for
// drill 6.
const action = process.argv[2];
const clock = () => new Date(process.env.CHAOS_CLOCK);
if (Number.isNaN(clock().getTime())) throw new Error('Set CHAOS_CLOCK.');
const database = createPool(process.env.DATABASE_URL);

try {
  let result;
  switch (action) {
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
