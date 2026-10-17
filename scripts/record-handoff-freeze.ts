import { getDatabaseUrl } from '../src/server/config.ts';
import { createPool } from '../src/server/db/pool.ts';
import { recordHandoffFreeze } from '../src/server/subscriber/handoff-freeze.ts';

const actor = process.argv
  .find((arg) => arg.startsWith('--actor='))
  ?.slice('--actor='.length);
if (
  !actor?.trim() ||
  !process.argv.includes('--proxy-blocked-confirmed') ||
  !process.argv.includes('--maintenance-paused-confirmed')
)
  throw new Error(
    'Use --actor=<operator> --proxy-blocked-confirmed --maintenance-paused-confirmed after both controls are verified.',
  );

const database = createPool(getDatabaseUrl());
try {
  await recordHandoffFreeze(database, actor, 'operational');
  process.stdout.write('The operational full freeze was audited.\n');
} finally {
  await database.close();
}
